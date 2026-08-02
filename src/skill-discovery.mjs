import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import yaml from "js-yaml";

import { fail } from "./errors.mjs";
import {
  assertRealPathWithin,
  pathExists,
  readJson,
  safeRelative,
  sha256Directory,
} from "./io.mjs";

const PLUGIN_MANIFEST = join(".claude-plugin", "plugin.json");
const COMPONENT_FIELDS = [
  "commands",
  "agents",
  "hooks",
  "mcpServers",
  "lspServers",
  "monitors",
  "settings",
  "userConfig",
  "outputStyles",
  "themes",
  "channels",
  "dependencies",
];
const COMPONENT_FILES = [
  ["commands", (name) => name.endsWith(".md")],
  ["agents", (name) => name.endsWith(".md")],
  ["hooks", (name) => name === "hooks.json"],
  ["monitors", (name) => name === "monitors.json"],
  ["output-styles", () => true],
  ["themes", () => true],
  ["channels", () => true],
];
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function nonEmpty(value) {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function loadPluginManifest(root) {
  const path = join(root, PLUGIN_MANIFEST);
  return pathExists(path) ? readJson(path, "Plugin manifest") : null;
}

function declaredComponents(source, label) {
  const found = [];
  if (!source) return found;
  for (const field of COMPONENT_FIELDS) {
    if (nonEmpty(source[field])) found.push(`${label}.${field}`);
  }
  if (nonEmpty(source.experimental?.monitors)) {
    found.push(`${label}.experimental.monitors`);
  }
  return found;
}

function implicitComponents(root) {
  const found = [];
  for (const [directory, accepts] of COMPONENT_FILES) {
    const path = join(root, directory);
    if (!pathExists(path) || !lstatSync(path).isDirectory()) continue;
    if (readdirSync(path).some(accepts)) found.push(`${directory}/`);
  }
  for (const file of [".mcp.json", ".lsp.json"] ) {
    if (pathExists(join(root, file))) found.push(file);
  }
  return found;
}

function componentDeclarations(entry, manifest, strict) {
  const entryFields = declaredComponents(entry, "marketplace entry");
  const manifestFields = declaredComponents(manifest, "plugin.json");
  const manifestSkillField = !strict && nonEmpty(manifest?.skills)
    ? ["plugin.json.skills"]
    : [];
  const conflictingManifestFields = [...manifestFields, ...manifestSkillField];
  if (!strict && conflictingManifestFields.length > 0) {
    fail(
      `Plugin ${entry.name} uses strict: false but plugin.json also declares ` +
        `components: ${conflictingManifestFields.join(", ")}`,
    );
  }
  return [...entryFields, ...(strict ? manifestFields : [])];
}

function parseFrontmatter(path) {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return {};
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) fail(`Skill has unterminated frontmatter: ${path}`);
  let value;
  try {
    value = yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) ?? {};
  } catch (error) {
    fail(`Invalid Skill frontmatter at ${path}: ${error.message}`);
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    fail(`Skill frontmatter must be an object: ${path}`);
  }
  return value;
}

function skillAt(root, directory) {
  const skillFile = join(directory, "SKILL.md");
  if (!pathExists(skillFile)) return null;
  const realDirectory = assertRealPathWithin(root, directory, "Skill path");
  const frontmatter = parseFrontmatter(join(realDirectory, "SKILL.md"));
  const name = frontmatter.name ?? basename(realDirectory);
  if (!SKILL_NAME.test(name)) fail(`Invalid Skill name ${name} at ${skillFile}`);
  return {
    name,
    source: realDirectory,
    sha256: sha256Directory(realDirectory),
  };
}

function skillsAtPath(root, path, label) {
  const candidate = safeRelative(root, path, label);
  if (!pathExists(candidate)) fail(`${label} does not exist: ${path}`);
  if (!lstatSync(candidate).isDirectory()) fail(`${label} must be a directory: ${path}`);
  const direct = skillAt(root, candidate);
  if (direct) return [direct];

  const skills = [];
  for (const name of readdirSync(candidate).sort()) {
    const directory = join(candidate, name);
    if (!lstatSync(directory).isDirectory()) continue;
    const skill = skillAt(root, directory);
    if (skill) skills.push(skill);
  }
  if (skills.length === 0) fail(`${label} contains no Skill directories: ${path}`);
  return skills;
}

function stringArray(value, label) {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item !== "string" || item.trim() === "")) {
    fail(`${label} must contain non-empty relative paths`);
  }
  return values;
}

function discoverDeclared(root, paths, label) {
  return paths.flatMap((path) => skillsAtPath(root, path, label));
}

function deduplicateSkills(skills, pluginName) {
  const byName = new Map();
  for (const skill of skills) {
    const existing = byName.get(skill.name);
    if (existing && existing.source !== skill.source) {
      fail(`Plugin ${pluginName} exposes duplicate Skill name: ${skill.name}`);
    }
    byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function discoverPluginSkills(entry, root) {
  const strict = entry.strict !== false;
  const manifest = loadPluginManifest(root);
  if (strict && !manifest) {
    fail(`Plugin ${entry.name} uses strict mode but has no .claude-plugin/plugin.json`);
  }
  if (manifest?.name && manifest.name !== entry.name) {
    fail(`Plugin manifest name ${manifest.name} does not match ${entry.name}`);
  }

  const declaredNonSkills = componentDeclarations(entry, manifest, strict);
  const implicitNonSkills = implicitComponents(root);
  const unsupported = [...new Set([...declaredNonSkills, ...implicitNonSkills])];
  if (unsupported.length > 0) {
    fail(
      `Plugin ${entry.name} is not Skill-only; unsupported components: ` +
        unsupported.join(", "),
    );
  }

  const entryPaths = stringArray(entry.skills, `Plugin ${entry.name} skills`);
  const manifestPaths = strict
    ? stringArray(manifest?.skills, `Plugin ${entry.name} plugin.json skills`)
    : [];
  const declared = [
    ...discoverDeclared(root, manifestPaths, "plugin.json skills path"),
    ...discoverDeclared(root, entryPaths, "Marketplace skills path"),
  ];
  const marketplaceRootEntry = entry.source === "." || entry.source === "./";
  const useDefaultScan = !(marketplaceRootEntry && entryPaths.length > 0);
  const defaultDirectory = join(root, "skills");
  const defaults = useDefaultScan && pathExists(defaultDirectory)
    ? skillsAtPath(root, "./skills", "Default skills directory")
    : [];
  const hasSkillsDeclaration = entryPaths.length > 0 || manifestPaths.length > 0;
  const rootFallback = defaults.length === 0 && !hasSkillsDeclaration
    ? skillAt(root, root)
    : null;
  const skills = deduplicateSkills(
    [...defaults, ...declared, ...(rootFallback ? [rootFallback] : [])],
    entry.name,
  );
  if (skills.length === 0) fail(`Plugin ${entry.name} exposes no valid Skills`);
  return { strict, manifest, skills };
}

export function resolvedPluginVersion(entry, manifest, gitRevision) {
  return manifest?.version ?? entry.version ?? gitRevision ?? "unknown";
}
