import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  resolvedAgentRows,
  selectAgents,
} from "./agent-paths.mjs";
import { onePositional, parseOptions, scopeOption } from "./cli-options.mjs";
import {
  loadEnvironment,
  manifestLocation,
  qualifiedPluginId,
} from "./command-context.mjs";
import { loadConfig } from "./config.mjs";
import { fail } from "./errors.mjs";
import { atomicWrite, pathExists } from "./io.mjs";
import { loadLock } from "./lock.mjs";
import {
  createManifest,
  findProject,
  proposedManifest,
  removeDependency,
  saveManifest,
  selectDependencyGroups,
  upsertDependency,
} from "./manifest.mjs";
import { projectMarketplaceConfig } from "./marketplace.mjs";
import { resolveLock, writeLock } from "./resolver.mjs";
import { shellInit } from "./shell.mjs";
import {
  buildSyncPlan,
  cleanManaged,
  executeSyncPlan,
  loadState,
} from "./sync.mjs";
import {
  assertTrusted,
  trustProject,
  trustStatus,
  untrustProject,
} from "./trust.mjs";

function printPlan(context, plan, dryRun) {
  const prefix = dryRun ? "DRY-RUN " : "";
  for (const action of plan.actions) {
    context.write(
      `${prefix}${action.operation.toUpperCase()} [${action.agents.join(",")}] ` +
        `${action.destination} -> ${action.source}` +
        (action.backup ? ` (backup: ${action.backup})` : ""),
    );
  }
  for (const record of plan.stale) {
    context.write(`${prefix}REMOVE ${record.destination}`);
  }
}

function syncResolved(context, environment, manifest, lockValue, options) {
  const state = loadState(environment.statePath);
  const plan = buildSyncPlan(
    { value: lockValue },
    environment.scope,
    environment.root,
    context.registry,
    context.paths,
    state,
    {
      env: context.env,
      homeDir: context.homeDir,
      replace: options.replace === true,
      allowMissingCache: options.dry_run === true,
      activeGroups: options.activeGroups ?? [],
    },
  );
  printPlan(context, plan, options.dry_run === true);
  if (!options.dry_run) {
    executeSyncPlan(plan, environment.statePath, {
      scope: environment.scope,
      root: environment.root,
      manifest_sha256: manifest.sha256,
      active_groups: options.activeGroups ?? [],
    });
  }
  return plan;
}

function rejectGroupSelection(options, command) {
  if (options.groups?.length || options.all_groups) {
    fail(`${command} does not select dependency groups; use skillsenv sync`);
  }
}

async function resolveEnvironmentLock(context, environment, options = {}) {
  const userConfig = loadConfig(context.paths.config);
  const projectConfig = await projectMarketplaceConfig(
    environment.manifest,
    userConfig,
    context.paths,
    {
      persist: options.persistCache !== false,
      env: context.env,
    },
  );
  try {
    return resolveLock(
      environment.manifest,
      projectConfig.config,
      context.paths,
      options,
    );
  } finally {
    projectConfig.cleanup();
  }
}

function captureFiles(paths) {
  return paths.map((path) => ({
    path,
    existed: pathExists(path),
    content: pathExists(path) ? readFileSync(path) : null,
  }));
}

function restoreFiles(snapshots) {
  const errors = [];
  for (const snapshot of snapshots) {
    try {
      if (snapshot.existed) atomicWrite(snapshot.path, snapshot.content);
      else rmSync(snapshot.path, { force: true });
    } catch (error) {
      errors.push(`${snapshot.path}: ${error.message}`);
    }
  }
  return errors;
}

function persistThenSync(context, environment, manifest, lockValue, options) {
  if (options.dry_run) {
    return syncResolved(context, environment, manifest, lockValue, options);
  }
  const snapshots = captureFiles([
    environment.manifestPath,
    environment.lockPath,
  ]);
  try {
    saveManifest(environment.manifestPath, manifest.value);
    writeLock(environment.lockPath, lockValue);
    return syncResolved(context, environment, manifest, lockValue, options);
  } catch (error) {
    const restoreErrors = restoreFiles(snapshots);
    const suffix = restoreErrors.length
      ? `; manifest rollback failures: ${restoreErrors.join("; ")}`
      : "";
    fail(`${error.message}${suffix}`);
  }
}

