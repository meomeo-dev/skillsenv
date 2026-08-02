import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  assertContract,
  COMMANDS,
  OPTIONS,
  resolveCommand,
} from "../src/cli-contract.mjs";
import { ENVIRONMENT_HANDLERS } from "../src/environment-commands.mjs";
import { MARKETPLACE_HANDLERS } from "../src/marketplace-commands.mjs";
import { parseCli } from "../src/cli-parser.mjs";
import { renderHelp } from "../src/cli-help.mjs";
import {
  invoke,
  removeRoot,
  temporaryRoot,
  testContext,
  write,
} from "./helpers.mjs";

const CLI = new URL("../bin/skillsenv.mjs", import.meta.url).pathname;

// Runs the real binary so exit codes and the stdout/stderr split are observed as
// a shell or CI job would see them, not as in-process return values.
function run(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: options.cwd ?? process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: options.home ?? process.env.HOME,
      ...options.env,
    },
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function walk(commands, visit, trail = []) {
  for (const command of commands) {
    const path = [...trail, command.name];
    visit(command, path);
    if (command.subcommands) walk(command.subcommands, visit, path);
  }
}

test("contract is internally consistent", () => {
  const summary = assertContract();
  assert.ok(summary.commands > 0);
  assert.ok(summary.options > 0);
});

// help and version are answered by runCli before dispatch, so they have no
// entry in the handler maps.
const BUILT_IN_HANDLERS = new Set(["help", "version"]);

test("every leaf command in the contract has a handler", () => {
  const known = { ...ENVIRONMENT_HANDLERS, ...MARKETPLACE_HANDLERS };
  walk(COMMANDS, (command, path) => {
    if (command.subcommands) return;
    assert.ok(command.handler, `${path.join(" ")} declares no handler`);
    if (BUILT_IN_HANDLERS.has(command.handler)) return;
    assert.ok(
      known[command.handler],
      `${path.join(" ")} references missing handler ${command.handler}`,
    );
  });
});

test("built-in commands really are answered without dispatch", () => {
  // Guards the exemption above: if these ever need a handler, the test above
  // must stop skipping them.
  for (const name of BUILT_IN_HANDLERS) {
    assert.equal(run([name === "version" ? "--version" : "--help"]).code, 0);
  }
});

test("help renders for the root and every command without throwing", () => {
  assert.match(renderHelp(), /Usage: skillsenv <command>/);
  walk(COMMANDS, (command, path) => {
    const text = renderHelp(path);
    assert.match(text, /Usage: skillsenv/);
    // Documented options must show their value placeholder, not a bare name.
    for (const option of command.options ?? []) {
      if (option.hidden || option.deprecated) continue;
      assert.ok(
        text.includes(option.name),
        `${path.join(" ")} help omits ${option.name}`,
      );
    }
  });
});

test("exit codes follow the contract: 0 success, 2 usage, 1 runtime", () => {
  assert.equal(run(["--help"]).code, 0);
  assert.equal(run(["--version"]).code, 0);
  assert.equal(run(["nosuchcommand"]).code, 2);
  assert.equal(run(["status", "--nosuchflag"]).code, 2);
  assert.equal(run(["add"]).code, 2);
  assert.equal(run(["marketplace"]).code, 2);
  assert.equal(run(["status", "--output-format", "yaml"]).code, 2);
  assert.equal(run(["sync", "--quiet", "--verbose"]).code, 2);
});

test("--help and --version write to stdout and exit 0", () => {
  for (const flag of ["--help", "-h", "--version"]) {
    const result = run([flag]);
    assert.equal(result.code, 0, `${flag} should exit 0`);
    assert.notEqual(result.stdout.trim(), "", `${flag} wrote nothing to stdout`);
    assert.equal(result.stderr, "", `${flag} should keep stderr clean`);
  }
});

test("errors go to stderr and never to stdout", () => {
  const result = run(["nosuchcommand"]);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Unknown command: nosuchcommand/);
});

test("a usage error stays a message even with --verbose", () => {
  const result = run(["sync", "--group", "a", "--all-groups", "--verbose"]);
  assert.equal(result.code, 2);
  assert.doesNotMatch(result.stderr, /at \w+ \(/, "usage error printed a stack");
});

test("deprecated spellings keep working and warn on stderr", () => {
  const root = temporaryRoot();
  try {
    // `version` and `install` are accepted; the hint must not reach stdout.
    const legacy = run(["version"], { cwd: root });
    assert.equal(legacy.code, 0);
    assert.match(legacy.stdout.trim(), /^\d+\.\d+\.\d+$/);
    assert.match(legacy.stderr, /version is deprecated; use --version/);

    // The alias resolves to the new command, so the error is `add`'s.
    const alias = run(["install"], { cwd: root });
    assert.equal(alias.code, 2);
    assert.match(alias.stderr, /skillsenv add requires/);
  } finally {
    removeRoot(root);
  }
});

test("--frozen expands to --locked --offline with a migration hint", () => {
  const intent = parseCli(["sync", "--frozen"]);
  assert.equal(intent.options.locked, true);
  assert.equal(intent.options.offline, true);
  assert.match(intent.deprecations.join("\n"), /--frozen is deprecated/);
});

test("--output-format json puts only JSON on stdout", () => {
  const root = temporaryRoot();
  try {
    const home = join(root, "home");
    run(["init"], { cwd: root, home });
    const result = run(["status", "--output-format", "json"], { cwd: root, home });
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.kind, "status");
    assert.equal(parsed.found, true);
  } finally {
    removeRoot(root);
  }
});

