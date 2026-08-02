import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { fail } from "./errors.mjs";
import {
  assertRealPathWithin,
  cleanGitEnv,
  makeTempDir,
  pathExists,
  readJson,
  run,
  runGit,
  safeRelative,
} from "./io.mjs";

function cloneGit(source, destination, env) {
  const url = source.source === "github"
    ? `https://github.com/${source.repo}.git`
    : source.url;
  if (source.sha) {
    runGit(["clone", "--filter=blob:none", "--no-checkout", url, destination], {
      env,
    });
    runGit(
      ["-C", destination, "fetch", "--depth", "1", "origin", source.sha],
      { env },
    );
    runGit(["-C", destination, "checkout", "--detach", source.sha], { env });
  } else {
    const args = ["clone", "--depth", "1"];
    if (source.ref) args.push("--branch", source.ref);
    args.push(url, destination);
    runGit(args, { env });
  }
  return runGit(["-C", destination, "rev-parse", "HEAD"], { env });
}

function resolveRelativeSource(entry, marketplace) {
  const pluginRoot = marketplace.manifest.metadata?.pluginRoot;
  const base = pluginRoot
    ? safeRelative(marketplace.root, pluginRoot, "metadata.pluginRoot")
    : marketplace.root;
  const candidate = safeRelative(base, entry.source, `Plugin ${entry.name} source`, {
    allowBare: Boolean(pluginRoot),
  });
  if (!pathExists(candidate)) fail(`Plugin source does not exist: ${candidate}`);
  const root = assertRealPathWithin(marketplace.root, candidate, "Plugin source");
  return {
    root,
    revision: marketplace.registration?.revision ?? marketplace.sha256,
    gitRevision: marketplace.registration?.git_revision ?? null,
    directLocal: marketplace.registration?.source.type === "local",
    cleanup() {},
  };
}

function npmPackagePath(installRoot, packageName) {
  const parts = packageName.startsWith("@") ? packageName.split("/") : [packageName];
  return join(installRoot, "node_modules", ...parts);
}

function resolveNpmSource(source, env) {
  const temporary = makeTempDir("skillsenv-npm-");
  const installRoot = join(temporary, "install");
  mkdirSync(installRoot, { recursive: true });
  const spec = source.version ? `${source.package}@${source.version}` : source.package;
  const args = [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--loglevel=error",
    "--prefix",
    installRoot,
    spec,
  ];
  if (source.registry) args.splice(args.length - 1, 0, "--registry", source.registry);
  run("npm", args, {
    env: { ...cleanGitEnv(env), npm_config_ignore_scripts: "true" },
  });
  const root = npmPackagePath(installRoot, source.package);
  if (!pathExists(root)) fail(`npm did not install Plugin package: ${source.package}`);
  const packageJson = join(root, "package.json");
  const packageVersion = pathExists(packageJson)
    ? readJson(packageJson, "npm package manifest").version
    : undefined;
  return {
    root,
    revision: packageVersion ?? source.version ?? "unknown",
    gitRevision: null,
    directLocal: false,
    cleanup: () => rmSync(temporary, { recursive: true, force: true }),
  };
}

export function materializePlugin(entry, marketplace, options = {}) {
  if (typeof entry.source === "string") {
    if (marketplace.registration?.source.type === "remote-json") {
      fail(`Plugin ${entry.name} uses a relative source in a URL-only Marketplace`);
    }
    return resolveRelativeSource(entry, marketplace);
  }
  if (entry.source.source === "npm") {
    return resolveNpmSource(entry.source, options.env);
  }

  const temporary = makeTempDir("skillsenv-plugin-");
  const repository = join(temporary, "repository");
  try {
    const revision = cloneGit(entry.source, repository, options.env);
    const candidate = entry.source.source === "git-subdir"
      ? safeRelative(repository, entry.source.path, "git-subdir path", {
          allowBare: true,
        })
      : repository;
    if (!pathExists(candidate)) fail(`Plugin subdirectory does not exist: ${candidate}`);
    const root = assertRealPathWithin(repository, candidate, "Plugin source");
    return {
      root,
      revision,
      gitRevision: revision,
      directLocal: false,
      cleanup: () => rmSync(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function normalizedPluginSource(source) {
  if (typeof source === "string") return source;
  const normalized = { source: source.source };
  for (const key of ["repo", "url", "path", "ref", "sha", "package", "version",
    "registry"]) {
    if (source[key] !== undefined) normalized[key] = source[key];
  }
  return normalized;
}
