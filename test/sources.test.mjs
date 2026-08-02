import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  createSkill,
  executable,
  git,
  initializeGitRepository,
  invoke,
  read,
  removeRoot,
  temporaryRoot,
  testContext,
  write,
} from "./helpers.mjs";

function plugin(root, name, skillName, version) {
  write(
    join(root, ".claude-plugin/plugin.json"),
    `${JSON.stringify({ name, ...(version && { version }) }, null, 2)}\n`,
  );
  createSkill(join(root, "skills"), skillName);
}

function marketplace(root, name, plugins) {
  const value = { name, owner: { name: "Source Test" }, plugins };
  write(
    join(root, ".claude-plugin/marketplace.json"),
    `${JSON.stringify(value, null, 2)}\n`,
  );
  return value;
}

async function installFromMarket(context, root, pluginName, skillName) {
  await invoke(context, ["marketplace", "add", root]);
  await invoke(context, ["init"]);
  return invoke(context, [
    "install",
    pluginName,
    "--agent",
    "claude",
    "--skill",
    skillName,
  ]);
}

test("url Plugin source honors sha over ref and links immutable cache", async () => {
  const root = temporaryRoot("skillsenv-url-source-");
  try {
    const repository = join(root, "plugin-repo");
    plugin(repository, "git-plugin", "git-skill");
    const pinnedSha = initializeGitRepository(repository);
    write(
      join(repository, "skills/git-skill/SKILL.md"),
      "---\nname: git-skill\ndescription: changed\n---\n\n# Changed\n",
    );
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "change after pin"]);

    const marketRoot = join(root, "market");
    marketplace(marketRoot, "git-market", [
      {
        name: "git-plugin",
        source: {
          source: "url",
          url: `file://${repository}`,
          ref: "main",
          sha: pinnedSha,
        },
      },
    ]);
    const context = testContext(root);
    await installFromMarket(context, marketRoot, "git-plugin", "git-skill");

    const destination = join(context.cwd, ".claude/skills/git-skill");
    const linked = realpathSync(destination);
    assert.ok(linked.startsWith(realpathSync(context.skillsenvHome)));
    assert.doesNotMatch(read(join(linked, "SKILL.md")), /Changed/);
    const lock = read(join(context.cwd, ".skillsenv.lock"));
    assert.match(lock, new RegExp(`plugin_revision: ${pinnedSha}`));
    assert.match(lock, new RegExp(`version: ${pinnedSha}`));
    assert.match(lock, /cache_path:/);
  } finally {
    removeRoot(root);
  }
});

test("git-subdir installs only the declared Plugin subtree", async () => {
  const root = temporaryRoot("skillsenv-subdir-source-");
  try {
    const repository = join(root, "monorepo");
    plugin(join(repository, "packages/review"), "review-plugin", "review-skill");
    createSkill(join(repository, "unrelated/skills"), "unrelated-skill");
    const revision = initializeGitRepository(repository);
    const marketRoot = join(root, "market");
    marketplace(marketRoot, "subdir-market", [
      {
        name: "review-plugin",
        source: {
          source: "git-subdir",
          url: `file://${repository}`,
          path: "packages/review",
          sha: revision,
        },
      },
    ]);
    const context = testContext(root);
    await installFromMarket(
      context,
      marketRoot,
      "review-plugin",
      "review-skill",
    );
    assert.ok(lstatSync(join(context.cwd, ".claude/skills/review-skill")).isSymbolicLink());
    assert.equal(
      existsSync(join(context.cwd, ".claude/skills/unrelated-skill")),
      false,
    );
  } finally {
    removeRoot(root);
  }
});

test("github Plugin source resolves through standard Git URL semantics", async () => {
  const root = temporaryRoot("skillsenv-github-source-");
  try {
    const repository = join(root, "github-origin");
    plugin(repository, "github-plugin", "github-skill");
    const revision = initializeGitRepository(repository);
    const home = join(root, "git-home");
    mkdirSync(home, { recursive: true });
    write(
      join(home, ".gitconfig"),
      `[url "file://${repository}"]\n` +
        "\tinsteadOf = https://github.com/source-test/github-plugin.git\n",
    );

    const marketRoot = join(root, "market");
    marketplace(marketRoot, "github-market", [
      {
        name: "github-plugin",
        source: {
          source: "github",
          repo: "source-test/github-plugin",
          sha: revision,
        },
      },
    ]);
    const context = testContext(root);
    context.env.HOME = home;
    await installFromMarket(
      context,
      marketRoot,
      "github-plugin",
      "github-skill",
    );
    assert.ok(lstatSync(join(context.cwd, ".claude/skills/github-skill")).isSymbolicLink());
  } finally {
    removeRoot(root);
  }
});

