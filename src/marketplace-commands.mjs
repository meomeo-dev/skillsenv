import { rmSync } from "node:fs";
import { join } from "node:path";

import { scopeOption } from "./cli-options.mjs";
import { loadEnvironment, qualifiedPluginId } from "./command-context.mjs";
import {
  deleteMarketplaceCache,
  loadConfig,
  removeMarketplace,
  saveConfig,
  setMarketplace,
} from "./config.mjs";
import { fail } from "./errors.mjs";
import { makeTempDir } from "./io.mjs";
import { findProject, parsePluginId } from "./manifest.mjs";
import {
  marketplaceRegistration,
  materializeMarketplace,
  parseMarketplaceSource,
  registeredMarketplace,
} from "./marketplace.mjs";
import { materializePlugin, normalizedPluginSource } from "./plugin-source.mjs";
import {
  discoverPluginSkills,
  resolvedPluginVersion,
} from "./skill-discovery.mjs";

// --offline is a hard boundary, never a "prefer offline" downgrade (CFI-008).
function assertOnlineSource(options, source, label) {
  if (options.offline !== true) return;
  if (source.type === "local") return;
  fail(
    `${label} needs network access for a ${source.type} source but --offline is set; ` +
      "drop --offline or use a local Marketplace",
  );
}

function temporaryPaths(context) {
  const root = makeTempDir("skillsenv-preview-");
  return {
    root,
    paths: {
      ...context.paths,
      marketplaceCache: join(root, "marketplaces"),
      pluginCache: join(root, "plugins"),
      backups: join(root, "backups"),
    },
  };
}

async function add({ context, options, positional }) {
  const input = positional[0];
  const source = parseMarketplaceSource(input, context.cwd);
  assertOnlineSource(options, source, "marketplace add");
  const preview = options.dry_run ? temporaryPaths(context) : null;
  try {
    const materialized = await materializeMarketplace(
      source,
      preview?.paths ?? context.paths,
      undefined,
      { env: context.env, offline: options.offline === true },
    );
    context.write(
      `${options.dry_run ? "DRY-RUN " : ""}MARKETPLACE ` +
        `${materialized.manifest.name} revision=${materialized.revision}`,
    );
    if (!options.dry_run) {
      const config = setMarketplace(
        loadConfig(context.paths.config),
        materialized.manifest.name,
        marketplaceRegistration(materialized),
      );
      saveConfig(context.paths.config, config);
    }
    return {
      kind: "marketplace-add",
      name: materialized.manifest.name,
      data: {
        kind: "marketplace-add",
        name: materialized.manifest.name,
        revision: materialized.revision,
        dry_run: options.dry_run === true,
      },
    };
  } finally {
    if (preview) rmSync(preview.root, { recursive: true, force: true });
  }
}

function list({ context }) {
  const config = loadConfig(context.paths.config);
  context.write("DEFAULT\tNAME\tSOURCE\tREVISION");
  const entries = Object.entries(config.marketplaces).sort();
  for (const [name, registration] of entries) {
    context.write(
      `${config.default_marketplace === name ? "*" : ""}\t${name}\t` +
        `${JSON.stringify(registration.source)}\t${registration.revision}`,
    );
  }
  return {
    kind: "marketplace-list",
    count: entries.length,
    data: {
      kind: "marketplace-list",
      default_marketplace: config.default_marketplace ?? null,
      marketplaces: entries.map(([name, registration]) => ({
        name,
        source: registration.source,
        revision: registration.revision,
        default: config.default_marketplace === name,
      })),
    },
  };
}

function unregisteredMessage(name) {
  return `Marketplace is not registered: ${name}; ` +
    "run skillsenv marketplace list to see registered names";
}

function requireRegistration(context, name) {
  const config = loadConfig(context.paths.config);
  const registration = config.marketplaces[name];
  if (!registration) fail(unregisteredMessage(name));
  return { config, registration };
}