function persistLockThenSync(context, environment, lockValue, options) {
  if (options.dry_run || options.frozen) {
    return syncResolved(
      context,
      environment,
      environment.manifest,
      lockValue,
      options,
    );
  }
  const snapshots = captureFiles([environment.lockPath]);
  try {
    writeLock(environment.lockPath, lockValue);
    return syncResolved(
      context,
      environment,
      environment.manifest,
      lockValue,
      options,
    );
  } catch (error) {
    const restoreErrors = restoreFiles(snapshots);
    const suffix = restoreErrors.length
      ? `; lock rollback failures: ${restoreErrors.join("; ")}`
      : "";
    fail(`${error.message}${suffix}`);
  }
}

function init(context, args) {
  const { options, positional } = parseOptions(args);
  if (positional.length) fail("init takes no arguments");
  const path = join(context.cwd, ".skillsenv");
  if (options.dry_run) context.write(`DRY-RUN CREATE ${path}`);
  else {
    createManifest(path);
    context.write(`CREATED ${path}`);
  }
  return { kind: "init" };
}

function mutationEnvironment(context, options, scope) {
  if (scope !== "user") return loadEnvironment(context, options);
  if (pathExists(context.paths.userManifest)) {
    return loadEnvironment(context, options);
  }
  const location = manifestLocation(context, scope, options.root);
  return {
    ...location,
    manifest: proposedManifest(
      location.manifestPath,
      { schema_version: 1, dependencies: [] },
      context.registry,
      scope,
    ),
    lock: null,
  };
}

async function dependencyMutation(context, args, remove) {
  const { options, positional } = parseOptions(args);
  rejectGroupSelection(options, remove ? "uninstall" : "install");
  const input = onePositional(positional, "Plugin dependency");
  const scope = scopeOption(options);
  const environment = mutationEnvironment(context, options, scope);
  const config = loadConfig(context.paths.config);
  const id = qualifiedPluginId(input, config);
  const value = remove
    ? removeDependency(environment.manifest.value, id)
    : upsertDependency(environment.manifest.value, {
        plugin: id,
        agents: selectAgents(options.agents ?? [], scope, context.registry),
        ...(options.skills?.length ? { skills: options.skills } : {}),
      });
  const manifest = proposedManifest(
    environment.manifestPath,
    value,
    context.registry,
    scope,
  );
  const lock = await resolveEnvironmentLock(context, {
    ...environment,
    manifest,
  }, {
    persistCache: !options.dry_run,
    env: context.env,
  });
  options.activeGroups = selectDependencyGroups(manifest.value, {
    groups: loadState(environment.statePath).active_groups,
  });
  const plan = persistThenSync(context, environment, manifest, lock, options);
  context.write(
    `SUMMARY plugin=${id} action=${remove ? "uninstall" : "install"} ` +
      `links=${plan.actions.length} dry_run=${options.dry_run === true}`,
  );
  return { kind: remove ? "uninstall" : "install", plugin: id, plan };
}

async function lock(context, args) {
  const { options, positional } = parseOptions(args);
  if (positional.length) fail("lock takes no arguments");
  rejectGroupSelection(options, "lock");
  const environment = loadEnvironment(context, options);
  const value = await resolveEnvironmentLock(
    context,
    environment,
    { persistCache: !options.dry_run, env: context.env },
  );
  context.write(
    `${options.dry_run ? "DRY-RUN " : ""}LOCK ${environment.lockPath} ` +
      `plugins=${value.dependencies.length}`,
  );
  if (!options.dry_run) writeLock(environment.lockPath, value);
  return { kind: "lock", lock: value };
}

async function sync(context, args) {
  const { options, positional } = parseOptions(args);
  if (positional.length) fail("sync takes no arguments");
  const environment = loadEnvironment(context, options, options.frozen === true);
  options.activeGroups = selectDependencyGroups(
    environment.manifest.value,
    options,
  );
  const value = options.frozen
    ? environment.lock.value
    : await resolveEnvironmentLock(
        context,
        environment,
        { persistCache: !options.dry_run, env: context.env },
      );
  const plan = persistLockThenSync(context, environment, value, options);
  context.write(
    `SUMMARY scope=${environment.scope} links=${plan.actions.length} ` +
      `groups=${options.activeGroups.join(",") || "core"} ` +
      `dry_run=${options.dry_run === true}`,
  );
  return { kind: "sync", plan };
}

function activate(context, args) {
  const { options, positional } = parseOptions(args);
  if (positional.length) fail("activate takes no arguments");
  rejectGroupSelection(options, "activate");
  options.scope = "project";
  const start = resolve(context.cwd, options.root ?? ".");
  if (!findProject(start)) {
    if (!options.quiet) context.write(`NO ENVIRONMENT from ${start}`);
    return { kind: "activate", active: false };
  }
  const environment = loadEnvironment(context, options, true);
  const state = loadState(environment.statePath);
  options.activeGroups = selectDependencyGroups(environment.manifest.value, {
    groups: state.active_groups,
  });
  assertTrusted(
    context.paths.trust,
    environment.root,
    environment.manifest,
    environment.lock,
  );
  const plan = syncResolved(
    context,
    environment,
    environment.manifest,
    environment.lock.value,
    { ...options, dry_run: false },
  );
  if (!options.quiet) context.write(`ACTIVATED ${environment.root}`);
  return { kind: "activate", active: true, plan };
}

