import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  createMarketplace,
  createSkill,
  git,
  initializeGitRepository,
  invoke,
  read,
  removeRoot,
  temporaryRoot,
  testContext,
  write,
} from "./helpers.mjs";

function dependency(plugin, skill) {
  return [
    `    - plugin: ${plugin}@team-market`,
    "      agents: [claude-code]",
    `      skills: [${skill}]`,
  ].join("\n");
}

function createGroupedMarketplace(root) {
  const definitions = [
    ["core-plugin", "core-skill"],
    ["test-plugin", "test-skill"],
    ["dev-plugin", "dev-skill"],
  ];
  const plugins = [];
  for (const [plugin, skill] of definitions) {
    const pluginRoot = join(root, "plugins", plugin);
    write(
      join(pluginRoot, ".claude-plugin/plugin.json"),
      `${JSON.stringify({ name: plugin, version: "1.0.0" }, null, 2)}\n`,
    );
    createSkill(join(pluginRoot, "skills"), skill);
    plugins.push({ name: plugin, source: `./plugins/${plugin}` });
  }
  write(
    join(root, ".claude-plugin/marketplace.json"),
    `${JSON.stringify({
      name: "team-market",
      owner: { name: "Skillsenv Test" },
      plugins,
    }, null, 2)}\n`,
  );
}

function groupedManifest() {
  return [
    "schema_version: 1",
    "marketplaces:",
    "  team-market:",
    "    source: ./plugin-marketplace",
    "dependencies:",
    dependency("core-plugin", "core-skill").replace(/^    /gm, "  "),
    "dependency_groups:",
    "  test:",
    dependency("test-plugin", "test-skill"),
    "  development:",
    dependency("dev-plugin", "dev-skill"),
    "",
  ].join("\n");
}

function skillLink(context, name) {
  return join(context.cwd, ".claude", "skills", name);
}

test("project Marketplace source resolves without user registration", async () => {
  const root = temporaryRoot();
  try {
    const context = testContext(root);
    const marketplaceRoot = join(context.cwd, "plugin-marketplace");
    createMarketplace(marketplaceRoot, {
      name: "team-market",
      pluginName: "core-plugin",
      skills: ["core-skill"],
    });
    write(
      join(
        marketplaceRoot,
        "plugins/core-plugin/.claude-plugin/plugin.json",
      ),
      `${JSON.stringify({ name: "core-plugin" }, null, 2)}\n`,
    );
    write(
      join(context.cwd, ".skillsenv"),
      [
        "schema_version: 1",
        "marketplaces:",
        "  team-market:",
        "    source: ./plugin-marketplace",
        "dependencies:",
        "  - plugin: core-plugin@team-market",
        "    agents: [claude-code]",
        "    skills: [core-skill]",
        "",
      ].join("\n"),
    );
    initializeGitRepository(context.cwd);

    await invoke(context, ["sync"]);
    const lockPath = join(context.cwd, ".skillsenv.lock");
    const lock = read(lockPath);
    assert.match(lock, /type: project-local/);
    assert.match(lock, /path: \.\/plugin-marketplace/);
    assert.match(lock, /cache_path:/);
    assert.doesNotMatch(lock, /local_path:/);
    assert.equal(lock.includes(root), false);
    assert.ok(realpathSync(skillLink(context, "core-skill")).startsWith(
      realpathSync(context.skillsenvHome),
    ));
    const lockBeforeProjectCommit = read(lockPath);
    git(context.cwd, ["add", ".skillsenv.lock"]);
    git(context.cwd, ["commit", "-m", "commit generated lock"]);
    await invoke(context, ["sync"]);
    assert.equal(read(lockPath), lockBeforeProjectCommit);

    await invoke(context, ["trust"]);
    removeRoot(marketplaceRoot);
    const frozen = await invoke(context, ["sync", "--frozen"]);
    assert.equal(frozen.result.plan.actions[0].operation, "idempotent");
    const activated = await invoke(context, ["activate"]);
    assert.equal(activated.result.active, true);
  } finally {
    removeRoot(root);
  }
});

test(
  "project Marketplace declaration overrides the same user registration",
  async () => {
  const root = temporaryRoot();
  try {
    const context = testContext(root);
    const userMarket = join(root, "user-market");
    const projectMarket = join(context.cwd, "plugin-marketplace");
    createMarketplace(userMarket, {
      name: "team-market",
      pluginName: "quality-plugin",
      skills: ["user-skill"],
    });
    createMarketplace(projectMarket, {
      name: "team-market",
      pluginName: "quality-plugin",
      skills: ["project-skill"],
    });
    await invoke(context, ["marketplace", "add", userMarket]);
    write(
      join(context.cwd, ".skillsenv"),
      [
        "schema_version: 1",
        "marketplaces:",
        "  team-market:",
        "    source: ./plugin-marketplace",
        "dependencies:",
        "  - plugin: quality-plugin@team-market",
        "    agents: [claude-code]",
        "    skills: [project-skill]",
        "",
      ].join("\n"),
    );

    await invoke(context, ["sync"]);
    assert.ok(lstatSync(skillLink(context, "project-skill")).isSymbolicLink());
    assert.equal(existsSync(skillLink(context, "user-skill")), false);
  } finally {
    removeRoot(root);
  }
  },
);

