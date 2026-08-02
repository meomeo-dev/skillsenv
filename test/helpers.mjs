import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runCli } from "../src/commands.mjs";

export function temporaryRoot(prefix = "skillsenv-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

export function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function executable(path, content) {
  write(path, content);
  chmodSync(path, 0o755);
}

export function read(path) {
  return readFileSync(path, "utf8");
}

export function createSkill(root, name, extra = {}) {
  const directory = join(root, name);
  write(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} test skill\n---\n\n# ${name}\n`,
  );
  for (const [path, content] of Object.entries(extra)) {
    write(join(directory, path), content);
  }
  return directory;
}

export function createMarketplace(root, options = {}) {
  const name = options.name ?? "test-market";
  const pluginName = options.pluginName ?? "quality-plugin";
  const pluginRoot = join(root, "plugins", pluginName);
  const skills = options.skills ?? ["alpha-skill", "beta-skill"];
  write(
    join(pluginRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: pluginName, version: "1.2.3" }, null, 2)}\n`,
  );
  for (const skill of skills) createSkill(join(pluginRoot, "skills"), skill);
  const entry = {
    name: pluginName,
    source: `./plugins/${pluginName}`,
    ...(options.entry ?? {}),
  };
  const manifest = {
    name,
    owner: { name: "Skillsenv Test" },
    plugins: [entry],
  };
  write(
    join(root, ".claude-plugin", "marketplace.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { name, pluginName, pluginRoot, skills, manifest };
}

export function testContext(root, cwd = join(root, "project")) {
  const homeDir = join(root, "home");
  const skillsenvHome = join(root, "skillsenv-home");
  mkdirSync(cwd, { recursive: true });
  const output = [];
  return {
    cwd,
    homeDir,
    env: {
      PATH: process.env.PATH,
      SKILLSENV_HOME: skillsenvHome,
      CLAUDE_CONFIG_DIR: join(homeDir, ".claude"),
      CODEX_HOME: join(homeDir, ".codex"),
      XDG_CONFIG_HOME: join(homeDir, ".config"),
    },
    write: (line) => output.push(line),
    output,
    skillsenvHome,
  };
}

export async function invoke(context, args) {
  context.output.length = 0;
  const result = await runCli(args, context);
  return { result, output: [...context.output] };
}

export function git(root, args) {
  const env = { ...process.env };
  delete env.GIT_CONFIG_COUNT;
  delete env.GIT_CONFIG_KEY_0;
  delete env.GIT_CONFIG_VALUE_0;
  const result = spawnSync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout).trim());
  }
  return result.stdout.trim();
}

export function initializeGitRepository(root, message = "initial") {
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Skillsenv Test"]);
  git(root, ["config", "user.email", "skillsenv@example.test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}
