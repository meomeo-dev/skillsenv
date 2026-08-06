import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import {
  assertContract,
  commandMayUseNetwork,
  OPTIONS,
  resolveCommand,
} from "../src/cli-contract.mjs";
import {
  createMarketplace,
  createSkill,
  initializeGitRepository,
  invoke,
  removeRoot,
  temporaryRoot,
  testContext,
  write,
} from "./helpers.mjs";

const CLI = new URL("../bin/skillsenv.mjs", import.meta.url).pathname;

// Runs the real binary so exit codes and the stdout/stderr split are observed as
// a shell would see them rather than as in-process return values.
function run(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: options.cwd ?? process.cwd(),
    env: { PATH: process.env.PATH, HOME: options.home, ...options.env },
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function marketplaceWith(root, name, plugins) {
  write(
    join(root, ".claude-plugin", "marketplace.json"),
    `${JSON.stringify({ name, owner: { name: "Discovery Test" }, plugins }, null, 2)}\n`,
  );
}

async function registered(root, options = {}) {
  const market = createMarketplace(join(root, "market"), options);
  const context = testContext(root);
  await invoke(context, ["marketplace", "add", join(root, "market")]);
  return { context, market };
}

test("marketplace show lists every Plugin the Marketplace provides", async () => {
  const root = temporaryRoot("skillsenv-show-");
  try {
    const marketRoot = join(root, "market");
    createMarketplace(marketRoot);
    // A second Plugin proves the listing is not a single-entry special case.
    createSkill(join(marketRoot, "plugins", "docs-plugin", "skills"), "docs-skill");
    write(
      join(marketRoot, "plugins", "docs-plugin", ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "docs-plugin", version: "0.9.0" }, null, 2)}\n`,
    );
    marketplaceWith(marketRoot, "test-market", [
      {
        name: "quality-plugin",
        source: "./plugins/quality-plugin",
        version: "1.2.3",
        description: "Quality gates",
      },
      {
        name: "docs-plugin",
        source: "./plugins/docs-plugin",
        description: "Documentation helpers",
      },
    ]);
    const context = testContext(root);
    await invoke(context, ["marketplace", "add", marketRoot]);
    const { result, output } = await invoke(context, [
      "marketplace",
      "show",
      "test-market",
    ]);
    assert.equal(result.count, 2);
    assert.equal(output[0], "PLUGIN\tVERSION\tDESCRIPTION");
    // Sorted by name, so docs-plugin precedes quality-plugin. Its version comes
    // from plugin.json even though the Marketplace entry omits one.
    assert.equal(output[1], "docs-plugin\t0.9.0\tDocumentation helpers");
    assert.equal(output[2], "quality-plugin\t1.2.3\tQuality gates");
    assert.equal(result.data.default, true);
    assert.equal(result.data.plugins[1].source, "./plugins/quality-plugin");
  } finally {
    removeRoot(root);
  }
});

test("marketplace show --skills expands each Plugin to its Skills", async () => {
  const root = temporaryRoot("skillsenv-show-skills-");
  try {
    const { context } = await registered(root);
    const { output } = await invoke(context, [
      "marketplace",
      "show",
      "test-market",
      "--skills",
    ]);
    assert.equal(output[0], "PLUGIN\tVERSION\tDESCRIPTION");
    assert.match(output[1], /^quality-plugin\t1\.2\.3\t/);
    // Skill lines are indented under the Plugin row they belong to.
    assert.deepEqual(output.slice(2), [
      "  SKILL alpha-skill",
      "  SKILL beta-skill",
    ]);
  } finally {
    removeRoot(root);
  }
});

test("the version column agrees with what add would lock", async () => {
  const root = temporaryRoot("skillsenv-show-version-");
  try {
    // createMarketplace writes version 1.2.3 into plugin.json and leaves the
    // Marketplace entry without one, which is the case where reporting the entry
    // version alone would print "-" for a Plugin that installs as 1.2.3.
    const { context } = await registered(root);
    const { result } = await invoke(context, [
      "marketplace",
      "show",
      "test-market",
      "--output-format",
      "json",
    ]);
    assert.equal(result.data.plugins[0].version, "1.2.3");
    await invoke(context, ["init"]);
    await invoke(context, [
      "add",
      "quality-plugin",
      "--agent",
      "claude",
      "--skill",
      "alpha-skill",
    ]);
    const locked = await invoke(context, [
      "info",
      "quality-plugin",
      "--output-format",
      "json",
    ]);
    assert.equal(JSON.parse(locked.output[0]).version, "1.2.3");
  } finally {
    removeRoot(root);
  }
});

test("marketplace show emits one JSON document naming its kind", async () => {
  const root = temporaryRoot("skillsenv-show-json-");
  try {
    const { context } = await registered(root);
    const { output } = await invoke(context, [
      "marketplace",
      "show",
      "test-market",
      "--skills",
      "--output-format",
      "json",
    ]);
    assert.equal(output.length, 1);
    const payload = JSON.parse(output[0]);
    assert.equal(payload.kind, "marketplace-show");
    assert.equal(payload.marketplace, "test-market");
    assert.equal(payload.plugins.length, 1);
    assert.deepEqual(payload.plugins[0].skills, ["alpha-skill", "beta-skill"]);
    assert.equal(payload.plugins[0].skills_error, undefined);
  } finally {
    removeRoot(root);
  }
});

test("marketplace show without --skills omits the skills key entirely", async () => {
  const root = temporaryRoot("skillsenv-show-lean-");
  try {
    const { context } = await registered(root);
    const { result } = await invoke(context, [
      "marketplace",
      "show",
      "test-market",
      "--output-format",
      "json",
    ]);
    // A null would be indistinguishable from "could not be resolved".
    assert.ok(!Object.hasOwn(result.data.plugins[0], "skills"));
  } finally {
    removeRoot(root);
  }
});

test("marketplace show reports an unregistered Marketplace on stderr", () => {
  const root = temporaryRoot("skillsenv-show-missing-");
  try {
    const result = run(["marketplace", "show", "nosuch"], {
      home: join(root, "home"),
      env: { SKILLSENV_HOME: join(root, "skillsenv-home") },
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /not registered: nosuch/);
    // The message names the command that lists the valid values.
    assert.match(result.stderr, /marketplace list/);
  } finally {
    removeRoot(root);
  }
});

test("a remote Plugin source degrades to a reason instead of reaching out", async () => {
  const root = temporaryRoot("skillsenv-show-remote-");
  try {
    const repository = join(root, "plugin-repo");
    createSkill(join(repository, "skills"), "remote-skill");
    write(
      join(repository, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "remote-plugin", version: "2.0.0" }, null, 2)}\n`,
    );
    const revision = initializeGitRepository(repository);
    const marketRoot = join(root, "market");
    createMarketplace(marketRoot);
    marketplaceWith(marketRoot, "test-market", [
      { name: "quality-plugin", source: "./plugins/quality-plugin" },
      {
        name: "remote-plugin",
        source: { source: "url", url: `file://${repository}`, sha: revision },
      },
    ]);
    const context = testContext(root);
    await invoke(context, ["marketplace", "add", marketRoot]);
    const { result, output } = await invoke(context, [
      "marketplace",
      "show",
      "test-market",
      "--skills",
    ]);
    const [quality, remote] = result.data.plugins;
    assert.deepEqual(quality.skills, ["alpha-skill", "beta-skill"]);
    assert.equal(remote.skills, null);
    assert.match(remote.skills_error, /--online/);
    // A single unresolvable Plugin must not hide the ones that did resolve.
    assert.ok(output.some((line) => line === "  SKILL alpha-skill"));
    assert.ok(output.some((line) => /SKILLS unavailable: .*--online/.test(line)));
    // The same Marketplace resolves fully once egress is permitted, which is
    // what proves the flag gates the guard rather than the source being broken.
    const online = await invoke(context, [
      "marketplace",
      "show",
      "test-market",
      "--skills",
      "--online",
    ]);
    const resolved = online.result.data.plugins[1];
    assert.deepEqual(resolved.skills, ["remote-skill"]);
    assert.equal(resolved.skills_error, undefined);
    assert.equal(resolved.version, "2.0.0");
  } finally {
    removeRoot(root);
  }
});