// Reading a Marketplace must not clone by surprise, so a Plugin whose source is
// an object (github, git-subdir, npm) stays unresolved unless --online is given.
// A local source costs a path resolve, so it is always read: that is what lets
// the version column agree with what `add` would lock, since plugin.json wins
// over the Marketplace entry (resolvedPluginVersion).
// A per-Plugin failure degrades that one row instead of aborting the listing —
// one malformed Plugin should not hide the others.
function pluginDetail(entry, marketplace, options, context) {
  if (typeof entry.source !== "string" && options.online !== true) {
    return {
      version: entry.version ?? null,
      skills: null,
      error:
        `${entry.source?.source ?? "remote"} Plugin source needs --online to ` +
        "resolve Skills",
    };
  }
  let materialized = null;
  try {
    materialized = materializePlugin(entry, marketplace, { env: context.env });
    const discovered = discoverPluginSkills(entry, materialized.root);
    return {
      version: resolvedPluginVersion(
        entry,
        discovered.manifest,
        materialized.gitRevision,
      ),
      skills: discovered.skills.map((skill) => skill.name),
      error: null,
    };
  } catch (error) {
    return { version: entry.version ?? null, skills: null, error: error.message };
  } finally {
    materialized?.cleanup();
  }
}

function show({ context, options, positional }) {
  const name = positional[0];
  const { config, registration } = requireRegistration(context, name);
  const marketplace = registeredMarketplace(name, registration, context.paths);
  const expand = options.expand_skills === true;
  const plugins = [...marketplace.manifest.plugins]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const detail = pluginDetail(entry, marketplace, options, context);
      return {
        name: entry.name,
        version: detail.version,
        description: entry.description ?? null,
        source: normalizedPluginSource(entry.source),
        // Only --skills promises a Skill roster; a bare listing stays lean, and
        // an absent key cannot be mistaken for "resolved to nothing".
        ...(expand
          ? {
              skills: detail.skills,
              ...(detail.error ? { skills_error: detail.error } : {}),
            }
          : {}),
      };
    });
  context.write("PLUGIN\tVERSION\tDESCRIPTION");
  for (const plugin of plugins) {
    context.write(
      `${plugin.name}\t${plugin.version ?? "-"}\t${plugin.description ?? "-"}`,
    );
    if (!expand) continue;
    if (plugin.skills) {
      for (const skill of plugin.skills) context.write(`  SKILL ${skill}`);
    } else {
      context.write(`  SKILLS unavailable: ${plugin.skills_error}`);
    }
  }
  return {
    kind: "marketplace-show",
    name,
    count: plugins.length,
    data: {
      kind: "marketplace-show",
      marketplace: name,
      revision: registration.revision,
      default: config.default_marketplace === name,
      plugins,
    },
  };
}

function use({ context, options, positional }) {
  const name = positional[0];
  const config = loadConfig(context.paths.config);
  if (!config.marketplaces[name]) fail(`Marketplace is not registered: ${name}`);
  config.default_marketplace = name;
  context.write(`${options.dry_run ? "DRY-RUN " : ""}DEFAULT ${name}`);
  if (!options.dry_run) saveConfig(context.paths.config, config);
  return {
    kind: "marketplace-use",
    name,
    data: { kind: "marketplace-use", name, dry_run: options.dry_run === true },
  };
}

async function update({ context, options, positional }) {
  const config = loadConfig(context.paths.config);
  const names = positional.length ? positional : Object.keys(config.marketplaces).sort();
  const preview = options.dry_run ? temporaryPaths(context) : null;
  const updated = [];
  try {
    for (const name of names) {
      const registration = config.marketplaces[name];
      if (!registration) fail(`Marketplace is not registered: ${name}`);
      assertOnlineSource(options, registration.source, "marketplace update");
      const materialized = await materializeMarketplace(
        registration.source,
        preview?.paths ?? context.paths,
        name,
        { env: context.env, offline: options.offline === true },
      );
      context.write(
        `${options.dry_run ? "DRY-RUN " : ""}UPDATE ${name} ` +
          `${registration.revision} -> ${materialized.revision}`,
      );
      updated.push({
        name,
        from: registration.revision,
        to: materialized.revision,
      });
      if (!options.dry_run) {
        config.marketplaces[name] = marketplaceRegistration(materialized);
        saveConfig(context.paths.config, config);
      }
    }
    return {
      kind: "marketplace-update",
      names,
      data: {
        kind: "marketplace-update",
        updated,
        dry_run: options.dry_run === true,
      },
    };
  } finally {
    if (preview) rmSync(preview.root, { recursive: true, force: true });
  }
}

function remove({ context, options, positional }) {
  const name = positional[0];
  const config = removeMarketplace(loadConfig(context.paths.config), name);
  context.write(`${options.dry_run ? "DRY-RUN " : ""}REMOVE MARKETPLACE ${name}`);
  if (!options.dry_run) {
    saveConfig(context.paths.config, config);
    deleteMarketplaceCache(context.paths, name);
  }
  return {
    kind: "marketplace-remove",
    name,
    data: { kind: "marketplace-remove", name, dry_run: options.dry_run === true },
  };
}

