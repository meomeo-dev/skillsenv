import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { findProject } from "../src/manifest.mjs";
import {
  createMarketplace,
  invoke,
  read,
  removeRoot,
  temporaryRoot,
  testContext,
  write,
} from "./helpers.mjs";

async function setupEnvironment() {
  const root = temporaryRoot();
  const marketRoot = join(root, "market");
  const marketplace = createMarketplace(marketRoot);
  const context = testContext(root);
  await invoke(context, ["marketplace", "add", marketRoot]);
  await invoke(context, ["init"]);
  return { root, marketRoot, marketplace, context };
}

test("local Marketplace install filters Skills and links canonical sources", async () => {
  const fixture = await setupEnvironment();
  try {
    const { context, marketplace } = fixture;
    const { result } = await invoke(context, [
      "install",
      marketplace.pluginName,
      "--agent",
      "claude,codex,cursor",
      "--skill",
      "alpha-skill",
    ]);

    assert.equal(result.plan.actions.length, 2);
    const claudeLink = join(context.cwd, ".claude/skills/alpha-skill");
    const sharedLink = join(context.cwd, ".agents/skills/alpha-skill");
    assert.ok(lstatSync(claudeLink).isSymbolicLink());
    assert.ok(lstatSync(sharedLink).isSymbolicLink());
    assert.equal(
      realpathSync(claudeLink),
      realpathSync(
        join(fixture.marketRoot, "plugins/quality-plugin/skills/alpha-skill"),
      ),
    );
    assert.equal(existsSync(join(context.cwd, ".claude/skills/beta-skill")), false);
    assert.match(read(join(context.cwd, ".skillsenv")), /quality-plugin@test-market/);
    const lock = read(join(context.cwd, ".skillsenv.lock"));
    assert.match(lock, /local_path:/);
    assert.doesNotMatch(lock, /cache_path:/);

    const second = await invoke(context, ["sync", "--frozen"]);
    assert.ok(second.result.plan.actions.every((action) =>
      action.operation === "idempotent"));
  } finally {
    removeRoot(fixture.root);
  }
});

test("nearest parent manifest defines the project environment", async () => {
  const root = temporaryRoot();
  try {
    const outer = join(root, "outer");
    const inner = join(outer, "packages/inner");
    const child = join(inner, "src/deep");
    mkdirSync(child, { recursive: true });
    write(join(outer, ".skillsenv"), "schema_version: 1\ndependencies: []\n");
    write(join(inner, ".skillsenv"), "schema_version: 1\ndependencies: []\n");
    assert.equal(findProject(child).root, inner);
  } finally {
    removeRoot(root);
  }
});

test("activation is refused until the exact manifest and lock are trusted", async () => {
  const fixture = await setupEnvironment();
  try {
    const { context, marketplace } = fixture;
    await invoke(context, [
      "install",
      marketplace.pluginName,
      "--agent",
      "claude",
      "--skill",
      "alpha-skill",
    ]);
    await assert.rejects(
      invoke(context, ["activate"]),
      /Project activation refused: project is not trusted/,
    );
    await invoke(context, ["trust"]);
    const activated = await invoke(context, ["activate"]);
    assert.equal(activated.result.active, true);

    const manifestPath = join(context.cwd, ".skillsenv");
    const changedManifest = read(manifestPath).replace("alpha-skill", "beta-skill");
    assert.notEqual(changedManifest, read(manifestPath));
    write(manifestPath, changedManifest);
    await assert.rejects(invoke(context, ["activate"]), /lock is stale/);
  } finally {
    removeRoot(fixture.root);
  }
});

test("dry-run preflights without writing manifest, lock, cache, or links", async () => {
  const fixture = await setupEnvironment();
  try {
    const before = read(join(fixture.context.cwd, ".skillsenv"));
    const { output } = await invoke(fixture.context, [
      "install",
      fixture.marketplace.pluginName,
      "--agent",
      "claude",
      "--skill",
      "alpha-skill",
      "--dry-run",
    ]);
    assert.equal(read(join(fixture.context.cwd, ".skillsenv")), before);
    assert.equal(existsSync(join(fixture.context.cwd, ".skillsenv.lock")), false);
    assert.equal(
      existsSync(join(fixture.context.cwd, ".claude/skills/alpha-skill")),
      false,
    );
    assert.ok(output.some((line) => line.startsWith("DRY-RUN CREATE")));
  } finally {
    removeRoot(fixture.root);
  }
});

