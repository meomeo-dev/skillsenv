import { dirname, join, resolve } from "node:path";

import { selectAgents } from "./agent-paths.mjs";
import { fail } from "./errors.mjs";
import {
  fileExists,
  pathExists,
  readYaml,
  sha256,
  sha256File,
  writeYaml,
  yamlText,
} from "./io.mjs";

const PLUGIN_ID = /^([A-Za-z0-9][-A-Za-z0-9._]*)@([A-Za-z0-9][-A-Za-z0-9._]*)$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GROUP_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MARKETPLACE_NAME = /^[A-Za-z0-9][-A-Za-z0-9._]*$/;

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

function normalizeDependency(dependency, ids, registry, label, scope, location) {
  if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)) {
    fail(`${label} ${location} must contain dependency objects`);
  }
  const parsed = parsePluginId(dependency.plugin);
  if (ids.has(parsed.id)) {
    fail(
      `${label} contains duplicate Plugin across dependencies and groups: ` +
        parsed.id,
    );
  }
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
}

function normalizeMarketplaces(value, label, scope) {
  if (value === undefined) return undefined;
  if (scope !== "project") {
    fail(`${label} marketplaces are only valid for project scope`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} marketplaces must be an object`);
  }
  const marketplaces = {};
  for (const [name, declaration] of Object.entries(value)) {
    if (!MARKETPLACE_NAME.test(name)) {
      fail(`${label} contains an invalid Marketplace name: ${name}`);
    }
    if (!declaration || typeof declaration !== "object" ||
        Array.isArray(declaration) || typeof declaration.source !== "string" ||
        declaration.source.trim() === "") {
      fail(`${label} Marketplace ${name} requires a non-empty source`);
    }
    marketplaces[name] = { source: declaration.source.trim() };
  }
  return marketplaces;
}

function normalizeDependencyGroups(value, ids, registry, label, scope) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} dependency_groups must be an object`);
  }
  const groups = {};
  for (const [name, dependencies] of Object.entries(value)) {
    if (!GROUP_NAME.test(name)) {
      fail(`${label} contains an invalid dependency group name: ${name}`);
    }
    if (!Array.isArray(dependencies) || dependencies.length === 0) {
      fail(`${label} dependency group ${name} must be a non-empty array`);
    }
    groups[name] = dependencies.map((dependency) =>
      normalizeDependency(
        dependency,
        ids,
        registry,
        label,
        scope,
        `dependency group ${name}`,
      ));
  }
  return groups;
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
  const marketplaces = normalizeMarketplaces(value.marketplaces, label, scope);
  const dependencies = value.dependencies.map((dependency) =>
    normalizeDependency(
      dependency,
      ids,
      registry,
      label,
      scope,
      "dependencies",
    ));
  const dependencyGroups = normalizeDependencyGroups(
    value.dependency_groups,
    ids,
    registry,
    label,
    scope,
  );
  return {
    schema_version: 1,
    ...(marketplaces && { marketplaces }),
    dependencies,
    ...(dependencyGroups && { dependency_groups: dependencyGroups }),
  };
}

export function manifestDependencies(manifest) {
  const result = manifest.dependencies.map((dependency) => ({
    dependency,
    dependencyGroup: null,
  }));
  for (const [dependencyGroup, dependencies] of Object.entries(
    manifest.dependency_groups ?? {},
  )) {
    for (const dependency of dependencies) {
      result.push({ dependency, dependencyGroup });
    }
  }
  return result;
}

export function selectDependencyGroups(manifest, options = {}) {
  const available = Object.keys(manifest.dependency_groups ?? {}).sort();
  if (options.all_groups && options.groups?.length) {
    fail("--group and --all-groups cannot be used together");
  }
  const selected = options.all_groups ? available : [...(options.groups ?? [])];
  for (const name of selected) {
    if (!available.includes(name)) fail(`Unknown dependency group: ${name}`);
  }
  return [...new Set(selected)].sort();
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
    // Must be a file: ~/.skillsenv is the user state directory.
    if (fileExists(manifest)) return { root: current, manifest };
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
  return { ...manifest, dependencies };
}

export function removeDependency(manifest, plugin) {
  const dependencies = manifest.dependencies.filter(
    (candidate) => candidate.plugin !== plugin,
  );
  if (dependencies.length === manifest.dependencies.length) {
    fail(`Plugin dependency is not installed: ${plugin}`);
  }
  return { ...manifest, dependencies };
}
