import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { fail } from "./errors.mjs";
import {
  atomicWrite,
  makeTempDir,
  pathExists,
  readJson,
  realpathOrNull,
  replaceDirectory,
  runGit,
  safeRelative,
  sha256File,
} from "./io.mjs";
import { marketplaceCachePath } from "./config.mjs";

const MARKETPLACE_FILE = join(".claude-plugin", "marketplace.json");
const NAME_PATTERN = /^[A-Za-z0-9][-A-Za-z0-9._]*$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export function parseMarketplaceSource(input, cwd = process.cwd()) {
  if (typeof input !== "string" || input.trim() === "") {
    fail("Marketplace source is required");
  }
  const value = input.trim();
  const local = resolve(cwd, value);
  if (pathExists(local)) {
    const root = realpathOrNull(local);
    if (!root) fail(`Cannot resolve local Marketplace: ${value}`);
    return { type: "local", path: root };
  }
  const github = value.match(
    /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:@([^/].*))?$/,
  );
  if (github) {
    return { type: "github", repo: github[1], ...(github[2] && { ref: github[2] }) };
  }
  if (/^https?:\/\//.test(value) && /\.json(?:[?#]|$)/.test(value)) {
    return { type: "remote-json", url: value };
  }
  if (/^(?:https?:\/\/|ssh:\/\/|git@|file:\/\/)/.test(value)) {
    const hashAt = value.lastIndexOf("#");
    if (hashAt > value.indexOf(":") + 1) {
      return { type: "git", url: value.slice(0, hashAt), ref: value.slice(hashAt + 1) };
    }
    return { type: "git", url: value };
  }
  fail(`Unsupported Marketplace source: ${value}`);
}

function validateOwner(owner, label) {
  if (!owner || typeof owner !== "object" || Array.isArray(owner) ||
      typeof owner.name !== "string" || owner.name.trim() === "") {
    fail(`${label} requires owner.name`);
  }
}

function validateSourceObject(source, label) {
  const type = source?.source;
  if (type === "github") {
    if (typeof source.repo !== "string" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repo)) {
      fail(`${label} github source requires repo in owner/repo form`);
    }
  } else if (type === "url") {
    if (typeof source.url !== "string" ||
        !/^(?:https?:\/\/|ssh:\/\/|git@|file:\/\/)/.test(source.url)) {
      fail(`${label} url source requires a Git URL`);
    }
  } else if (type === "git-subdir") {
    if (typeof source.url !== "string" || typeof source.path !== "string" ||
        source.path.trim() === "") {
      fail(`${label} git-subdir source requires url and path`);
    }
  } else if (type === "npm") {
    if (typeof source.package !== "string" || source.package.trim() === "") {
      fail(`${label} npm source requires package`);
    }
    if (source.ref || source.sha) fail(`${label} npm source cannot use ref or sha`);
    return;
  } else {
    fail(`${label} uses an unknown Plugin source type: ${type}`);
  }
  if (source.sha !== undefined && !SHA_PATTERN.test(source.sha)) {
    fail(`${label} sha must be a full 40-character lowercase Git commit`);
  }
  if (source.ref !== undefined &&
      (typeof source.ref !== "string" || source.ref.trim() === "")) {
    fail(`${label} ref must be a non-empty string`);
  }
}

export function validateMarketplace(manifest, label = "Marketplace") {
  if (!NAME_PATTERN.test(manifest?.name ?? "")) {
    fail(`${label} requires a valid name`);
  }
  validateOwner(manifest.owner, label);
  if (!Array.isArray(manifest.plugins)) fail(`${label} requires plugins[]`);

  const names = new Set();
  for (const plugin of manifest.plugins) {
    if (!NAME_PATTERN.test(plugin?.name ?? "")) {
      fail(`${label} contains a Plugin with an invalid name`);
    }
    if (names.has(plugin.name)) fail(`${label} has duplicate Plugin: ${plugin.name}`);
    names.add(plugin.name);
    if (typeof plugin.source === "string") {
      const pluginRoot = manifest.metadata?.pluginRoot;
      const allowsBare = typeof pluginRoot === "string";
      if (!allowsBare && plugin.source !== "." && !plugin.source.startsWith("./")) {
        fail(`${label} Plugin ${plugin.name} relative source must start with ./`);
      }
      safeRelative("/marketplace", plugin.source, `Plugin ${plugin.name} source`, {
        allowBare: allowsBare,
      });
    } else if (plugin.source && typeof plugin.source === "object") {
      validateSourceObject(plugin.source, `${label} Plugin ${plugin.name}`);
    } else {
      fail(`${label} Plugin ${plugin.name} requires source`);
    }
  }
  if (manifest.metadata?.pluginRoot !== undefined) {
    safeRelative(
      "/marketplace",
      manifest.metadata.pluginRoot,
      `${label} metadata.pluginRoot`,
    );
  }
  return manifest;
}