test("--online lets the same remote Plugin resolve its Skills", async () => {
  const root = temporaryRoot("skillsenv-show-online-");
  try {
    const repository = join(root, "plugin-repo");
    createSkill(join(repository, "skills"), "remote-skill");
    write(
      join(repository, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "remote-plugin", version: "2.0.0" }, null, 2)}\n`,
    );
    const revision = initializeGitRepository(repository);
    const marketRoot = join(root, "market");
    createMarketplace(marketRoot);
    marketplaceWith(marketRoot, "test-market", [
      {
        name: "remote-plugin",
        source: { source: "url", url: `file://${repository}`, sha: revision },
      },
    ]);
    const context = testContext(root);
    await invoke(context, ["marketplace", "add", marketRoot]);
    const { result } = await invoke(context, [
      "marketplace",
      "show",
      "test-market",
      "--skills",
      "--online",
    ]);
    assert.deepEqual(result.data.plugins[0].skills, ["remote-skill"]);
    assert.equal(result.data.plugins[0].skills_error, undefined);
  } finally {
    removeRoot(root);
  }
});

test("info describes an installed Plugin from the lock", async () => {
  const root = temporaryRoot("skillsenv-info-installed-");
  try {
    const { context } = await registered(root, {
      entry: { version: "1.2.3", description: "Quality gates" },
    });
    await invoke(context, ["init"]);
    await invoke(context, [
      "add",
      "quality-plugin",
      "--agent",
      "claude",
      "--skill",
      "alpha-skill",
    ]);
    const { result, output } = await invoke(context, ["info", "quality-plugin"]);
    assert.equal(result.installed, true);
    assert.equal(result.data.version, "1.2.3");
    assert.equal(result.data.description, "Quality gates");
    assert.equal(result.data.plugin_source, "./plugins/quality-plugin");
    assert.deepEqual(result.data.skills, ["alpha-skill"]);
    assert.equal(output[0], "info quality-plugin@test-market".replace("info ", "PLUGIN "));
    assert.ok(output.includes("INSTALLED yes"));
    assert.ok(output.includes("SKILL alpha-skill"));
  } finally {
    removeRoot(root);
  }
});

