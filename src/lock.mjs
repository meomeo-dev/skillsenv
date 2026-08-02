import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";

import { fail } from "./errors.mjs";
import {
  assertRealPathWithin,
  pathExists,
  readYaml,
  sha256Directory,
  sha256File,
} from "./io.mjs";
import { manifestDependencies, parsePluginId } from "./manifest.mjs";
import { installedSkillPath } from "./resolver.mjs";

export function loadLock(path, manifest, paths) {
  if (!pathExists(path)) fail(`Skillsenv lock file not found: ${path}`);
  const value = readYaml(path, "Skillsenv lock file");
  if (value.schema_version !== 1 || !Array.isArray(value.dependencies) ||
      typeof value.manifest_sha256 !== "string") {
    fail("Skillsenv lock requires schema_version, manifest_sha256, and dependencies");
  }
  if (value.manifest_sha256 !== manifest.sha256) {
    fail("Skillsenv lock is stale; run skillsenv lock or skillsenv sync");
  }
  const pluginIds = new Set();
  const manifestByPlugin = new Map(
    manifestDependencies(manifest.value).map(({ dependency, dependencyGroup }) => [
      dependency.plugin,
      { dependency, dependencyGroup },
    ]),
  );
  if (value.dependencies.length !== manifestByPlugin.size) {
    fail("Lock dependencies do not match the manifest");
  }
  for (const dependency of value.dependencies) {
    validateDependency(
      dependency,
      pluginIds,
      paths,
      manifestByPlugin.get(dependency.plugin),
    );
  }
  return { path, value, sha256: sha256File(path) };
}

function sameSet(left, right) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index]);
}

function validateDependency(dependency, pluginIds, paths, manifestEntry) {
  if (!dependency || typeof dependency.plugin !== "string" ||
      !Array.isArray(dependency.agents) || !Array.isArray(dependency.skills)) {
    fail("Lock dependency requires plugin, agents, and skills");
  }
  if (pluginIds.has(dependency.plugin)) {
    fail(`Lock contains duplicate Plugin: ${dependency.plugin}`);
  }
  if (!manifestEntry) {
    fail(`Lock contains a Plugin absent from the manifest: ${dependency.plugin}`);
  }
  const { dependency: manifestDependency, dependencyGroup } = manifestEntry;
  if ((dependency.dependency_group ?? null) !== dependencyGroup) {
    fail(`Lock dependency group differs from manifest: ${dependency.plugin}`);
  }
  const parsed = parsePluginId(dependency.plugin);
  if (dependency.marketplace !== parsed.marketplace) {
    fail(`Lock Marketplace does not match Plugin ID: ${dependency.plugin}`);
  }
  if (!sameSet(dependency.agents, manifestDependency.agents)) {
    fail(`Lock Agent selection differs from manifest: ${dependency.plugin}`);
  }
  pluginIds.add(dependency.plugin);
  const skillNames = new Set();
  for (const skill of dependency.skills) {
    if (!skill || typeof skill.name !== "string" ||
        typeof skill.sha256 !== "string" ||
        (typeof skill.cache_path !== "string" &&
          typeof skill.local_path !== "string")) {
      fail(`Lock Plugin ${dependency.plugin} contains an invalid Skill record`);
    }
    if (skillNames.has(skill.name)) {
      fail(`Lock Plugin ${dependency.plugin} repeats Skill: ${skill.name}`);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) {
      fail(`Lock Plugin ${dependency.plugin} has an invalid Skill name`);
    }
    if (!/^[0-9a-f]{64}$/.test(skill.sha256)) {
      fail(`Locked Skill ${skill.name} has an invalid SHA-256`);
    }
    skillNames.add(skill.name);
    const hasCache = typeof skill.cache_path === "string";
    const hasLocal = typeof skill.local_path === "string";
    if (hasCache === hasLocal) {
      fail(`Locked Skill ${skill.name} requires exactly one installation path`);
    }
    if (hasLocal) {
      const marketSource = dependency.marketplace_source;
      if (marketSource?.type !== "local" ||
          typeof marketSource.path !== "string" ||
          !isAbsolute(skill.local_path)) {
        fail(`Locked local Skill ${skill.name} has no valid local Marketplace root`);
      }
      assertRealPathWithin(
        marketSource.path,
        skill.local_path,
        `Locked local Skill ${skill.name}`,
      );
    }
    const installed = installedSkillPath(paths, skill);
    if (!lstatSync(installed).isDirectory() ||
        sha256Directory(installed) !== skill.sha256) {
      fail(`Locked Skill cache failed content verification: ${skill.name}`);
    }
  }
  if (manifestDependency.skills &&
      !sameSet([...skillNames], manifestDependency.skills)) {
    fail(`Lock Skill selection differs from manifest: ${dependency.plugin}`);
  }
}
