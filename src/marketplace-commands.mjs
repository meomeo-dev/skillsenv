import { rmSync } from "node:fs";
import { join } from "node:path";

import { onePositional, parseOptions } from "./cli-options.mjs";
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

async function add(context, args) {
  const { options, positional } = parseOptions(args);
  const input = onePositional(positional, "Marketplace source");
  const source = parseMarketplaceSource(input, context.cwd);
  const preview = options.dry_run ? temporaryPaths(context) : null;
  try {
    const materialized = await materializeMarketplace(
      source,
      preview?.paths ?? context.paths,
      undefined,
      { env: context.env },
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
    return { kind: "marketplace-add", name: materialized.manifest.name };
  } finally {
    if (preview) rmSync(preview.root, { recursive: true, force: true });
  }
}

function list(context, args) {
  const { positional } = parseOptions(args);
  if (positional.length) fail("marketplace list takes no arguments");
  const config = loadConfig(context.paths.config);
  context.write("DEFAULT\tNAME\tSOURCE\tREVISION");
  for (const [name, registration] of Object.entries(config.marketplaces).sort()) {
    context.write(
      `${config.default_marketplace === name ? "*" : ""}\t${name}\t` +
        `${JSON.stringify(registration.source)}\t${registration.revision}`,
    );
  }
  return { kind: "marketplace-list", count: Object.keys(config.marketplaces).length };
}

function use(context, args) {
  const { options, positional } = parseOptions(args);
  const name = onePositional(positional, "Marketplace name");
  const config = loadConfig(context.paths.config);
  if (!config.marketplaces[name]) fail(`Marketplace is not registered: ${name}`);
  config.default_marketplace = name;
  context.write(`${options.dry_run ? "DRY-RUN " : ""}DEFAULT ${name}`);
  if (!options.dry_run) saveConfig(context.paths.config, config);
  return { kind: "marketplace-use", name };
}

async function update(context, args) {
  const { options, positional } = parseOptions(args);
  if (positional.length > 1) fail("marketplace update accepts at most one name");
  const config = loadConfig(context.paths.config);
  const names = positional.length ? positional : Object.keys(config.marketplaces).sort();
  const preview = options.dry_run ? temporaryPaths(context) : null;
  try {
    for (const name of names) {
      const registration = config.marketplaces[name];
      if (!registration) fail(`Marketplace is not registered: ${name}`);
      const materialized = await materializeMarketplace(
        registration.source,
        preview?.paths ?? context.paths,
        name,
        { env: context.env },
      );
      context.write(
        `${options.dry_run ? "DRY-RUN " : ""}UPDATE ${name} ` +
          `${registration.revision} -> ${materialized.revision}`,
      );
      if (!options.dry_run) {
        config.marketplaces[name] = marketplaceRegistration(materialized);
        saveConfig(context.paths.config, config);
      }
    }
    return { kind: "marketplace-update", names };
  } finally {
    if (preview) rmSync(preview.root, { recursive: true, force: true });
  }
}

function remove(context, args) {
  const { options, positional } = parseOptions(args);
  const name = onePositional(positional, "Marketplace name");
  const config = removeMarketplace(loadConfig(context.paths.config), name);
  context.write(`${options.dry_run ? "DRY-RUN " : ""}REMOVE MARKETPLACE ${name}`);
  if (!options.dry_run) {
    saveConfig(context.paths.config, config);
    deleteMarketplaceCache(context.paths, name);
  }
  return { kind: "marketplace-remove", name };
}

export async function marketplaceCommand(context, args) {
  const [command, ...rest] = args;
  if (command === "add") return add(context, rest);
  if (command === "list") return list(context, rest);
  if (command === "use") return use(context, rest);
  if (command === "update") return update(context, rest);
  if (command === "remove") return remove(context, rest);
  fail("Expected marketplace add, list, use, update, or remove");
}