test("conflicts fail as a batch and --replace creates a recoverable backup", async () => {
  const fixture = await setupEnvironment();
  try {
    const claudeDestination = join(
      fixture.context.cwd,
      ".claude/skills/alpha-skill",
    );
    write(claudeDestination, "keep me\n");
    await assert.rejects(
      invoke(fixture.context, [
        "install",
        fixture.marketplace.pluginName,
        "--agent",
        "claude,codex",
        "--skill",
        "alpha-skill",
      ]),
      /Refusing to replace existing entry/,
    );
    assert.equal(
      existsSync(join(fixture.context.cwd, ".agents/skills/alpha-skill")),
      false,
    );
    assert.equal(read(claudeDestination), "keep me\n");

    const replaced = await invoke(fixture.context, [
      "install",
      fixture.marketplace.pluginName,
      "--agent",
      "claude,codex",
      "--skill",
      "alpha-skill",
      "--replace",
    ]);
    const action = replaced.result.plan.actions.find(
      (candidate) => candidate.destination === claudeDestination,
    );
    assert.ok(lstatSync(claudeDestination).isSymbolicLink());
    assert.equal(read(action.backup), "keep me\n");
  } finally {
    removeRoot(fixture.root);
  }
});

test("clean removes only unchanged managed links", async () => {
  const fixture = await setupEnvironment();
  try {
    await invoke(fixture.context, [
      "install",
      fixture.marketplace.pluginName,
      "--agent",
      "claude,codex",
      "--skill",
      "alpha-skill",
    ]);
    const claudeLink = join(fixture.context.cwd, ".claude/skills/alpha-skill");
    const sharedLink = join(fixture.context.cwd, ".agents/skills/alpha-skill");
    assert.ok(lstatSync(sharedLink).isSymbolicLink());
    unlinkSync(claudeLink);
    write(claudeLink, "user replacement\n");

    const cleaned = await invoke(fixture.context, ["clean"]);
    assert.equal(read(claudeLink), "user replacement\n");
    assert.equal(existsSync(sharedLink), false);
    assert.ok(cleaned.result.results.some((record) =>
      record.operation === "preserve-changed"));
  } finally {
    removeRoot(fixture.root);
  }
});

test("pre-existing compatible links are reused without taking ownership", async () => {
  const fixture = await setupEnvironment();
  try {
    const source = join(
      fixture.marketRoot,
      "plugins/quality-plugin/skills/alpha-skill",
    );
    const destination = join(
      fixture.context.cwd,
      ".claude/skills/alpha-skill",
    );
    mkdirSync(join(fixture.context.cwd, ".claude/skills"), { recursive: true });
    symlinkSync(source, destination, "dir");

    const installed = await invoke(fixture.context, [
      "install",
      fixture.marketplace.pluginName,
      "--agent",
      "claude",
      "--skill",
      "alpha-skill",
    ]);
    assert.equal(installed.result.plan.actions[0].operation, "compatible");
    await invoke(fixture.context, ["clean"]);
    assert.ok(lstatSync(destination).isSymbolicLink());
    assert.equal(realpathSync(destination), realpathSync(source));
  } finally {
    removeRoot(fixture.root);
  }
});

test("user scope honors Agent home overrides and uninstall removes owned links", async () => {
  const root = temporaryRoot();
  try {
    const marketRoot = join(root, "market");
    const marketplace = createMarketplace(marketRoot);
    const context = testContext(root);
    await invoke(context, ["marketplace", "add", marketRoot]);

    await invoke(context, [
      "install",
      marketplace.pluginName,
      "--scope",
      "user",
      "--agent",
      "claude,codex",
      "--skill",
      "alpha-skill",
    ]);
    const claudeLink = join(
      context.env.CLAUDE_CONFIG_DIR,
      "skills/alpha-skill",
    );
    const codexLink = join(context.env.CODEX_HOME, "skills/alpha-skill");
    assert.ok(lstatSync(claudeLink).isSymbolicLink());
    assert.ok(lstatSync(codexLink).isSymbolicLink());
    assert.match(
      read(join(context.skillsenvHome, "user.yaml")),
      /quality-plugin@test-market/,
    );

    await invoke(context, [
      "uninstall",
      `${marketplace.pluginName}@${marketplace.name}`,
      "--scope",
      "user",
    ]);
    assert.equal(existsSync(claudeLink), false);
    assert.equal(existsSync(codexLink), false);
  } finally {
    removeRoot(root);
  }
});

test("link failure rolls back links, manifest, and lock", async () => {
  const fixture = await setupEnvironment();
  try {
    const manifestPath = join(fixture.context.cwd, ".skillsenv");
    const originalManifest = read(manifestPath);
    write(join(fixture.context.cwd, ".agents"), "blocks target directory\n");

    await assert.rejects(
      invoke(fixture.context, [
        "install",
        fixture.marketplace.pluginName,
        "--agent",
        "claude,codex",
        "--skill",
        "alpha-skill",
      ]),
      /ENOTDIR/,
    );
    assert.equal(read(manifestPath), originalManifest);
    assert.equal(existsSync(join(fixture.context.cwd, ".skillsenv.lock")), false);
    assert.equal(
      existsSync(join(fixture.context.cwd, ".claude/skills/alpha-skill")),
      false,
    );
    assert.equal(read(join(fixture.context.cwd, ".agents")), "blocks target directory\n");
  } finally {
    removeRoot(fixture.root);
  }
});
