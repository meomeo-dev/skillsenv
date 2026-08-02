import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { targetGroups } from "./agent-paths.mjs";
import { fail } from "./errors.mjs";
import {
  pathExists,
  readJson,
  realpathOrNull,
  writeJson,
} from "./io.mjs";
import { installedSkillPath } from "./resolver.mjs";

function classify(destination, source, previousByDestination) {
  if (!pathExists(destination)) return "create";
  const stat = lstatSync(destination);
  if (stat.isSymbolicLink()) {
    const previous = previousByDestination.get(destination);
    if (linkPointsTo(destination, source)) {
      return previous?.owned !== false && previous ? "idempotent" : "compatible";
    }
    if (previous?.owned !== false && previous &&
        linkPointsTo(destination, previous.source)) {
      return "managed-replace";
    }
  }
  return "conflict";
}

function linkPointsTo(destination, expected) {
  const linkedPath = resolve(dirname(destination), readlinkSync(destination));
  const linkedRealPath = realpathOrNull(linkedPath);
  const expectedRealPath = realpathOrNull(expected);
  if (linkedRealPath !== null && expectedRealPath !== null) {
    return linkedRealPath === expectedRealPath;
  }
  return linkedPath === resolve(expected);
}

function backupPath(paths, destination, reserved) {
  const timestamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const root = join(paths.backups, "links");
  let candidate = join(root, `${basename(destination)}-${timestamp}`);
  let suffix = 2;
  while (pathExists(candidate) || reserved.has(candidate)) {
    candidate = join(root, `${basename(destination)}-${timestamp}-${suffix}`);
    suffix += 1;
  }
  reserved.add(candidate);
  return candidate;
}

export function loadState(path) {
  if (!pathExists(path)) return { schema_version: 1, managed: [] };
  const state = readJson(path, "Skillsenv managed state");
  if (state.schema_version !== 1 || !Array.isArray(state.managed)) {
    fail("Skillsenv managed state requires schema_version: 1 and managed[]");
  }
  return state;
}

function desiredRecords(lock, scope, root, registry, paths, context) {
  const records = [];
  const destinations = new Map();
  for (const dependency of lock.value.dependencies) {
    const groups = targetGroups(dependency.agents, scope, root, registry, context);
    for (const skill of dependency.skills) {
      const source = installedSkillPath(paths, skill, {
        mustExist: context.allowMissingCache !== true,
      });
      for (const group of groups) {
        const destination = join(group.targetDir, skill.name);
        const existing = destinations.get(destination);
        if (existing && existing.source !== source) {
          fail(
            `Two Plugins provide different content for ${skill.name} at ${destination}`,
          );
        }
        if (!existing) {
          const record = {
            destination,
            source,
            plugin: dependency.plugin,
            skill: skill.name,
            agents: [...group.agents],
          };
          destinations.set(destination, record);
          records.push(record);
        } else {
          existing.agents = [...new Set([...existing.agents, ...group.agents])];
        }
      }
    }
  }
  return records;
}

export function buildSyncPlan(lock, scope, root, registry, paths, state, options = {}) {
  validateStateRecords(state, scope, root, registry, options);
  const desired = desiredRecords(lock, scope, root, registry, paths, options);
  const previousByDestination = new Map(
    state.managed.map((record) => [record.destination, record]),
  );
  const reserved = new Set();
  const actions = desired.map((record) => {
    const operation = classify(record.destination, record.source, previousByDestination);
    if (operation === "conflict" && !options.replace) {
      fail(
        `Refusing to replace existing entry: ${record.destination}; ` +
          "rerun with --replace to create a recoverable backup",
      );
    }
    const previous = previousByDestination.get(record.destination);
    return {
      ...record,
      operation: operation === "conflict" ? "external-replace" : operation,
      backup: operation === "conflict"
        ? backupPath(paths, record.destination, reserved)
        : undefined,
      previousSource: operation === "managed-replace" ? previous.source : undefined,
    };
  });
  const desiredPaths = new Set(desired.map((record) => record.destination));
  const stale = state.managed.filter((record) => !desiredPaths.has(record.destination));
  const managed = actions.map((action) => ({
    destination: action.destination,
    source: action.source,
    plugin: action.plugin,
    skill: action.skill,
    agents: action.agents,
    owned: action.operation !== "compatible",
  }));
  return { actions, stale, managed };
}

