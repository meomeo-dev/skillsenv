import { rmSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { fail } from "./errors.mjs";
import {
  copyDirectorySafe,
  makeTempDir,
  pathExists,
  replaceDirectory,
  safeRelative,
  sha256,
  sha256Directory,
  writeYaml,
} from "./io.mjs";
import { parsePluginId } from "./manifest.mjs";
import { registeredMarketplace } from "./marketplace.mjs";
import { materializePlugin, normalizedPluginSource } from "./plugin-source.mjs";
import {
  discoverPluginSkills,
  resolvedPluginVersion,
} from "./skill-discovery.mjs";

function findPlugin(marketplace, name) {
  const plugin = marketplace.manifest.plugins.find((entry) => entry.name === name);
  if (!plugin) {
    fail(`Plugin ${name} is not present in Marketplace ${marketplace.manifest.name}`);
  }
  return plugin;
}

function selectSkills(allSkills, requested, pluginId) {
  if (!requested) return allSkills;
  const byName = new Map(allSkills.map((skill) => [skill.name, skill]));
  return requested.map((name) => {
    const skill = byName.get(name);
    if (!skill) fail(`Plugin ${pluginId} does not expose selected Skill: ${name}`);
    return skill;
  });
}

function cacheRelativePath(marketplace, plugin, cacheKey, skill) {
  return [marketplace, plugin, cacheKey, "skills", skill].join("/");
}

function buildCache(paths, identity, skills, persist) {
  const cacheKey = sha256(JSON.stringify({
    marketplace_revision: identity.marketplaceRevision,
    plugin_source: identity.pluginSource,
    plugin_revision: identity.pluginRevision,
    skills: skills.map(({ name, sha256: digest }) => [name, digest]),
  })).slice(0, 24);
  const cacheRoot = join(
    paths.pluginCache,
    identity.marketplace,
    identity.plugin,
    cacheKey,
  );
  if (persist && !pathExists(cacheRoot)) {
    const temporary = makeTempDir("skillsenv-cache-");
    const staged = join(temporary, "cache");
    try {
      for (const skill of skills) {
        copyDirectorySafe(skill.source, join(staged, "skills", skill.name));
      }
      replaceDirectory(staged, cacheRoot);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  if (persist) {
    for (const skill of skills) {
      const cached = join(cacheRoot, "skills", skill.name);
      if (!pathExists(cached) || sha256Directory(cached) !== skill.sha256) {
        fail(`Cached Skill content does not match its lock candidate: ${skill.name}`);
      }
    }
  }
  return { cacheKey, cacheRoot };
}

function resolveDependency(dependency, config, paths, options) {
  const parsed = parsePluginId(dependency.plugin);
  const registration = config.marketplaces[parsed.marketplace];
  if (!registration) fail(`Marketplace is not registered: ${parsed.marketplace}`);
  const marketplace = registeredMarketplace(parsed.marketplace, registration, paths);
  const entry = findPlugin(marketplace, parsed.plugin);
  const materialized = materializePlugin(entry, marketplace, options);
  try {
    const discovery = discoverPluginSkills(entry, materialized.root);
    const selected = selectSkills(discovery.skills, dependency.skills, parsed.id);
    const pluginSource = normalizedPluginSource(entry.source);
    const identity = {
      marketplace: parsed.marketplace,
      marketplaceRevision: registration.revision,
      plugin: parsed.plugin,
      pluginSource,
      pluginRevision: materialized.revision,
    };
    const cache = materialized.directLocal
      ? null
      : buildCache(paths, identity, selected, options.persistCache);
    return {
      plugin: parsed.id,
      marketplace: parsed.marketplace,
      marketplace_source: registration.source,
      marketplace_revision: registration.revision,
      plugin_source: pluginSource,
      plugin_revision: materialized.revision,
      version: resolvedPluginVersion(
        entry,
        discovery.manifest,
        materialized.gitRevision,
      ),
      ...(cache && { cache_key: cache.cacheKey }),
      agents: dependency.agents,
      skills: selected.map((skill) => ({
        name: skill.name,
        path: relative(materialized.root, skill.source).split(sep).join("/") || ".",
        sha256: skill.sha256,
        ...(materialized.directLocal
          ? { local_path: skill.source }
          : {
              cache_path: cacheRelativePath(
                parsed.marketplace,
                parsed.plugin,
                cache.cacheKey,
                skill.name,
              ),
            }),
      })),
    };
  } finally {
    materialized.cleanup();
  }
}

export function resolveLock(manifest, config, paths, options = {}) {
  const resolvedOptions = {
    persistCache: options.persistCache !== false,
    env: options.env ?? process.env,
  };
  const dependencies = manifest.value.dependencies.map((dependency) =>
    resolveDependency(dependency, config, paths, resolvedOptions),
  );
  return {
    schema_version: 1,
    manifest_sha256: manifest.sha256,
    dependencies,
  };
}

export function writeLock(path, lock) {
  writeYaml(path, lock);
}

export function cachedSkillPath(paths, cachePath, options = {}) {
  const candidate = safeRelative(paths.pluginCache, cachePath, "Lock cache_path", {
    allowBare: true,
  });
  if (options.mustExist !== false && !pathExists(candidate)) {
    fail(`Locked Skill is not cached: ${cachePath}`);
  }
  return candidate;
}

export function installedSkillPath(paths, skill, options = {}) {
  if (typeof skill.local_path === "string") {
    if (!pathExists(skill.local_path)) {
      fail(`Locked local Skill is unavailable: ${skill.local_path}`);
    }
    return skill.local_path;
  }
  if (typeof skill.cache_path !== "string") {
    fail(`Locked Skill ${skill.name} has no installation path`);
  }
  return cachedSkillPath(paths, skill.cache_path, options);
}