test("status reports no environment instead of failing outside a project", () => {
  const root = temporaryRoot();
  try {
    const home = join(root, "home");
    const result = run(["status", "--output-format", "json"], { cwd: root, home });
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).found, false);
  } finally {
    removeRoot(root);
  }
});

test("--directory relocates the run without a cd", async () => {
  const root = temporaryRoot();
  try {
    const context = testContext(root);
    const nested = join(context.cwd, "nested");
    const { result } = await invoke(context, ["--directory", nested, "init"]);
    assert.equal(result.kind, "init");
    assert.ok(
      result.data.manifest.startsWith(nested),
      `init wrote to ${result.data.manifest}, expected it under ${nested}`,
    );
  } finally {
    removeRoot(root);
  }
});

test("--offline refuses a network Marketplace instead of silently skipping", () => {
  const root = temporaryRoot();
  try {
    const home = join(root, "home");
    const result = run(
      ["marketplace", "add", "https://github.com/example/repo", "--offline"],
      { cwd: root, home },
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--offline/);
    assert.equal(result.stdout, "");
  } finally {
    removeRoot(root);
  }
});

test("--quiet silences progress but keeps results and errors", () => {
  const root = temporaryRoot();
  try {
    const home = join(root, "home");
    const quiet = run(["init", "--quiet"], { cwd: root, home });
    assert.equal(quiet.code, 0);
    // A failure must still report, even under --quiet.
    const failure = run(["sync", "--locked", "--quiet"], { cwd: root, home });
    assert.equal(failure.code, 1);
    assert.notEqual(failure.stderr.trim(), "");
  } finally {
    removeRoot(root);
  }
});

test("--locked refuses to run without a lock rather than creating one", () => {
  const root = temporaryRoot();
  try {
    const home = join(root, "home");
    run(["init"], { cwd: root, home });
    const result = run(["sync", "--locked"], { cwd: root, home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /lock file not found/);
  } finally {
    removeRoot(root);
  }
});

test("options are rejected on commands that do not declare them", () => {
  assert.equal(run(["agents", "--scope", "user"]).code, 2);
  assert.equal(run(["init", "--group", "x"]).code, 2);
  assert.equal(run(["agents", "--locked"]).code, 2);
});

test("global options are accepted before and after the command", () => {
  const before = parseCli(["--output-format", "json", "status"]);
  const after = parseCli(["status", "--output-format", "json"]);
  assert.equal(before.options.output_format, "json");
  assert.equal(after.options.output_format, "json");
  assert.deepEqual(before.path, after.path);
});

// A leading command-scoped option is resolved against the leaf, not rejected on
// position alone: only the leaf knows which options its command accepts.
test("command-scoped options before the command bind to the leaf", () => {
  const intent = parseCli(["--group", "test", "sync"]);
  assert.deepEqual(intent.options.groups, ["test"]);
  assert.deepEqual(intent.path, ["sync"]);
});

test("command-scoped options are rejected when the leaf does not declare them", () => {
  assert.throws(() => parseCli(["--group", "test", "agents"]), /does not apply/);
});

test("command-scoped options are rejected when there is no command", () => {
  assert.throws(() => parseCli(["--group", "test"]), /after the command/);
});

// Strips options and the values they consume, leaving only the command words.
// The value/boolean split comes from the contract so this cannot drift from what
// the parser does.
function commandWords(tokens) {
  const byToken = new Map();
  for (const option of Object.values(OPTIONS)) {
    byToken.set(option.name, option);
    if (option.short) byToken.set(option.short, option);
  }
  const words = [];
  for (let cursor = 0; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token === "--") break;
    if (!token.startsWith("-")) {
      words.push(token);
      continue;
    }
    const [name, inline] = token.includes("=")
      ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
      : [token, null];
    const option = byToken.get(name);
    if (option && option.kind === "value" && inline === null) cursor += 1;
  }
  return words;
}

test("README examples use spellings the parser accepts", () => {
  const readme = readFileSync(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  const commands = [...readme.matchAll(/^\s*(?:\$ )?skillsenv (.+)$/gm)]
    .map((match) => match[1].trim())
    .filter((line) => !line.includes("<") && !line.includes("..."));
  assert.ok(commands.length > 0, "found no skillsenv examples in README");
  for (const line of commands) {
    // Only the leading command words are checked; argument values may be
    // placeholders or paths that need not exist. Values belonging to a value
    // option are dropped using the contract, so `--directory /some/path` does
    // not leave the path behind to be mistaken for a command word.
    const words = commandWords(line.split(/\s+/));
    if (!words.length) continue;
    const found = resolveCommand(words);
    assert.ok(found, `README documents an unknown command: skillsenv ${line}`);
    assert.ok(
      found.complete,
      `README example stops at a command group: skillsenv ${line}`,
    );
    assert.ok(
      !found.command.deprecated,
      `README example uses a deprecated spelling: skillsenv ${line}`,
    );
  }
});