test("npm Plugin source disables lifecycle scripts and caches installed Skills", async () => {
  const root = temporaryRoot("skillsenv-npm-source-");
  try {
    const fakeBin = join(root, "bin");
    const invocation = join(root, "npm-invocation.json");
    executable(
      join(fakeBin, "npm"),
      `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const prefix = args[args.indexOf("--prefix") + 1];
const packageRoot = join(prefix, "node_modules", "fixture-plugin");
if (!args.includes("--ignore-scripts") || process.env.npm_config_ignore_scripts !== "true") {
  process.exit(91);
}
mkdirSync(join(packageRoot, ".claude-plugin"), { recursive: true });
mkdirSync(join(packageRoot, "skills", "npm-skill"), { recursive: true });
writeFileSync(join(packageRoot, "package.json"), JSON.stringify({version: "7.8.9"}));
writeFileSync(join(packageRoot, ".claude-plugin", "plugin.json"), JSON.stringify({name: "npm-plugin"}));
writeFileSync(join(packageRoot, "skills", "npm-skill", "SKILL.md"), "---\\nname: npm-skill\\ndescription: npm\\n---\\n");
writeFileSync(process.env.NPM_INVOCATION, JSON.stringify({args, ignore: process.env.npm_config_ignore_scripts}));
`,
    );
    const marketRoot = join(root, "market");
    marketplace(marketRoot, "npm-market", [
      {
        name: "npm-plugin",
        source: { source: "npm", package: "fixture-plugin", version: "7.8.9" },
      },
    ]);
    const context = testContext(root);
    context.env.PATH = `${fakeBin}:${process.env.PATH}`;
    context.env.NPM_INVOCATION = invocation;
    await installFromMarket(context, marketRoot, "npm-plugin", "npm-skill");
    const called = JSON.parse(read(invocation));
    assert.equal(called.ignore, "true");
    assert.ok(called.args.includes("--ignore-scripts"));
    assert.match(read(join(context.cwd, ".skillsenv.lock")), /version: 7.8.9/);
    const destination = join(context.cwd, ".claude/skills/npm-skill");
    assert.ok(realpathSync(destination).startsWith(realpathSync(context.skillsenvHome)));
  } finally {
    removeRoot(root);
  }
});

test("remote JSON Marketplace installs remote Plugin and rejects relative source", async () => {
  const root = temporaryRoot("skillsenv-http-market-");
  const repository = join(root, "plugin-repo");
  plugin(repository, "remote-plugin", "remote-skill", "3.4.5");
  initializeGitRepository(repository);
  let currentManifest = marketplace(join(root, "unused"), "remote-market", [
    {
      name: "remote-plugin",
      source: { source: "url", url: `file://${repository}` },
    },
  ]);
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`${JSON.stringify(currentManifest)}\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const source = `http://127.0.0.1:${address.port}/marketplace.json`;
    const context = testContext(root);
    await installFromMarket(context, source, "remote-plugin", "remote-skill");
    assert.match(read(join(context.cwd, ".skillsenv.lock")), /version: 3.4.5/);

    const secondRoot = join(root, "second-project");
    currentManifest = {
      name: "relative-remote-market",
      owner: { name: "Source Test" },
      plugins: [{ name: "relative-plugin", source: "./plugin" }],
    };
    const second = testContext(root, secondRoot);
    second.env.SKILLSENV_HOME = join(root, "second-skillsenv-home");
    await invoke(second, ["marketplace", "add", source]);
    await invoke(second, ["init"]);
    await assert.rejects(
      invoke(second, [
        "install",
        "relative-plugin",
        "--agent",
        "claude",
      ]),
      /relative source in a URL-only Marketplace/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    removeRoot(root);
  }
});

test("Git-hosted Marketplace and relative Plugin have independent pins", async () => {
  const root = temporaryRoot("skillsenv-git-market-");
  try {
    const marketRepository = join(root, "market-repository");
    plugin(
      join(marketRepository, "plugins/market-plugin"),
      "market-plugin",
      "market-skill",
    );
    marketplace(marketRepository, "cloned-market", [
      { name: "market-plugin", source: "./plugins/market-plugin" },
    ]);
    const marketRevision = initializeGitRepository(marketRepository);
    const context = testContext(root);
    const source = `file://${marketRepository}#main`;
    await installFromMarket(context, source, "market-plugin", "market-skill");
    const lock = read(join(context.cwd, ".skillsenv.lock"));
    assert.match(lock, new RegExp(`marketplace_revision: ${marketRevision}`));
    assert.match(lock, /cache_path:/);
    assert.doesNotMatch(lock, /local_path:/);
    assert.ok(
      lstatSync(join(context.cwd, ".claude/skills/market-skill")).isSymbolicLink(),
    );
  } finally {
    removeRoot(root);
  }
});
