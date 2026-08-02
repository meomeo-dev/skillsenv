import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { loadAgentRegistry } from "./agent-paths.mjs";
import { scopeOption } from "./cli-options.mjs";
import { fail } from "./errors.mjs";
import { homePaths, projectStatePath } from "./home.mjs";
import { loadLock } from "./lock.mjs";
import { findProject, loadManifest, parsePluginId } from "./manifest.mjs";

export function createContext(overrides = {}) {
  const env = overrides.env ?? process.env;
  const homeDir = overrides.homeDir ?? homedir();
  return {
    cwd: overrides.cwd ?? process.cwd(),
    env,
    homeDir,
    paths: homePaths({ env, homeDir }),
    registry: overrides.registry ?? loadAgentRegistry(),
    write: overrides.write ?? console.log,
  };
}

export function manifestLocation(context, scope, rootOption) {
  if (scope === "user") {
    return {
      scope,
      root: context.paths.root,
      manifestPath: context.paths.userManifest,
      lockPath: context.paths.userLock,
      statePath: join(context.paths.state, "user.json"),
    };
  }
  const start = resolve(context.cwd, rootOption ?? ".");
  const project = findProject(start);
  if (!project) fail(`No .skillsenv found from ${start}`);
  return {
    scope,
    root: project.root,
    manifestPath: project.manifest,
    lockPath: join(project.root, ".skillsenv.lock"),
    statePath: projectStatePath(context.paths, project.root),
  };
}

export function loadEnvironment(context, options, requireLock = false) {
  const scope = scopeOption(options);
  const location = manifestLocation(context, scope, options.root);
  const manifest = loadManifest(location.manifestPath, context.registry, scope);
  const lock = requireLock
    ? loadLock(location.lockPath, manifest, context.paths)
    : null;
  return { ...location, manifest, lock };
}

export function qualifiedPluginId(input, config) {
  if (input.includes("@")) return parsePluginId(input).id;
  if (!config.default_marketplace) {
    fail("No default Marketplace; use plugin@marketplace or marketplace use");
  }
  return parsePluginId(`${input}@${config.default_marketplace}`).id;
}
