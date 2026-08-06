import {
  COMMAND_WORD_ALIASES,
  COMMANDS,
  commandOptions,
  findCommand,
  GLOBAL_OPTIONS,
  OPTIONS,
} from "./cli-contract.mjs";
import { failUsage } from "./errors.mjs";

function indexOptions(options) {
  const index = new Map();
  for (const option of options) {
    index.set(option.name, option);
    if (option.short) index.set(option.short, option);
  }
  return index;
}

const GLOBAL_INDEX = indexOptions(GLOBAL_OPTIONS);
const ALL_OPTIONS = Object.values(OPTIONS);

function optionByName(name) {
  return ALL_OPTIONS.find((option) => option.name === name) ?? null;
}

function splitToken(token) {
  const equals = token.indexOf("=");
  return equals === -1
    ? { name: token, inline: null }
    : { name: token.slice(0, equals), inline: token.slice(equals + 1) };
}

function isOptionToken(token) {
  return token.startsWith("-") && token !== "-";
}

function booleanField(option) {
  return option.field ?? option.name.slice(2).replaceAll("-", "_");
}

// Deprecated forms are recorded, not printed. Hints go to stderr later so JSON
// on stdout stays clean (CFI-012).
function noteDeprecation(state, message) {
  if (!state.deprecations.includes(message)) state.deprecations.push(message);
}

function applyBoolean(state, option) {
  if (option.deprecated) {
    noteDeprecation(
      state,
      `${option.name} is deprecated; use ${option.deprecated.replacement}`,
    );
  }
  for (const token of option.expandsTo ?? []) {
    const target = optionByName(token);
    if (target) state.options[booleanField(target)] = true;
  }
  state.options[booleanField(option)] = true;
}

function applyValue(state, option, value) {
  if (value === undefined) failUsage(`${option.name} requires a value`);
  if (option.deprecated) {
    noteDeprecation(
      state,
      `${option.name} is deprecated; use ${option.deprecated.replacement}`,
    );
  }
  if (option.list) {
    const items = value.split(",").map((part) => part.trim()).filter(Boolean);
    if (!items.length) failUsage(`${option.name} requires a value`);
    state.options[option.field] ??= [];
    for (const item of items) {
      if (!state.options[option.field].includes(item)) {
        state.options[option.field].push(item);
      }
    }
    return;
  }
  if (option.values && !option.values.includes(value)) {
    failUsage(
      `Invalid value for ${option.name}: ${value}; ` +
        `expected ${option.values.join(" or ")}`,
    );
  }
  if (state.assigned.has(option.field)) {
    failUsage(`${option.name} is set more than once`);
  }
  state.assigned.add(option.field);
  state.options[option.field] = value;
}

function rejectUnknown(name, index, commandLabel) {
  if (index.has(name)) return;
  const known = optionByName(name) ??
    ALL_OPTIONS.find((option) => option.short === name);
  if (known && commandLabel) {
    failUsage(
      `${name} does not apply to skillsenv ${commandLabel}; ` +
        `run skillsenv help ${commandLabel}`,
    );
  }
  if (known) failUsage(`${name} must appear after the command`);
  failUsage(`Unknown option: ${name}`);
}

// Phase 1: peel options that appear before the command path. Globals are
// applied here; anything else that is a real option is deferred to the leaf so
// `skillsenv --output-format json status` works while
// `skillsenv --output-format json shell-init bash` still fails, because only the
// leaf knows which options its command actually accepts.
function peelGlobals(argv, state) {
  let cursor = 0;
  const deferred = [];
  while (cursor < argv.length) {
    const token = argv[cursor];
    if (token === "--") break;
    if (!isOptionToken(token)) break;
    const { name, inline } = splitToken(token);
    const option = GLOBAL_INDEX.get(name);
    if (!option) {
      // Unknown spellings still fail here; known ones move to the leaf.
      if (!optionByName(name) &&
        !ALL_OPTIONS.some((entry) => entry.short === name)) {
        failUsage(`Unknown option: ${name}`);
      }
      const declared = optionByName(name) ??
        ALL_OPTIONS.find((entry) => entry.short === name);
      deferred.push(token);
      // A value option consumes its argument unless it was given inline.
      if (declared.kind !== "boolean" && inline === null) {
        deferred.push(argv[cursor + 1]);
        cursor += 2;
        continue;
      }
      cursor += 1;
      continue;
    }
    if (option.kind === "boolean") {
      if (inline !== null) failUsage(`${option.name} does not take a value`);
      applyBoolean(state, option);
      cursor += 1;
      continue;
    }
    const value = inline === null ? argv[cursor + 1] : inline;
    applyValue(state, option, value);
    cursor += inline === null ? 2 : 1;
  }
  return { tokens: argv.slice(cursor), deferred };
}

