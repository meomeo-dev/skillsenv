import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  resolvedAgentRows,
  selectAgents,
} from "./agent-paths.mjs";
import { scopeOption } from "./cli-options.mjs";
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

// Writes the declaration and lock but leaves the environment alone. Shares the
// snapshot/rollback path with persistThenSync so a partial write still restores.
function persistWithoutSync(context, environment, manifest, lockValue, options) {
  if (options.dry_run) return null;
  const snapshots = captureFiles([
    environment.manifestPath,
    environment.lockPath,
  ]);
  try {
    saveManifest(environment.manifestPath, manifest.value);
    writeLock(environment.lockPath, lockValue);
    return null;
  } catch (error) {
    const restoreErrors = restoreFiles(snapshots);
    const suffix = restoreErrors.length
      ? `; manifest rollback failures: ${restoreErrors.join("; ")}`
      : "";
    fail(`${error.message}${suffix}`);
  }
}

function persistLockThenSync(context, environment, lockValue, options) {
  // --locked never rewrites the lock; --dry-run never writes at all.
  if (options.dry_run || options.locked) {
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

function init({ context, options }) {
  const path = join(context.cwd, ".skillsenv");
  if (options.dry_run) context.write(`DRY-RUN CREATE ${path}`);
  else {
    createManifest(path);
    context.write(`CREATED ${path}`);
  }
  return {
    kind: "init",
    data: { kind: "init", manifest: path, dry_run: options.dry_run === true },
  };
}

function mutationEnvironment(context, options, scope) {
  if (scope !== "user") return loadEnvironment(context, options);
  if (pathExists(context.paths.userManifest)) {
    return loadEnvironment(context, options);
  }
  const location = manifestLocation(context, scope);
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

async function dependencyMutation({ context, options, positional }, remove) {
  const input = positional[0];
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
    offline: options.offline === true,
  });
  options.activeGroups = selectDependencyGroups(manifest.value, {
    groups: loadState(environment.statePath).active_groups,
  });
  const action = remove ? "remove" : "add";
  // --no-sync stops at the declaration and lock; Agent directories are untouched
  // (CFI-010).
  const plan = options.no_sync
    ? persistWithoutSync(context, environment, manifest, lock, options)
    : persistThenSync(context, environment, manifest, lock, options);
  const links = plan?.actions.length ?? 0;
  context.write(
    `SUMMARY plugin=${id} action=${action} ` +
      `links=${links} dry_run=${options.dry_run === true}`,
  );
  return {
    kind: action,
    plugin: id,
    plan,
    data: {
      kind: action,
      plugin: id,
      scope,
      links,
      synced: options.no_sync !== true,
      dry_run: options.dry_run === true,
    },
  };
}

async function lock({ context, options }) {
  const environment = loadEnvironment(context, options);
  const value = await resolveEnvironmentLock(
    context,
    environment,
    {
      persistCache: !options.dry_run,
      env: context.env,
      offline: options.offline === true,
    },
  );
  context.write(
    `${options.dry_run ? "DRY-RUN " : ""}LOCK ${environment.lockPath} ` +
      `plugins=${value.dependencies.length}`,
  );
  if (!options.dry_run) writeLock(environment.lockPath, value);
  return {
    kind: "lock",
    lock: value,
    data: {
      kind: "lock",
      lock_path: environment.lockPath,
      plugins: value.dependencies.length,
      dry_run: options.dry_run === true,
    },
  };
}

async function sync({ context, options }) {
  // --locked requires a lock that already matches the declaration and must never
  // rewrite it. Cache gaps are still refilled from the locked sources unless
  // --offline forbids the network (CFI-007, CFI-008).
  const locked = options.locked === true;
  const environment = loadEnvironment(context, options, locked);
  options.activeGroups = selectDependencyGroups(
    environment.manifest.value,
    options,
  );
  const value = locked
    ? environment.lock.value
    : await resolveEnvironmentLock(
        context,
        environment,
        {
          persistCache: !options.dry_run,
          env: context.env,
          offline: options.offline === true,
        },
      );
  const plan = persistLockThenSync(context, environment, value, options);
  context.write(
    `SUMMARY scope=${environment.scope} links=${plan.actions.length} ` +
      `groups=${options.activeGroups.join(",") || "core"} ` +
      `dry_run=${options.dry_run === true}`,
  );
  return {
    kind: "sync",
    plan,
    data: {
      kind: "sync",
      scope: environment.scope,
      root: environment.root,
      links: plan.actions.length,
      removed: plan.stale.length,
      groups: options.activeGroups,
      locked,
      offline: options.offline === true,
      dry_run: options.dry_run === true,
    },
  };
}

function activate({ context, options }) {
  options.scope = "project";
  const start = context.cwd;
  if (!findProject(start)) {
    // Not an error: the shell hook calls this in every directory.
    context.diagnostic(`NO ENVIRONMENT from ${start}`);
    return {
      kind: "activate",
      active: false,
      data: { kind: "activate", active: false, root: null },
    };
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
  context.diagnostic(`ACTIVATED ${environment.root}`);
  return {
    kind: "activate",
    active: true,
    plan,
    data: {
      kind: "activate",
      active: true,
      root: environment.root,
      links: plan.actions.length,
    },
  };
}

function trust({ context, options }, remove) {
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
  const kind = remove ? "untrust" : "trust";
  return {
    kind,
    root: environment.root,
    data: { kind, root: environment.root },
  };
}

function clean({ context, options }) {
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
  return {
    kind: "clean",
    results,
    data: {
      kind: "clean",
      removed: results.length,
      entries: results.map((result) => ({
        operation: result.operation,
        destination: result.destination,
      })),
      dry_run: options.dry_run === true,
    },
  };
}

// The state records what is linked but not which version produced it, so the
// version is joined in from the lock. A missing or stale lock leaves it null
// rather than failing: status is the command you run to diagnose that.
function managedEntries(state, lockValue) {
  const versions = new Map(
    (lockValue?.value.dependencies ?? []).map((dependency) => [
      dependency.plugin,
      dependency.version ?? null,
    ]),
  );
  return [...state.managed]
    .map((record) => ({
      plugin: record.plugin,
      skill: record.skill,
      agents: [...record.agents],
      version: versions.get(record.plugin) ?? null,
      destination: record.destination,
    }))
    .sort((left, right) =>
      left.plugin.localeCompare(right.plugin) || left.skill.localeCompare(right.skill));
}

function status({ context, options }) {
  const scope = scopeOption(options);
  if (scope === "project" && !findProject(context.cwd)) {
    context.write("ENVIRONMENT none");
    return {
      kind: "status",
      found: false,
      data: { kind: "status", found: false, scope },
    };
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
  const entries = managedEntries(state, lockValue);
  context.write(`MANAGED ${state.managed.length}`);
  context.write(`GROUPS ${state.active_groups.join(",") || "core"}`);
  if (entries.length) {
    context.write("PLUGIN\tSKILL\tAGENTS\tVERSION");
    for (const entry of entries) {
      context.write(
        `${entry.plugin}\t${entry.skill}\t${entry.agents.join(",")}\t` +
          `${entry.version ?? "-"}`,
      );
    }
  }
  return {
    kind: "status",
    found: true,
    environment,
    lock: lockValue,
    trust: trustValue,
    state,
    entries,
    data: {
      kind: "status",
      found: true,
      scope,
      root: environment.root,
      lock: lockValue ? "valid" : "invalid-or-missing",
      ...(scope === "project"
        ? {
            trusted: trustValue.trusted,
            trust_reason: trustValue.trusted ? null : trustValue.reason,
          }
        : {}),
      managed: state.managed.length,
      managed_entries: entries,
      groups: state.active_groups,
    },
  };
}

function agents({ context }) {
  context.write("AGENT\tUSER PATH\tPROJECT PATH\tDISPLAY NAME");
  const rows = resolvedAgentRows(context.registry, context);
  for (const row of rows) {
    context.write(
      `${row.id}\t${row.userDir ?? "-"}\t${row.projectDir}\t${row.displayName}`,
    );
  }
  return {
    kind: "agents",
    count: rows.length,
    data: {
      kind: "agents",
      agents: rows.map((row) => ({
        id: row.id,
        user_path: row.userDir ?? null,
        project_path: row.projectDir,
        display_name: row.displayName,
      })),
    },
  };
}

function shell({ context, positional }) {
  const shellName = positional[0];
  context.write(shellInit(shellName).trimEnd());
  return { kind: "shell-init", shell: shellName };
}

// Keyed by the contract's `handler` field, so a command declared in the contract
// without a handler here fails loudly in the dispatch test.
const HANDLERS = {
  init,
  add: (request) => dependencyMutation(request, false),
  remove: (request) => dependencyMutation(request, true),
  lock,
  sync,
  activate,
  trust: (request) => trust(request, false),
  untrust: (request) => trust(request, true),
  status,
  clean,
  agents,
  "shell-init": shell,
};

export function environmentCommand(handler, request) {
  const run = HANDLERS[handler];
  if (!run) return null;
  return run(request);
}

export { HANDLERS as ENVIRONMENT_HANDLERS };
