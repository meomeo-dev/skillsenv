import { rmSync } from "node:fs";
import { join } from "node:path";

import {
  deleteMarketplaceCache,
  loadConfig,
  removeMarketplace,
  saveConfig,
  setMarketplace,
} from "./config.mjs";
import { fail } from "./errors.mjs";
import { makeTempDir } from "./io.mjs";
import {
  marketplaceRegistration,
  materializeMarketplace,
  parseMarketplaceSource,
} from "./marketplace.mjs";

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

const HANDLERS = {
  "marketplace-add": add,
  "marketplace-list": list,
  "marketplace-use": use,
  "marketplace-update": update,
  "marketplace-remove": remove,
};

export async function marketplaceCommand(handler, request) {
  const run = HANDLERS[handler];
  if (!run) fail(`Unknown marketplace handler: ${handler}`);
  return run(request);
}

export { HANDLERS as MARKETPLACE_HANDLERS };
