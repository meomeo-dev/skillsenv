import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fail } from "./errors.mjs";
import { readYaml, safeRelative } from "./io.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY = resolve(MODULE_DIR, "../config/agent-paths.yaml");

export function loadAgentRegistry(path = DEFAULT_REGISTRY) {
  const registry = readYaml(path, "Agent path registry");
  if (registry.schema_version !== 1 || !registry.roots || !registry.agents) {
    fail("Agent path registry requires schema_version: 1, roots, and agents");
  }
  const aliases = new Map();
  for (const [id, agent] of Object.entries(registry.agents)) {
    validateAgent(id, agent, registry.roots, aliases, registry.agents);
  }
  const upstreamCount = Object.values(registry.agents).filter(
    (agent) => agent.origin !== "openai-official",
  ).length;
  if (upstreamCount !== registry.source?.upstream_agent_count) {
    fail("Agent registry count differs from its recorded upstream source");
  }
  return { ...registry, aliases };
}

function validateAgent(id, agent, roots, aliases, agents) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) fail(`Invalid Agent ID: ${id}`);
  if (!agent || typeof agent.display_name !== "string") {
    fail(`Agent ${id} requires display_name`);
  }
  safeRelative("/registry", agent.project_dir, `Agent ${id} project_dir`, {
    allowBare: true,
  });
  if (agent.user_dir !== null) {
    if (!agent.user_dir || !roots[agent.user_dir.root]) {
      fail(`Agent ${id} references an unknown user root`);
    }
    safeRelative("/registry", agent.user_dir.path, `Agent ${id} user_dir`, {
      allowBare: true,
    });
  }
  for (const alias of agent.aliases ?? []) {
    if (aliases.has(alias) || agents[alias] || alias === "all") {
      fail(`Duplicate or reserved Agent alias: ${alias}`);
    }
    aliases.set(alias, id);
  }
}

function resolveRoot(rootId, registry, context, active = new Set()) {
  if (active.has(rootId)) fail(`Agent registry root cycle at ${rootId}`);
  const root = registry.roots[rootId];
  if (!root) fail(`Unknown Agent registry root: ${rootId}`);
  if (root.kind === "home") return context.homeDir;

  const nextActive = new Set(active).add(rootId);
  const configured = root.env ? context.env[root.env]?.trim() : undefined;
  if (configured) {
    if (!isAbsolute(configured)) fail(`${root.env} must be an absolute path`);
    return resolve(configured);
  }
  if (root.fallback) {
    return join(
      resolveRoot(root.fallback.root, registry, context, nextActive),
      root.fallback.path,
    );
  }
  if (root.candidates) {
    const candidates = root.candidates.map((candidate) =>
      join(
        resolveRoot(candidate.root, registry, context, nextActive),
        candidate.path,
      ),
    );
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  }
  fail(`Agent registry root ${rootId} has no resolution strategy`);
}

export function selectAgents(values, scope, registry) {
  if (!Array.isArray(values) || values.length === 0) {
    fail("Select at least one Agent with --agent");
  }
  if (values.includes("all")) {
    if (values.length !== 1) fail("Use --agent all by itself");
    return Object.entries(registry.agents)
      .filter(([, agent]) => agent.include_in_all !== false)
      .filter(([, agent]) => scope === "project" || agent.user_dir !== null)
      .map(([id]) => id);
  }
  const selected = [];
  for (const value of values) {
    const id = registry.agents[value] ? value : registry.aliases.get(value);
    if (!id) fail(`Unknown Agent: ${value}; run skillsenv agents`);
    if (scope === "user" && registry.agents[id].user_dir === null) {
      fail(`Agent ${id} does not support user-scope installation`);
    }
    if (!selected.includes(id)) selected.push(id);
  }
  return selected;
}

export function targetGroups(agentIds, scope, root, registry, options = {}) {
  const context = {
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? homedir(),
  };
  const targets = new Map();
  for (const id of agentIds) {
    const agent = registry.agents[id];
    const targetDir = scope === "project"
      ? join(root, agent.project_dir)
      : join(resolveRoot(agent.user_dir.root, registry, context), agent.user_dir.path);
    const existing = targets.get(targetDir);
    if (existing) existing.agents.push(id);
    else targets.set(targetDir, { targetDir, agents: [id] });
  }
  return [...targets.values()];
}

export function resolvedAgentRows(registry, options = {}) {
  const context = {
    env: options.env ?? process.env,
    homeDir: options.homeDir ?? homedir(),
  };
  return Object.entries(registry.agents).map(([id, agent]) => ({
    id,
    displayName: agent.display_name,
    projectDir: agent.project_dir,
    userDir: agent.user_dir === null
      ? null
      : join(resolveRoot(agent.user_dir.root, registry, context), agent.user_dir.path),
  }));
}
