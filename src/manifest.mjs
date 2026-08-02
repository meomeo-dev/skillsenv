import { dirname, join, resolve } from "node:path";

import { selectAgents } from "./agent-paths.mjs";
import { fail } from "./errors.mjs";
import {
  pathExists,
  readYaml,
  sha256,
  sha256File,
  writeYaml,
  yamlText,
} from "./io.mjs";

const PLUGIN_ID = /^([A-Za-z0-9][-A-Za-z0-9._]*)@([A-Za-z0-9][-A-Za-z0-9._]*)$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parsePluginId(value) {
  const match = typeof value === "string" ? value.match(PLUGIN_ID) : null;
  if (!match) fail(`Plugin must use plugin-name@marketplace-name: ${value}`);
  return { plugin: match[1], marketplace: match[2], id: value };
}

function normalizeStringList(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be non-empty`);
  const result = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      fail(`${label} must contain non-empty strings`);
    }
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

export function validateManifest(
  value,
  registry,
  label = "Skillsenv manifest",
  scope = "project",
) {
  if (value.schema_version !== 1 || !Array.isArray(value.dependencies)) {
    fail(`${label} requires schema_version: 1 and dependencies[]`);
  }
  const ids = new Set();
  const dependencies = value.dependencies.map((dependency) => {
    if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)) {
      fail(`${label} dependencies must be objects`);
    }
    const parsed = parsePluginId(dependency.plugin);
    if (ids.has(parsed.id)) fail(`${label} contains duplicate Plugin: ${parsed.id}`);
    ids.add(parsed.id);
    const requestedAgents = normalizeStringList(
      dependency.agents,
      `${parsed.id} agents`,
    );
    const agents = selectAgents(requestedAgents, scope, registry);
    let skills;
    if (dependency.skills !== undefined) {
      skills = normalizeStringList(dependency.skills, `${parsed.id} skills`);
      for (const name of skills) {
        if (!SKILL_NAME.test(name)) fail(`${parsed.id} has invalid Skill name: ${name}`);
      }
    }
    return { plugin: parsed.id, agents, ...(skills && { skills }) };
  });
  return { schema_version: 1, dependencies };
}

export function loadManifest(path, registry, scope = "project") {
  if (!pathExists(path)) fail(`Skillsenv manifest not found: ${path}`);
  return {
    path,
    root: dirname(path),
    value: validateManifest(
      readYaml(path, "Skillsenv manifest"),
      registry,
      path,
      scope,
    ),
    sha256: sha256File(path),
  };
}

export function proposedManifest(path, value, registry, scope = "project") {
  const normalized = validateManifest(value, registry, path, scope);
  return {
    path,
    root: dirname(path),
    value: normalized,
    sha256: sha256(yamlText(normalized)),
  };
}

export function saveManifest(path, value) {
  writeYaml(path, value);
}

export function findProject(start = process.cwd()) {
  let current = resolve(start);
  while (true) {
    const manifest = join(current, ".skillsenv");
    if (pathExists(manifest)) return { root: current, manifest };
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function createManifest(path) {
  if (pathExists(path)) fail(`Skillsenv manifest already exists: ${path}`);
  writeYaml(path, { schema_version: 1, dependencies: [] });
}

export function upsertDependency(manifest, dependency) {
  const dependencies = manifest.dependencies.filter(
    (candidate) => candidate.plugin !== dependency.plugin,
  );
  dependencies.push(dependency);
  dependencies.sort((left, right) => left.plugin.localeCompare(right.plugin));
  return { schema_version: 1, dependencies };
}

export function removeDependency(manifest, plugin) {
  const dependencies = manifest.dependencies.filter(
    (candidate) => candidate.plugin !== plugin,
  );
  if (dependencies.length === manifest.dependencies.length) {
    fail(`Plugin dependency is not installed: ${plugin}`);
  }
  return { schema_version: 1, dependencies };
}
