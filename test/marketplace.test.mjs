import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { loadAgentRegistry } from "../src/agent-paths.mjs";
import { parseMarketplaceSource } from "../src/marketplace.mjs";
import { discoverPluginSkills } from "../src/skill-discovery.mjs";
import {
  createMarketplace,
  invoke,
  read,
  removeRoot,
  temporaryRoot,
  testContext,
  write,
} from "./helpers.mjs";

test("Marketplace source parser distinguishes local, GitHub, Git URL, and JSON URL", () => {
  const root = temporaryRoot();
  try {
    mkdirSync(join(root, "local"));
    assert.equal(parseMarketplaceSource("./local", root).type, "local");
    assert.deepEqual(parseMarketplaceSource("owner/repo@stable", root), {
      type: "github",
      repo: "owner/repo",
      ref: "stable",
    });
    assert.deepEqual(
      parseMarketplaceSource("https://gitlab.test/team/plugins.git#v1", root),
      {
        type: "git",
        url: "https://gitlab.test/team/plugins.git",
        ref: "v1",
      },
    );
    assert.equal(
      parseMarketplaceSource("https://example.test/marketplace.json", root).type,
      "remote-json",
    );
  } finally {
    removeRoot(root);
  }
});

test("Agent registry preserves all audited upstream targets and compatibility aliases", () => {
  const registry = loadAgentRegistry();
  const upstream = Object.values(registry.agents).filter(
    (agent) => agent.origin !== "openai-official",
  );
  assert.equal(upstream.length, 76);
  assert.equal(registry.aliases.get("claude"), "claude-code");
  assert.equal(registry.aliases.get("codex-official"), "codex-universal");
});

test("Skill-only projection rejects executable Plugin components", () => {
  const root = temporaryRoot();
  try {
    const fixture = createMarketplace(root, {
      entry: { hooks: { SessionStart: [] }, commands: ["./commands/review.md"] },
    });
    write(join(fixture.pluginRoot, "commands/review.md"), "# Review\n");
    assert.throws(
      () => discoverPluginSkills(fixture.manifest.plugins[0], fixture.pluginRoot),
      /not Skill-only; unsupported components/,
    );
  } finally {
    removeRoot(root);
  }
});

test("strict false uses Marketplace-declared Skill paths without plugin.json", () => {
  const root = temporaryRoot();
  try {
    const pluginRoot = join(root, "plugin");
    write(
      join(pluginRoot, "curated/review/SKILL.md"),
      "---\nname: review\ndescription: curated\n---\n\n# Review\n",
    );
    const result = discoverPluginSkills(
      {
        name: "curated-plugin",
        source: "./plugin",
        strict: false,
        skills: ["./curated/review"],
      },
      pluginRoot,
    );
    assert.deepEqual(result.skills.map((skill) => skill.name), ["review"]);
  } finally {
    removeRoot(root);
  }
});

test("strict false rejects component declarations from plugin.json", () => {
  const root = temporaryRoot();
  try {
    const pluginRoot = join(root, "plugin");
    write(
      join(pluginRoot, ".claude-plugin/plugin.json"),
      `${JSON.stringify({
        name: "curated-plugin",
        skills: ["./skills/review"],
      })}\n`,
    );
    write(
      join(pluginRoot, "skills/review/SKILL.md"),
      "---\nname: review\ndescription: review\n---\n",
    );
    assert.throws(
      () => discoverPluginSkills(
        {
          name: "curated-plugin",
          source: "./plugin",
          strict: false,
          skills: ["./skills/review"],
        },
        pluginRoot,
      ),
      /plugin.json also declares components: plugin.json.skills/,
    );
  } finally {
    removeRoot(root);
  }
});

test("changed local Marketplace requires explicit update before resolution", async () => {
  const root = temporaryRoot();
  try {
    const marketRoot = join(root, "market");
    const fixture = createMarketplace(marketRoot);
    const context = testContext(root);
    await invoke(context, ["marketplace", "add", marketRoot]);
    await invoke(context, ["init"]);
    const marketplacePath = join(marketRoot, ".claude-plugin/marketplace.json");
    write(marketplacePath, read(marketplacePath).replace("Skillsenv Test", "Changed"));

    await assert.rejects(
      invoke(context, [
        "install",
        fixture.pluginName,
        "--agent",
        "claude",
      ]),
      /Marketplace test-market changed; run skillsenv marketplace update/,
    );
    await invoke(context, ["marketplace", "update", fixture.name]);
    await invoke(context, [
      "install",
      fixture.pluginName,
      "--agent",
      "claude",
    ]);
    assert.ok(existsSync(join(context.cwd, ".claude/skills/alpha-skill")));
  } finally {
    removeRoot(root);
  }
});

test("shell hooks call only cache-only trust-gated activate", async () => {
  const root = temporaryRoot();
  try {
    const context = testContext(root);
    for (const shell of ["bash", "zsh", "fish"]) {
      const { output } = await invoke(context, ["shell-init", shell]);
      const text = output.join("\n");
      assert.match(text, /skillsenv activate --quiet/);
      assert.doesNotMatch(text, /skillsenv (sync|lock|marketplace)/);
    }
  } finally {
    removeRoot(root);
  }
});

test("relative source path escape is rejected", async () => {
  const root = temporaryRoot();
  try {
    const marketRoot = join(root, "market");
    createMarketplace(marketRoot);
    const manifestPath = join(marketRoot, ".claude-plugin/marketplace.json");
    const manifest = JSON.parse(read(manifestPath));
    manifest.plugins[0].source = "../outside";
    write(manifestPath, `${JSON.stringify(manifest)}\n`);
    const context = testContext(root);
    await assert.rejects(
      invoke(context, ["marketplace", "add", marketRoot]),
      /relative source must start with \./,
    );
  } finally {
    removeRoot(root);
  }
});

test("version command matches the package release", async () => {
  const root = temporaryRoot();
  try {
    const context = testContext(root);
    const { result, output } = await invoke(context, ["--version"]);
    assert.equal(result.version, "0.1.0");
    assert.deepEqual(output, ["0.1.0"]);
  } finally {
    removeRoot(root);
  }
});

test("Marketplace default selection and removal do not rewrite dependencies", async () => {
  const root = temporaryRoot();
  try {
    const firstRoot = join(root, "first-market");
    const secondRoot = join(root, "second-market");
    createMarketplace(firstRoot, { name: "first-market" });
    createMarketplace(secondRoot, { name: "second-market" });
    const context = testContext(root);
    await invoke(context, ["marketplace", "add", firstRoot]);
    await invoke(context, ["marketplace", "add", secondRoot]);
    const listed = await invoke(context, ["marketplace", "list"]);
    assert.equal(listed.result.count, 2);

    await invoke(context, ["marketplace", "use", "second-market"]);
    await invoke(context, ["init"]);
    await invoke(context, [
      "install",
      "quality-plugin",
      "--agent",
      "claude",
      "--skill",
      "alpha-skill",
    ]);
    const manifestPath = join(context.cwd, ".skillsenv");
    assert.match(read(manifestPath), /quality-plugin@second-market/);

    await invoke(context, ["marketplace", "use", "first-market"]);
    assert.match(read(manifestPath), /quality-plugin@second-market/);
    await invoke(context, ["marketplace", "remove", "first-market"]);
    const after = await invoke(context, ["marketplace", "list"]);
    assert.equal(after.result.count, 1);
    assert.ok(after.output.some((line) => line.includes("second-market")));
  } finally {
    removeRoot(root);
  }
});