// A read-only query must not fail because a lock is stale or absent, so any
// problem reading the environment becomes a diagnostic and the query falls back
// to the Marketplace manifest.
function lockedDependency(context, options, id) {
  const scope = scopeOption(options);
  if (scope === "project" && !findProject(context.cwd)) return null;
  try {
    const environment = loadEnvironment(context, options, true);
    return environment.lock.value.dependencies.find(
      (dependency) => dependency.plugin === id,
    ) ?? null;
  } catch (error) {
    context.diagnostic(`LOCK unavailable: ${error.message}`);
    return null;
  }
}

// The lock alone can answer the query, which is what lets a Plugin from a
// project-declared Marketplace be inspected without a user registration. A
// Marketplace problem is therefore reported as fatal only when the lock has
// nothing to fall back on (CFI-006).
function marketplaceEntry(context, parsed, registration, tolerate) {
  const miss = (message) => {
    if (!tolerate) fail(message);
    context.diagnostic(`MARKETPLACE ${message}`);
    return { entry: null, marketplace: null };
  };
  if (!registration) return miss(unregisteredMessage(parsed.marketplace));
  let marketplace;
  try {
    marketplace = registeredMarketplace(
      parsed.marketplace,
      registration,
      context.paths,
    );
  } catch (error) {
    return miss(error.message);
  }
  const entry = marketplace.manifest.plugins.find(
    (plugin) => plugin.name === parsed.plugin,
  ) ?? null;
  if (!entry) {
    return miss(
      `Plugin ${parsed.plugin} is not present in Marketplace ${parsed.marketplace}`,
    );
  }
  return { entry, marketplace };
}

function info({ context, options, positional }) {
  const config = loadConfig(context.paths.config);
  const id = qualifiedPluginId(positional[0], config);
  const parsed = parsePluginId(id);
  const registration = config.marketplaces[parsed.marketplace];
  const locked = lockedDependency(context, options, id);
  const { entry, marketplace } = marketplaceEntry(
    context,
    parsed,
    registration,
    Boolean(locked),
  );
  // An installed Plugin is described by the lock, which is pinned and needs no
  // Marketplace read; only an uninstalled one has to be discovered.
  const resolved = locked
    ? {
        version: locked.version,
        skills: locked.skills.map((skill) => skill.name),
        error: null,
      }
    : pluginDetail(entry, marketplace, options, context);
  const data = {
    kind: "info",
    plugin: id,
    marketplace: parsed.marketplace,
    installed: Boolean(locked),
    scope: scopeOption(options),
    version: resolved.version ?? null,
    description: entry?.description ?? null,
    plugin_source: locked?.plugin_source ??
      (entry ? normalizedPluginSource(entry.source) : null),
    marketplace_source: locked?.marketplace_source ?? registration?.source ?? null,
    marketplace_revision: locked?.marketplace_revision ??
      registration?.revision ?? null,
    skills: resolved.skills,
    ...(resolved.error ? { skills_error: resolved.error } : {}),
  };
  context.write(`PLUGIN ${id}`);
  context.write(`INSTALLED ${data.installed ? "yes" : "no"}`);
  context.write(`VERSION ${data.version ?? "-"}`);
  context.write(`MARKETPLACE ${parsed.marketplace}`);
  context.write(`SOURCE ${JSON.stringify(data.plugin_source)}`);
  context.write(`DESCRIPTION ${data.description ?? "-"}`);
  if (data.skills) {
    for (const skill of data.skills) context.write(`SKILL ${skill}`);
  } else {
    context.write(`SKILLS unavailable: ${data.skills_error}`);
  }
  return { kind: "info", plugin: id, installed: data.installed, data };
}

const HANDLERS = {
  "marketplace-add": add,
  "marketplace-list": list,
  "marketplace-show": show,
  "marketplace-use": use,
  "marketplace-update": update,
  "marketplace-remove": remove,
  info,
};

export async function marketplaceCommand(handler, request) {
  const run = HANDLERS[handler];
  if (!run) fail(`Unknown marketplace handler: ${handler}`);
  return run(request);
}

export { HANDLERS as MARKETPLACE_HANDLERS };