export function readMarketplace(root) {
  const path = join(root, MARKETPLACE_FILE);
  if (!pathExists(path)) fail(`Marketplace file not found: ${path}`);
  return {
    root,
    path,
    manifest: validateMarketplace(readJson(path, "Marketplace manifest"), path),
    sha256: sha256File(path),
  };
}

function gitUrl(source) {
  return source.type === "github"
    ? `https://github.com/${source.repo}.git`
    : source.url;
}

function cloneMarketplace(source, destination, env) {
  const args = ["clone", "--depth", "1"];
  if (source.ref) args.push("--branch", source.ref);
  args.push(gitUrl(source), destination);
  runGit(args, { env });
  return runGit(["-C", destination, "rev-parse", "HEAD"], { env });
}

async function downloadMarketplaceJson(source, destination) {
  let response;
  try {
    response = await fetch(source.url, { redirect: "follow" });
  } catch (error) {
    fail(`Cannot download Marketplace JSON: ${error.message}`);
  }
  if (!response.ok) fail(`Marketplace download failed with HTTP ${response.status}`);
  const body = await response.text();
  const path = join(destination, MARKETPLACE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, body);
  return sha256File(path);
}

export async function materializeMarketplace(
  source,
  paths,
  expectedName,
  options = {},
) {
  if (source.type === "local") {
    const marketplace = readMarketplace(source.path);
    if (expectedName && marketplace.manifest.name !== expectedName) {
      fail(`Marketplace changed name: ${expectedName} -> ${marketplace.manifest.name}`);
    }
    return {
      ...marketplace,
      source,
      revision: gitRevision(source.path) ?? marketplace.sha256,
      gitRevision: gitRevision(source.path),
      cached: false,
    };
  }

  const temporary = makeTempDir("skillsenv-market-");
  const staged = join(temporary, "marketplace");
  let revision;
  try {
    if (source.type === "remote-json") {
      mkdirSync(staged, { recursive: true });
      revision = await downloadMarketplaceJson(source, staged);
    } else {
      revision = cloneMarketplace(source, staged, options.env);
    }
    const marketplace = readMarketplace(staged);
    const name = marketplace.manifest.name;
    if (expectedName && name !== expectedName) {
      fail(`Marketplace changed name: ${expectedName} -> ${name}`);
    }
    const destination = marketplaceCachePath(paths, name);
    replaceDirectory(staged, destination);
    return {
      ...readMarketplace(destination),
      source,
      revision,
      gitRevision: source.type === "remote-json" ? null : revision,
      cached: true,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function gitRevision(path) {
  try {
    return runGit(["-C", path, "rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

export function registeredMarketplace(name, registration, paths) {
  const root = registration.source.type === "local"
    ? registration.source.path
    : marketplaceCachePath(paths, name);
  const marketplace = readMarketplace(root);
  if (marketplace.manifest.name !== name) {
    fail(`Registered Marketplace ${name} now declares ${marketplace.manifest.name}`);
  }
  const revision = registration.source.type === "local"
    ? gitRevision(root) ?? marketplace.sha256
    : registration.revision;
  if (marketplace.sha256 !== registration.manifest_sha256 ||
      revision !== registration.revision) {
    fail(`Marketplace ${name} changed; run skillsenv marketplace update ${name}`);
  }
  return { ...marketplace, registration };
}

export function marketplaceRegistration(materialized) {
  return {
    source: materialized.source,
    revision: materialized.revision,
    git_revision: materialized.gitRevision,
    manifest_sha256: materialized.sha256,
  };
}