// Phase 2: walk the command tree.
function resolveCommandPath(tokens) {
  const path = [];
  let level = COMMANDS;
  let command = null;
  let cursor = 0;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token === "--" || isOptionToken(token)) break;
    const found = findCommand(token, level);
    if (!found) {
      if (path.length) {
        failUsage(
          `Unknown ${path.join(" ")} subcommand: ${token}; ` +
            `expected ${level.map((entry) => entry.name).join(", ")}`,
        );
      }
      failUsage(`Unknown command: ${token}; run skillsenv help`);
    }
    path.push(found.name);
    cursor += 1;
    if (found.subcommands) {
      level = found.subcommands;
      continue;
    }
    command = found;
    break;
  }
  return { path, command, group: command ? null : level, rest: tokens.slice(cursor) };
}

// Phase 3: parse the remainder against exactly what this leaf accepts.
function parseLeaf(command, label, tokens, state) {
  const index = indexOptions(commandOptions(command));
  const positional = [];
  for (let cursor = 0; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token === "--") {
      positional.push(...tokens.slice(cursor + 1));
      break;
    }
    if (!isOptionToken(token)) {
      positional.push(token);
      continue;
    }
    const { name, inline } = splitToken(token);
    rejectUnknown(name, index, label);
    const option = index.get(name);
    if (option.kind === "boolean") {
      if (inline !== null) failUsage(`${option.name} does not take a value`);
      applyBoolean(state, option);
      continue;
    }
    const value = inline === null ? tokens[++cursor] : inline;
    applyValue(state, option, value);
  }
  return positional;
}

function assertPositional(command, label, positional) {
  const declared = command.positional ?? [];
  const required = declared.filter((argument) => argument.required).length;
  const variadic = declared.some((argument) => argument.name.endsWith("..."));
  if (positional.length < required) {
    failUsage(
      `skillsenv ${label} requires ` +
        declared.filter((a) => a.required).map((a) => `<${a.name}>`).join(" "),
    );
  }
  if (variadic) return;
  if (positional.length > declared.length) {
    if (!declared.length) failUsage(`skillsenv ${label} takes no arguments`);
    failUsage(`skillsenv ${label} accepts at most ${declared.length} argument(s)`);
  }
}

function assertCombinations(command, label, options) {
  if (options.groups?.length && options.all_groups) {
    failUsage("--group and --all-groups are mutually exclusive");
  }
  if (options.quiet && options.verbose) {
    failUsage("--quiet and --verbose are mutually exclusive");
  }
  if (options.output_format &&
      !(command.outputFormats ?? []).includes(options.output_format)) {
    failUsage(
      `skillsenv ${label} does not support --output-format ${options.output_format}`,
    );
  }
}

// Returns an intent instead of executing anything, so `--help` can never reach a
// command handler and therefore never has side effects (CFI-004).
export function parseCli(argv) {
  const state = { options: {}, assigned: new Set(), deprecations: [] };
  const intent = (kind, extra) => ({
    kind,
    options: state.options,
    deprecations: state.deprecations,
    ...extra,
  });
  const { tokens: afterGlobals, deferred } = peelGlobals(argv, state);
  const wordAlias = afterGlobals.length
    ? COMMAND_WORD_ALIASES[afterGlobals[0]]
    : undefined;

  if (wordAlias?.kind === "version") {
    if (afterGlobals.length > 1) failUsage("skillsenv version takes no arguments");
    noteDeprecation(
      state,
      `version is deprecated; use ${wordAlias.deprecated.replacement}`,
    );
    return intent("version", { path: [] });
  }

  const { path, command, group, rest } = resolveCommandPath(afterGlobals);

  if (command) {
    const label = path.join(" ");
    const bound = { ...command, path };
    // Deferred leading options are parsed as if they had followed the command.
    const positional = parseLeaf(command, label, [...deferred, ...rest], state);
    // Help wins wherever it appears, keeping it maximally discoverable.
    if (state.options.help) return intent("help", { path });
    if (state.options.version) return intent("version", { path });
    if (command.handler === "help") {
      return intent("help", { path: positional });
    }
    assertPositional(bound, label, positional);
    assertCombinations(bound, label, state.options);
    return intent("command", { command: bound, path, positional });
  }

  // A bare group (`marketplace`), or no command at all. Deferred tokens are still
  // checked here so a leading command-scoped option cannot be silently dropped.
  parseLeaf({ options: [] }, path.join(" ") || null, [...deferred, ...rest], state);
  if (state.options.help) return intent("help", { path });
  if (state.options.version) return intent("version", { path });
  if (path.length) {
    failUsage(
      `Expected ${path.join(" ")} ${group.map((entry) => entry.name).join(", ")}`,
    );
  }
  return intent("help", { path: [] });
}