test("info describes an uninstalled Plugin by discovering it", async () => {
  const root = temporaryRoot("skillsenv-info-available-");
  try {
    const { context } = await registered(root);
    const { result } = await invoke(context, ["info", "quality-plugin"]);
    assert.equal(result.installed, false);
    // Both Skills are reported, not just the ones a manifest happens to select.
    assert.deepEqual(result.data.skills, ["alpha-skill", "beta-skill"]);
    assert.equal(result.data.marketplace, "test-market");
  } finally {
    removeRoot(root);
  }
});

test("info answers from the Marketplace when no project is present", async () => {
  const root = temporaryRoot("skillsenv-info-no-project-");
  try {
    const { context } = await registered(root);
    // cwd holds no .skillsenv, which must be a fallback rather than an error.
    const { result } = await invoke(context, ["info", "quality-plugin"]);
    assert.equal(result.installed, false);
    assert.equal(result.data.scope, "project");
  } finally {
    removeRoot(root);
  }
});

test("info rejects a Plugin the Marketplace does not carry", async () => {
  const root = temporaryRoot("skillsenv-info-missing-");
  try {
    const { context } = await registered(root);
    await assert.rejects(
      () => invoke(context, ["info", "nosuch@test-market"]),
      /not present in Marketplace test-market/,
    );
  } finally {
    removeRoot(root);
  }
});