function validateStateRecords(state, scope, root, registry, context) {
  for (const record of state.managed) {
    if (!record || typeof record.destination !== "string" ||
        typeof record.source !== "string" || typeof record.skill !== "string" ||
        !Array.isArray(record.agents) || record.agents.length === 0 ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.skill)) {
      fail("Skillsenv managed state contains an invalid record");
    }
    const groups = targetGroups(record.agents, scope, root, registry, context);
    const allowed = groups.some((group) =>
      record.destination === join(group.targetDir, record.skill));
    if (!allowed) {
      fail(`Managed state destination is outside its Agent targets: ${record.destination}`);
    }
  }
}

function isRecordedLink(record) {
  if (!pathExists(record.destination) ||
      !lstatSync(record.destination).isSymbolicLink()) return false;
  return linkPointsTo(record.destination, record.source);
}

function applyAction(action, completed) {
  if (["idempotent", "compatible"].includes(action.operation)) return;
  mkdirSync(dirname(action.destination), { recursive: true });
  if (action.operation === "external-replace") {
    mkdirSync(dirname(action.backup), { recursive: true });
    renameSync(action.destination, action.backup);
    completed.push({ kind: "backup", action });
  } else if (action.operation === "managed-replace") {
    unlinkSync(action.destination);
    completed.push({ kind: "managed-remove", action });
  }
  symlinkSync(action.source, action.destination, "dir");
  completed.push({ kind: "link", action });
}

function rollback(completed) {
  const errors = [];
  for (const item of [...completed].reverse()) {
    try {
      const { action } = item;
      if (item.kind === "link" && isRecordedLink(action)) unlinkSync(action.destination);
      if (item.kind === "backup" && pathExists(action.backup)) {
        renameSync(action.backup, action.destination);
      }
      if (item.kind === "managed-remove" && !pathExists(action.destination)) {
        symlinkSync(action.previousSource, action.destination, "dir");
      }
      if (item.kind === "stale-remove" && !pathExists(action.destination)) {
        symlinkSync(action.source, action.destination, "dir");
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
}

export function executeSyncPlan(plan, statePath, metadata, dryRun = false) {
  if (dryRun) return;
  const completed = [];
  try {
    for (const action of plan.actions) applyAction(action, completed);
    for (const record of plan.stale) {
      if (record.owned !== false && isRecordedLink(record)) {
        unlinkSync(record.destination);
        completed.push({ kind: "stale-remove", action: record });
      }
    }
    writeJson(statePath, {
      schema_version: 1,
      ...metadata,
      managed: plan.managed,
    });
  } catch (error) {
    const rollbackErrors = rollback(completed);
    const suffix = rollbackErrors.length
      ? `; rollback failures: ${rollbackErrors.join("; ")}`
      : "";
    fail(`Sync failed: ${error.message}${suffix}`);
  }
}

export function cleanManaged(
  statePath,
  scope,
  root,
  registry,
  context,
  dryRun = false,
) {
  const state = loadState(statePath);
  validateStateRecords(state, scope, root, registry, context);
  const results = state.managed.map((record) => ({
    ...record,
    operation: record.owned !== false && isRecordedLink(record)
      ? "remove"
      : record.owned === false
        ? "preserve-external"
        : "preserve-changed",
  }));
  if (!dryRun) {
    for (const record of results) {
      if (record.operation === "remove") unlinkSync(record.destination);
    }
    rmSync(statePath, { force: true });
  }
  return results;
}
