import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import yaml from "js-yaml";

import { fail } from "./errors.mjs";

export function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// Distinguishes a manifest file from a same-named directory. `~/.skillsenv` is
// the user state directory, so a plain existence check would match it while
// walking up and then try to read a directory as YAML.
export function fileExists(path) {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function isWithin(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." &&
    !isAbsolute(child));
}

export function safeRelative(root, input, label, { allowBare = false } = {}) {
  if (typeof input !== "string" || input.trim() === "" || isAbsolute(input)) {
    fail(`${label} must be a non-empty relative path`);
  }
  if (!allowBare && input !== "." && !input.startsWith("./")) {
    fail(`${label} must start with ./`);
  }
  const candidate = resolve(root, normalize(input));
  if (!isWithin(resolve(root), candidate)) fail(`${label} escapes its root: ${input}`);
  return candidate;
}

export function assertRealPathWithin(root, candidate, label) {
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  if (!isWithin(realRoot, realCandidate)) {
    fail(`${label} resolves outside its root: ${candidate}`);
  }
  return realCandidate;
}

export function readYaml(path, label = "YAML file") {
  let value;
  try {
    value = yaml.load(readFileSync(path, "utf8"), { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    fail(`Cannot read ${label} at ${path}: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must contain an object: ${path}`);
  }
  return value;
}

export function readJson(path, label = "JSON file") {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Cannot read ${label} at ${path}: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must contain an object: ${path}`);
  }
  return value;
}

export function yamlText(value) {
  return yaml.dump(value, {
    noRefs: true,
    lineWidth: 88,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  });
}

export function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeYaml(path, value) {
  atomicWrite(path, yamlText(value));
}

export function writeJson(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

function directoryEntries(root, current = root) {
  const entries = [];
  for (const name of readdirSync(current).sort()) {
    if (name === ".git") continue;
    const path = join(current, name);
    const relPath = relative(root, path).split(sep).join("/");
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      entries.push({ type: "directory", path: relPath, mode: stat.mode & 0o777 });
      entries.push(...directoryEntries(root, path));
    } else if (stat.isSymbolicLink()) {
      entries.push({ type: "symlink", path: relPath, target: readlinkSync(path) });
    } else if (stat.isFile()) {
      entries.push({
        type: "file",
        path: relPath,
        mode: stat.mode & 0o777,
        content: readFileSync(path),
      });
    }
  }
  return entries;
}

export function sha256Directory(root) {
  const digest = createHash("sha256");
  for (const entry of directoryEntries(root)) {
    digest.update(`${entry.type}\0${entry.path}\0`);
    if (entry.type === "file") digest.update(`${entry.mode}\0`).update(entry.content);
    if (entry.type === "directory") digest.update(`${entry.mode}\0`);
    if (entry.type === "symlink") digest.update(entry.target);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function copyEntry(sourceRoot, source, destination) {
  const stat = lstatSync(source);
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: stat.mode & 0o777 });
    for (const name of readdirSync(source).sort()) {
      if (name !== ".git") {
        copyEntry(sourceRoot, join(source, name), join(destination, name));
      }
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(source);
    if (isAbsolute(target)) fail(`Absolute symlink is not portable: ${source}`);
    const resolvedTarget = realpathSync(resolve(dirname(source), target));
    if (!isWithin(sourceRoot, resolvedTarget)) {
      fail(`Symlink escapes the copied Skill directory: ${source}`);
    }
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(target, destination);
    return;
  }
  if (!stat.isFile()) fail(`Unsupported filesystem entry in Skill: ${source}`);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, stat.mode & 0o777);
}

export function copyDirectorySafe(source, destination) {
  const sourceRoot = realpathSync(source);
  if (!statSync(sourceRoot).isDirectory()) fail(`Not a directory: ${source}`);
  copyEntry(sourceRoot, sourceRoot, destination);
}

export function makeTempDir(prefix = "skillsenv-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function replaceDirectory(staged, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const previous = `${destination}.previous-${randomUUID()}`;
  const hadPrevious = pathExists(destination);
  try {
    if (hadPrevious) renameSync(destination, previous);
    renameSync(staged, destination);
    if (hadPrevious) rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    if (!pathExists(destination) && pathExists(previous)) {
      renameSync(previous, destination);
    }
    throw error;
  }
}

export function cleanGitEnv(environment = process.env) {
  const env = { ...environment };
  delete env.GIT_CONFIG_COUNT;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) fail(`Cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return (result.stdout ?? "").trim();
}

// --offline is enforced at the egress points rather than threaded through every
// call site, so no resolver path can quietly reach the network (CFI-008).
let offlineMode = false;

export function setOfflineMode(value) {
  offlineMode = value === true;
}

export function isOffline() {
  return offlineMode;
}

export function assertNetworkAllowed(what) {
  if (offlineMode) {
    fail(`${what} requires network access but --offline is set`);
  }
}

// Git subcommands that never touch the network stay allowed while offline.
const LOCAL_GIT_SUBCOMMANDS = new Set([
  "rev-parse",
  "checkout",
  "config",
  "status",
  "sparse-checkout",
]);

// Skips the leading `-C <path>` so `git -C dir rev-parse` reads as `rev-parse`.
function gitSubcommand(args) {
  let cursor = 0;
  while (cursor < args.length) {
    if (args[cursor] === "-C") {
      cursor += 2;
      continue;
    }
    if (args[cursor].startsWith("-")) {
      cursor += 1;
      continue;
    }
    return args[cursor];
  }
  return null;
}

export function runGit(args, options = {}) {
  const subcommand = gitSubcommand(args);
  if (subcommand && !LOCAL_GIT_SUBCOMMANDS.has(subcommand)) {
    assertNetworkAllowed(`git ${subcommand}`);
  }
  return run("git", args, { ...options, env: cleanGitEnv(options.env) });
}
