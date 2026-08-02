import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { loadAgentRegistry } from "./agent-paths.mjs";
import { scopeOption } from "./cli-options.mjs";
import { fail } from "./errors.mjs";
import { homePaths, projectStatePath } from "./home.mjs";
import { loadLock } from "./lock.mjs";
import { findProject, loadManifest, parsePluginId } from "./manifest.mjs";

export function createContext(overrides = {}, options = {}) {
  const env = overrides.env ?? process.env;
  const homeDir = overrides.homeDir ?? homedir();
  const baseCwd = overrides.cwd ?? process.cwd();
  // `--directory` changes the working directory for the whole run, so project
  // discovery and `init` both follow it (CFI-006).
  const cwd = resolve(baseCwd, options.directory ?? ".");
  const write = overrides.write ?? console.log;
  const diagnostic = overrides.diagnostic ??
    ((line) => console.error(line));
  const quiet = options.quiet === true;
  const json = options.output_format === "json";
  return {
    cwd,
    env,
    homeDir,
    paths: homePaths({ env, homeDir }),
    registry: overrides.registry ?? loadAgentRegistry(),
    // Results go to stdout; JSON mode suppresses the human-readable lines so the
    // JSON document is the only thing on stdout (CFI-011, CFI-012).
    write: json ? () => {} : write,
    // The single stdout channel that stays open in JSON mode.
    emitJson: write,
    // Progress and status notes go to stderr and are silenced by --quiet.
    diagnostic: quiet ? () => {} : diagnostic,
    // Deprecation and migration hints also go to stderr but survive --quiet:
    // silencing them would hide the one signal that a script needs updating.
    // Errors are never routed through either channel.
    warn: diagnostic,
    verbose: options.verbose === true
      ? diagnostic
      : () => {},
    json,
  };
}

export function manifestLocation(context, scope) {
  if (scope === "user") {
    return {
      scope,
      root: context.paths.root,
      manifestPath: context.paths.userManifest,
      lockPath: context.paths.userLock,
      statePath: join(context.paths.state, "user.json"),
    };
  }
  const start = context.cwd;
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
  const location = manifestLocation(context, scope);
  const manifest = loadManifest(location.manifestPath, context.registry, scope);
  // loadLock already rejects a lock whose manifest_sha256 has drifted, which is
  // exactly the freshness guarantee --locked needs.
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