function trust(context, args, remove) {
  const { options, positional } = parseOptions(args);
  if (positional.length) fail(`${remove ? "untrust" : "trust"} takes no arguments`);
  options.scope = "project";
  const environment = loadEnvironment(context, options, !remove);
  if (remove) {
    untrustProject(context.paths.trust, environment.root);
    context.write(`UNTRUSTED ${environment.root}`);
  } else {
    trustProject(
      context.paths.trust,
      environment.root,
      environment.manifest,
      environment.lock,
    );
    context.write(`TRUSTED ${environment.root}`);
  }
  return { kind: remove ? "untrust" : "trust", root: environment.root };
}

function clean(context, args) {
  const { options, positional } = parseOptions(args);
  if (positional.length) fail("clean takes no arguments");
  const environment = loadEnvironment(context, options);
  const results = cleanManaged(
    environment.statePath,
    environment.scope,
    environment.root,
    context.registry,
    { env: context.env, homeDir: context.homeDir },
    options.dry_run === true,
  );
  for (const result of results) {
    context.write(
      `${options.dry_run ? "DRY-RUN " : ""}${result.operation.toUpperCase()} ` +
        result.destination,
    );
  }
  return { kind: "clean", results };
}

function status(context, args) {
  const { options, positional } = parseOptions(args);
  if (positional.length) fail("status takes no arguments");
  const scope = scopeOption(options);
  if (scope === "project") {
    const start = resolve(context.cwd, options.root ?? ".");
    if (!findProject(start)) {
      context.write("ENVIRONMENT none");
      return { kind: "status", found: false };
    }
  }
  const environment = loadEnvironment(context, options, false);
  const state = loadState(environment.statePath);
  let lockValue = null;
  let trustValue = { trusted: false, reason: "lock file is missing" };
  if (pathExists(environment.lockPath)) {
    try {
      lockValue = loadLock(environment.lockPath, environment.manifest, context.paths);
      if (scope === "project") {
        trustValue = trustStatus(
          context.paths.trust,
          environment.root,
          environment.manifest,
          lockValue,
        );
      }
    } catch (error) {
      trustValue = { trusted: false, reason: error.message };
    }
  }
  context.write(`ENVIRONMENT ${environment.root}`);
  context.write(`SCOPE ${scope}`);
  context.write(`LOCK ${lockValue ? "valid" : "invalid-or-missing"}`);
  if (scope === "project") {
    context.write(
      `TRUST ${trustValue.trusted ? "trusted" : `untrusted: ${trustValue.reason}`}`,
    );
  }
  context.write(`MANAGED ${state.managed.length}`);
  context.write(`GROUPS ${state.active_groups.join(",") || "core"}`);
  return {
    kind: "status",
    found: true,
    environment,
    lock: lockValue,
    trust: trustValue,
    state,
  };
}

function agents(context, args) {
  const { positional } = parseOptions(args);
  if (positional.length) fail("agents takes no arguments");
  context.write("AGENT\tUSER PATH\tPROJECT PATH\tDISPLAY NAME");
  const rows = resolvedAgentRows(context.registry, context);
  for (const row of rows) {
    context.write(
      `${row.id}\t${row.userDir ?? "-"}\t${row.projectDir}\t${row.displayName}`,
    );
  }
  return { kind: "agents", count: rows.length };
}

function shell(context, args) {
  const { positional } = parseOptions(args);
  const shellName = onePositional(positional, "shell name");
  context.write(shellInit(shellName).trimEnd());
  return { kind: "shell-init", shell: shellName };
}

export function environmentCommand(context, command, args) {
  if (command === "init") return init(context, args);
  if (command === "install") return dependencyMutation(context, args, false);
  if (command === "uninstall") return dependencyMutation(context, args, true);
  if (command === "lock") return lock(context, args);
  if (command === "sync") return sync(context, args);
  if (command === "activate") return activate(context, args);
  if (command === "trust") return trust(context, args, false);
  if (command === "untrust") return trust(context, args, true);
  if (command === "status") return status(context, args);
  if (command === "clean") return clean(context, args);
  if (command === "agents") return agents(context, args);
  if (command === "shell-init") return shell(context, args);
  return null;
}