test("project Marketplace local source cannot escape the project", async () => {
  const root = temporaryRoot();
  try {
    const context = testContext(root);
    const outside = join(root, "outside-market");
    createMarketplace(outside, {
      name: "team-market",
      pluginName: "quality-plugin",
    });
    const escaped = [
      "schema_version: 1",
      "marketplaces:",
      "  team-market:",
      "    source: ./../outside-market",
      "dependencies:",
      "  - plugin: quality-plugin@team-market",
      "    agents: [claude-code]",
      "",
    ].join("\n");
    write(join(context.cwd, ".skillsenv"), escaped);
    await assert.rejects(invoke(context, ["sync"]), /escapes its root/);

    write(
      join(context.cwd, ".skillsenv"),
      escaped.replace("./../outside-market", outside),
    );
    await assert.rejects(invoke(context, ["sync"]), /must be relative/);

    const linkedSource = join(context.cwd, "linked-market");
    symlinkSync(outside, linkedSource, "dir");
    write(
      join(context.cwd, ".skillsenv"),
      escaped.replace("./../outside-market", "./linked-market"),
    );
    await assert.rejects(invoke(context, ["sync"]), /resolves outside its root/);
  } finally {
    removeRoot(root);
  }
});

test(
  "dependency groups select visibility without changing the shared lock",
  async () => {
  const root = temporaryRoot();
  try {
    const context = testContext(root);
    createGroupedMarketplace(join(context.cwd, "plugin-marketplace"));
    write(join(context.cwd, ".skillsenv"), groupedManifest());

    await invoke(context, ["sync"]);
    const lockPath = join(context.cwd, ".skillsenv.lock");
    const sharedLock = read(lockPath);
    assert.match(sharedLock, /dependency_group: test/);
    assert.match(sharedLock, /dependency_group: development/);
    assert.ok(existsSync(skillLink(context, "core-skill")));
    assert.equal(existsSync(skillLink(context, "test-skill")), false);
    assert.equal(existsSync(skillLink(context, "dev-skill")), false);

    await invoke(context, ["sync", "--group", "test"]);
    assert.ok(existsSync(skillLink(context, "core-skill")));
    assert.ok(existsSync(skillLink(context, "test-skill")));
    assert.equal(existsSync(skillLink(context, "dev-skill")), false);
    assert.equal(read(lockPath), sharedLock);

    await invoke(context, [
      "sync",
      "--group",
      "test",
      "--group",
      "development",
    ]);
    assert.ok(existsSync(skillLink(context, "test-skill")));
    assert.ok(existsSync(skillLink(context, "dev-skill")));
    assert.equal(read(lockPath), sharedLock);

    await invoke(context, ["sync", "--all-groups"]);
    assert.ok(existsSync(skillLink(context, "core-skill")));
    assert.ok(existsSync(skillLink(context, "test-skill")));
    assert.ok(existsSync(skillLink(context, "dev-skill")));
    assert.equal(read(lockPath), sharedLock);

    removeRoot(join(context.cwd, "plugin-marketplace"));
    await invoke(context, ["sync", "--frozen", "--group", "test"]);
    assert.ok(existsSync(skillLink(context, "core-skill")));
    assert.ok(existsSync(skillLink(context, "test-skill")));
    assert.equal(existsSync(skillLink(context, "dev-skill")), false);
    assert.equal(read(lockPath), sharedLock);
  } finally {
    removeRoot(root);
  }
  },
);

test(
  "activation restores local group selection and preserves personal Skills",
  async () => {
  const root = temporaryRoot();
  try {
    const context = testContext(root);
    createGroupedMarketplace(join(context.cwd, "plugin-marketplace"));
    write(join(context.cwd, ".skillsenv"), groupedManifest());
    const personal = skillLink(context, "personal-skill");
    mkdirSync(personal, { recursive: true });
    write(join(personal, "SKILL.md"), "personal\n");

    await invoke(context, ["sync", "--group", "test"]);
    await invoke(context, ["trust"]);
    const testSkill = skillLink(context, "test-skill");
    unlinkSync(testSkill);
    assert.equal(existsSync(testSkill), false);
    await invoke(context, ["activate"]);

    assert.ok(lstatSync(testSkill).isSymbolicLink());
    assert.equal(read(join(personal, "SKILL.md")), "personal\n");
    const status = await invoke(context, ["status"]);
    assert.ok(status.output.includes("GROUPS test"));
  } finally {
    removeRoot(root);
  }
  },
);

test("unknown, conflicting, and duplicate dependency groups fail fast", async () => {
  const root = temporaryRoot();
  try {
    const context = testContext(root);
    createGroupedMarketplace(join(context.cwd, "plugin-marketplace"));
    write(join(context.cwd, ".skillsenv"), groupedManifest());
    await assert.rejects(
      invoke(context, ["sync", "--group", "missing"]),
      /Unknown dependency group: missing/,
    );
    await assert.rejects(
      invoke(context, ["sync", "--group", "test", "--all-groups"]),
      /--group and --all-groups are mutually exclusive/,
    );

    write(
      join(context.cwd, ".skillsenv"),
      groupedManifest().replace(
        "    - plugin: test-plugin@team-market",
        "    - plugin: core-plugin@team-market",
      ),
    );
    await assert.rejects(
      invoke(context, ["sync"]),
      /duplicate Plugin across dependencies and groups: core-plugin@team-market/,
    );
  } finally {
    removeRoot(root);
  }
});
