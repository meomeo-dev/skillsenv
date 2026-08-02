import { rmSync } from "node:fs";
import { join } from "node:path";

import { fail } from "./errors.mjs";
import { pathExists, readYaml, writeYaml } from "./io.mjs";

export function emptyConfig() {
  return { schema_version: 1, default_marketplace: null, marketplaces: {} };
}

export function loadConfig(path) {
  if (!pathExists(path)) return emptyConfig();
  const config = readYaml(path, "Skillsenv config");
  if (config.schema_version !== 1 || !config.marketplaces ||
      Array.isArray(config.marketplaces)) {
    fail("Skillsenv config requires schema_version: 1 and marketplaces");
  }
  if (config.default_marketplace !== null &&
      config.default_marketplace !== undefined &&
      !config.marketplaces[config.default_marketplace]) {
    fail("Skillsenv default_marketplace is not registered");
  }
  return {
    schema_version: 1,
    default_marketplace: config.default_marketplace ?? null,
    marketplaces: config.marketplaces,
  };
}

export function saveConfig(path, config) {
  writeYaml(path, config);
}

export function setMarketplace(config, name, registration) {
  return {
    ...config,
    marketplaces: { ...config.marketplaces, [name]: registration },
    default_marketplace: config.default_marketplace ?? name,
  };
}

export function removeMarketplace(config, name) {
  if (!config.marketplaces[name]) fail(`Marketplace is not registered: ${name}`);
  const marketplaces = { ...config.marketplaces };
  delete marketplaces[name];
  const nextDefault = config.default_marketplace === name
    ? Object.keys(marketplaces).sort()[0] ?? null
    : config.default_marketplace;
  return { ...config, default_marketplace: nextDefault, marketplaces };
}

export function marketplaceCachePath(paths, name) {
  return join(paths.marketplaceCache, name);
}

export function deleteMarketplaceCache(paths, name) {
  rmSync(marketplaceCachePath(paths, name), { recursive: true, force: true });
}