test("status lists the managed roster alongside its count", async () => {
  const root = temporaryRoot("skillsenv-status-roster-");
  try {
    const { context } = await registered(root, {
      entry: { version: "1.2.3" },
    });
    await invoke(context, ["init"]);
    await invoke(context, [
      "add",
      "quality-plugin",
      "--agent",
      "claude",
      "--skill",
      "alpha-skill",
    ]);
    const { result, output } = await invoke(context, ["status"]);
    // The count stays where it was so existing readers keep working.
    assert.equal(result.data.managed, 1);
    assert.deepEqual(result.data.managed_entries, [
      {
        plugin: "quality-plugin@test-market",
        skill: "alpha-skill",
        // `--agent claude` is an alias; the roster reports the canonical ID.
        agents: ["claude-code"],
        version: "1.2.3",
        destination: join(context.cwd, ".claude/skills/alpha-skill"),
      },
    ]);
    assert.ok(output.includes("PLUGIN\tSKILL\tAGENTS\tVERSION"));
    assert.ok(
      output.includes("quality-plugin@test-market\talpha-skill\tclaude-code\t1.2.3"),
    );
  } finally {
    removeRoot(root);
  }
});

test("status omits the roster table when nothing is managed", async () => {
  const root = temporaryRoot("skillsenv-status-empty-");
  try {
    const context = testContext(root);
    await invoke(context, ["init"]);
    const { result, output } = await invoke(context, ["status"]);
    assert.deepEqual(result.data.managed_entries, []);
    assert.ok(!output.some((line) => line.startsWith("PLUGIN\t")));
  } finally {
    removeRoot(root);
  }
});

test("a read-only command may use the network only when it opts in", () => {
  const show = resolveCommand(["marketplace", "show"]).command;
  assert.equal(commandMayUseNetwork(show, {}), false);
  assert.equal(commandMayUseNetwork(show, { online: true }), true);
  const info = resolveCommand(["info"]).command;
  assert.equal(commandMayUseNetwork(info, {}), false);
  assert.equal(commandMayUseNetwork(info, { online: true }), true);
  // A command with no opt-in stays offline no matter what is passed.
  const status = resolveCommand(["status"]).command;
  assert.equal(commandMayUseNetwork(status, { online: true }), false);
  assert.equal(commandMayUseNetwork(resolveCommand(["sync"]).command, {}), true);
});

test("the contract rejects an opt-in the command does not declare", () => {
  const base = {
    name: "probe",
    summary: "probe",
    positional: [],
    options: [],
    handler: "probe",
  };
  assert.throws(
    () => assertContract([
      { ...base, sideEffects: { writes: [], network: false, networkOptIn: "--online" } },
    ]),
    /opts into network via --online, which it does not declare/,
  );
  // Declaring both an unconditional network and an opt-in is contradictory.
  assert.throws(
    () => assertContract([
      {
        ...base,
        options: [OPTIONS.online],
        sideEffects: { writes: [], network: true, networkOptIn: "--online" },
      },
    ]),
    /declares networkOptIn but already allows network access/,
  );
  // The accepting case is the real contract, where `marketplace show` and `info`
  // both declare the opt-in; a one-command fixture cannot satisfy the unrelated
  // "every option is reachable" invariant. cli-ux.test.mjs asserts it passes.
  assert.ok(assertContract().commands > 0);
});

test("the discovery commands print help without touching the filesystem", () => {
  const root = temporaryRoot("skillsenv-discovery-help-");
  try {
    const env = { SKILLSENV_HOME: join(root, "absent") };
    for (const args of [["marketplace", "show"], ["info"]]) {
      const result = run([...args, "--help"], { home: join(root, "home"), env });
      assert.equal(result.code, 0, `${args.join(" ")} --help exited ${result.code}`);
      assert.match(result.stdout, /Usage: skillsenv/);
      assert.equal(result.stderr, "");
    }
  } finally {
    removeRoot(root);
  }
});

test("--skills and --skill stay distinct options", () => {
  const root = temporaryRoot("skillsenv-skills-distinct-");
  try {
    const options = {
      home: join(root, "home"),
      env: { SKILLSENV_HOME: join(root, "skillsenv-home") },
    };
    // The boolean must not leak onto commands that take the value option.
    const onAdd = run(["add", "plugin@market", "--skills"], options);
    assert.equal(onAdd.code, 2);
    assert.match(onAdd.stderr, /--skills does not apply to skillsenv add/);
    const onShow = run(["marketplace", "show", "market", "--skill", "x"], options);
    assert.equal(onShow.code, 2);
    assert.match(onShow.stderr, /--skill does not apply/);
  } finally {
    removeRoot(root);
  }
});
