import { fail } from "./errors.mjs";

// Single source of truth for the CLI surface. Parsing, help rendering, alias
// resolution, option applicability and the test matrix are all derived from the
// declarations below; see docs/cli-ux-conventions.md for the rationale.

export const OPTIONS = {
  help: {
    name: "--help",
    short: "-h",
    kind: "boolean",
    describe: "Show help for the command and exit",
  },
  version: {
    name: "--version",
    short: "-V",
    kind: "boolean",
    describe: "Show the Skillsenv version and exit",
  },
  directory: {
    name: "--directory",
    kind: "value",
    metavar: "<path>",
    field: "directory",
    describe: "Run as if started in this directory",
  },
  root: {
    name: "--root",
    kind: "value",
    metavar: "<path>",
    field: "directory",
    deprecated: { replacement: "--directory" },
    describe: "Deprecated alias for --directory",
  },
  quiet: {
    name: "--quiet",
    short: "-q",
    kind: "boolean",
    describe: "Suppress diagnostics; errors are still reported",
  },
  verbose: {
    name: "--verbose",
    short: "-v",
    kind: "boolean",
    describe: "Print additional diagnostics to stderr",
  },
  outputFormat: {
    name: "--output-format",
    kind: "value",
    metavar: "<text|json>",
    field: "output_format",
    values: ["text", "json"],
    describe: "Result format on stdout (default: text)",
  },
  scope: {
    name: "--scope",
    kind: "value",
    metavar: "<project|user>",
    field: "scope",
    values: ["project", "user"],
    describe: "Select the project (default) or user environment",
  },
  agent: {
    name: "--agent",
    kind: "value",
    metavar: "<id[,id...]>",
    field: "agents",
    list: true,
    describe: "Agent targets for the dependency",
  },
  skill: {
    name: "--skill",
    kind: "value",
    metavar: "<name[,name...]>",
    field: "skills",
    list: true,
    describe: "Skill filter for the dependency",
  },
  // `field` is explicit because `--skill` already owns the derived `skills`
  // field; without it the two would collide as an array and a boolean.
  expandSkills: {
    name: "--skills",
    kind: "boolean",
    field: "expand_skills",
    describe: "Expand each Plugin to its Skill names",
  },
  group: {
    name: "--group",
    kind: "value",
    metavar: "<name[,name...]>",
    field: "groups",
    list: true,
    describe: "Enable the named dependency groups",
  },
  allGroups: {
    name: "--all-groups",
    kind: "boolean",
    describe: "Enable every declared dependency group",
  },
  replace: {
    name: "--replace",
    kind: "boolean",
    describe: "Back up conflicting entries before linking",
  },
  dryRun: {
    name: "--dry-run",
    kind: "boolean",
    describe: "Resolve and preflight without persistent changes",
  },
  locked: {
    name: "--locked",
    kind: "boolean",
    describe: "Require a fresh lock and never rewrite it",
  },
  offline: {
    name: "--offline",
    kind: "boolean",
    describe: "Disable network access",
  },
  // The mirror image of --offline: a read-only command stays fully offline
  // unless the caller opts in, so listing a Marketplace never clones by
  // surprise.
  online: {
    name: "--online",
    kind: "boolean",
    describe: "Allow network access to resolve remote Plugin sources",
  },
  noSync: {
    name: "--no-sync",
    kind: "boolean",
    describe: "Update the declaration and lock without touching Agent directories",
  },
  frozen: {
    name: "--frozen",
    kind: "boolean",
    deprecated: { replacement: "--locked --offline" },
    expandsTo: ["--locked", "--offline"],
    describe: "Deprecated alias for --locked --offline",
  },
};

// Accepted before and after the command path.
export const GLOBAL_OPTIONS = [
  OPTIONS.help,
  OPTIONS.version,
  OPTIONS.directory,
  OPTIONS.root,
  OPTIONS.quiet,
  OPTIONS.verbose,
];

const SYNC_AXES = [OPTIONS.locked, OPTIONS.offline, OPTIONS.frozen];

export const COMMANDS = [
  {
    name: "init",
    summary: "Create .skillsenv in the working directory",
    positional: [],
    options: [OPTIONS.dryRun],
    outputFormats: ["text", "json"],
    handler: "init",
    sideEffects: { writes: ["declaration"], network: false },
  },
  {
    name: "add",
    aliases: ["install"],
    summary: "Add a dependency, then lock, cache and sync it",
    positional: [{ name: "plugin[@marketplace]", required: true }],
    options: [
      OPTIONS.scope,
      OPTIONS.agent,
      OPTIONS.skill,
      OPTIONS.replace,
      OPTIONS.dryRun,
      OPTIONS.noSync,
      OPTIONS.offline,
    ],
    outputFormats: ["text", "json"],
    handler: "add",
    sideEffects: {
      writes: ["declaration", "lock", "cache", "environment"],
      network: true,
    },
  },
  {
    name: "remove",
    aliases: ["uninstall"],
    summary: "Remove a dependency and sync managed links",
    positional: [{ name: "plugin[@marketplace]", required: true }],
    options: [
      OPTIONS.scope,
      OPTIONS.replace,
      OPTIONS.dryRun,
      OPTIONS.noSync,
      OPTIONS.offline,
    ],
    outputFormats: ["text", "json"],
    handler: "remove",
    sideEffects: {
      writes: ["declaration", "lock", "environment"],
      network: true,
    },
  },
  {
    name: "lock",
    summary: "Resolve dependencies and write the lock file",
    positional: [],
    options: [OPTIONS.scope, OPTIONS.dryRun, OPTIONS.offline],
    outputFormats: ["text", "json"],
    handler: "lock",
    sideEffects: { writes: ["lock", "cache"], network: true },
  },
  {
    name: "sync",
    summary: "Resolve, lock, cache and sync dependencies",
    positional: [],
    options: [
      OPTIONS.scope,
      OPTIONS.group,
      OPTIONS.allGroups,
      OPTIONS.replace,
      OPTIONS.dryRun,
      ...SYNC_AXES,
    ],
    outputFormats: ["text", "json"],
    handler: "sync",
    sideEffects: {
      writes: ["lock", "cache", "environment"],
      network: true,
    },
  },
  {
    name: "activate",
    summary: "Trust-gated, cache-only project sync",
    positional: [],
    options: [OPTIONS.replace],
    outputFormats: ["text", "json"],
    handler: "activate",
    sideEffects: { writes: ["environment"], network: false },
  },
  {
    name: "trust",
    summary: "Trust the current project declaration and lock",
    positional: [],
    options: [],
    outputFormats: ["text", "json"],
    handler: "trust",
    sideEffects: { writes: ["trust"], network: false },
  },
  {
    name: "untrust",
    summary: "Remove trust for the current project",
    positional: [],
    options: [],
    outputFormats: ["text", "json"],
    handler: "untrust",
    sideEffects: { writes: ["trust"], network: false },
  },
  {
    name: "status",
    summary: "Show the nearest environment and managed state",
    positional: [],
    options: [OPTIONS.scope],
    outputFormats: ["text", "json"],
    handler: "status",
    sideEffects: { writes: [], network: false },
  },
  {
    name: "clean",
    summary: "Remove unchanged links managed by this environment",
    positional: [],
    options: [OPTIONS.scope, OPTIONS.dryRun],
    outputFormats: ["text", "json"],
    handler: "clean",
    sideEffects: { writes: ["environment"], network: false },
  },
  {
    name: "agents",
    summary: "List supported Agent IDs and target paths",
    positional: [],
    options: [],
    outputFormats: ["text", "json"],
    handler: "agents",
    sideEffects: { writes: [], network: false },
  },
  {
    name: "info",
    summary: "Show one Plugin's version, source, Skills and description",
    positional: [{ name: "plugin[@marketplace]", required: true }],
    options: [OPTIONS.scope, OPTIONS.online],
    outputFormats: ["text", "json"],
    handler: "info",
    sideEffects: { writes: [], network: false, networkOptIn: "--online" },
  },
  {
    name: "shell-init",
    summary: "Print the optional auto-activation hook",
    positional: [{ name: "bash|zsh|fish", required: true }],
    options: [],
    handler: "shell-init",
    sideEffects: { writes: [], network: false },
  },
  {
    name: "marketplace",
    summary: "Manage Claude Code Plugin Marketplace registrations",
    subcommands: [
      {
        name: "add",
        summary: "Register a Marketplace",
        positional: [{ name: "source", required: true }],
        options: [OPTIONS.dryRun, OPTIONS.offline],
        outputFormats: ["text", "json"],
        handler: "marketplace-add",
        sideEffects: { writes: ["config", "cache"], network: true },
      },
      {
        name: "list",
        summary: "List registered marketplaces",
        positional: [],
        options: [],
        outputFormats: ["text", "json"],
        handler: "marketplace-list",
        sideEffects: { writes: [], network: false },
      },
      {
        name: "show",
        summary: "List the Plugins a registered Marketplace provides",
        positional: [{ name: "name", required: true }],
        options: [OPTIONS.expandSkills, OPTIONS.online],
        outputFormats: ["text", "json"],
        handler: "marketplace-show",
        sideEffects: { writes: [], network: false, networkOptIn: "--online" },
      },
      {
        name: "use",
        summary: "Select the default Marketplace",
        positional: [{ name: "name", required: true }],
        options: [OPTIONS.dryRun],
        outputFormats: ["text", "json"],
        handler: "marketplace-use",
        sideEffects: { writes: ["config"], network: false },
      },
      {
        name: "update",
        summary: "Refresh one or all remote marketplaces",
        positional: [{ name: "name", required: false }],
        options: [OPTIONS.dryRun, OPTIONS.offline],
        outputFormats: ["text", "json"],
        handler: "marketplace-update",
        sideEffects: { writes: ["config", "cache"], network: true },
      },
      {
        name: "remove",
        summary: "Remove a Marketplace registration",
        positional: [{ name: "name", required: true }],
        options: [OPTIONS.dryRun],
        outputFormats: ["text", "json"],
        handler: "marketplace-remove",
        sideEffects: { writes: ["config", "cache"], network: false },
      },
    ],
  },
  {
    name: "help",
    summary: "Show help for a command",
    positional: [{ name: "command...", required: false }],
    options: [],
    handler: "help",
    sideEffects: { writes: [], network: false },
  },
];

// `version` predates `-V/--version` and stays as a compatibility word form.
export const COMMAND_WORD_ALIASES = {
  version: { kind: "version", deprecated: { replacement: "--version" } },
};

// `--output-format` is implied by declaring `outputFormats`, so a command can
// never accept the option without also supporting the formats.
export function commandOptions(command) {
  return [
    ...GLOBAL_OPTIONS,
    ...(command.outputFormats ? [OPTIONS.outputFormat] : []),
    ...(command.options ?? []),
  ];
}

// The declared side effects decide whether the egress guard is armed, so
// `network: false` is enforced rather than merely documented. A command with
// `networkOptIn` is offline until the caller names that option explicitly.
export function commandMayUseNetwork(command, options = {}) {
  if (command.sideEffects?.network === true) return true;
  const optIn = command.sideEffects?.networkOptIn;
  if (!optIn) return false;
  const declared = commandOptions(command).find((option) => option.name === optIn);
  const field = declared?.field ?? optIn.slice(2).replaceAll("-", "_");
  return options[field] === true;
}

export function findCommand(name, commands = COMMANDS) {
  return commands.find((command) =>
    command.name === name || (command.aliases ?? []).includes(name)) ?? null;
}

// Resolves a whole path such as ["marketplace", "add"] and stops at the deepest
// command that matches, so callers can check documented invocations without
// re-implementing the tree walk in cli-parser.mjs.
export function resolveCommand(words, commands = COMMANDS) {
  let level = commands;
  let command = null;
  const path = [];
  for (const word of words) {
    const found = findCommand(word, level);
    if (!found) break;
    path.push(found.name);
    command = found;
    if (!found.subcommands) break;
    level = found.subcommands;
  }
  if (!command) return null;
  return { command, path, complete: !command.subcommands };
}

export function leafCommands(commands = COMMANDS, prefix = []) {
  const leaves = [];
  for (const command of commands) {
    const path = [...prefix, command.name];
    if (command.subcommands) {
      leaves.push(...leafCommands(command.subcommands, path));
    } else {
      leaves.push({ path, command });
    }
  }
  return leaves;
}

function claim(registry, key, label) {
  if (registry.has(key)) {
    fail(`Contract defines ${label} more than once: ${key}`);
  }
  registry.set(key, label);
}

function assertOptionSet(command, path, optionTokens) {
  const seen = new Map();
  for (const option of commandOptions(command)) {
    if (!option?.name) fail(`Contract option under ${path} has no name`);
    if (!option.describe) fail(`Contract option ${option.name} has no description`);
    if (!["boolean", "value"].includes(option.kind)) {
      fail(`Contract option ${option.name} has an invalid kind`);
    }
    if (option.kind === "value" && !option.field) {
      fail(`Contract value option ${option.name} has no field`);
    }
    claim(seen, option.name, `option under ${path}`);
    if (option.short) claim(seen, option.short, `option under ${path}`);
    // Every token a command accepts must resolve back to a declared option.
    optionTokens.set(option.name, option);
    if (option.short) optionTokens.set(option.short, option);
  }
}

function assertCommands(commands, names, path, optionTokens) {
  for (const command of commands) {
    if (!command.name) fail(`Contract command under ${path || "root"} has no name`);
    if (!command.summary) fail(`Contract command ${command.name} has no summary`);
    claim(names, [...path, command.name].join(" "), "command");
    for (const alias of command.aliases ?? []) {
      claim(names, [...path, alias].join(" "), "command alias");
    }
    if (command.subcommands) {
      if (command.options || command.positional) {
        fail(`Contract group ${command.name} must not declare its own arguments`);
      }
      assertCommands(
        command.subcommands,
        names,
        [...path, command.name],
        optionTokens,
      );
      continue;
    }
    if (!command.handler) fail(`Contract command ${command.name} has no handler`);
    assertOptionSet(command, [...path, command.name].join(" "), optionTokens);
    let optionalSeen = false;
    for (const argument of command.positional ?? []) {
      if (!argument.name) fail(`Contract command ${command.name} has an unnamed argument`);
      if (argument.required && optionalSeen) {
        fail(`Contract command ${command.name} puts a required argument last`);
      }
      if (!argument.required) optionalSeen = true;
    }
    for (const format of command.outputFormats ?? []) {
      if (!OPTIONS.outputFormat.values.includes(format)) {
        fail(`Contract command ${command.name} declares an unknown output format`);
      }
    }
    if (!command.sideEffects || !Array.isArray(command.sideEffects.writes) ||
        typeof command.sideEffects.network !== "boolean") {
      fail(`Contract command ${command.name} has no side-effect record`);
    }
    const optIn = command.sideEffects.networkOptIn;
    if (optIn !== undefined) {
      if (command.sideEffects.network === true) {
        fail(
          `Contract command ${command.name} declares networkOptIn but already ` +
            "allows network access",
        );
      }
      if (!commandOptions(command).some((option) => option.name === optIn)) {
        fail(
          `Contract command ${command.name} opts into network via ${optIn}, ` +
            "which it does not declare",
        );
      }
    }
  }
}

// Asserts the contract is internally consistent: one canonical definition per
// command, alias and option. Exercised by the test suite so drift fails CI.
export function assertContract(commands = COMMANDS) {
  const names = new Map();
  const optionTokens = new Map();
  assertCommands(commands, names, [], optionTokens);
  for (const word of Object.keys(COMMAND_WORD_ALIASES)) {
    claim(names, word, "command word alias");
  }
  for (const [key, option] of Object.entries(OPTIONS)) {
    if (!optionTokens.has(option.name)) {
      fail(`Contract option ${key} is declared but unreachable from any command`);
    }
    for (const token of option.expandsTo ?? []) {
      if (!optionTokens.has(token)) {
        fail(`Contract option ${option.name} expands to unknown option ${token}`);
      }
    }
    if (option.deprecated && !option.deprecated.replacement) {
      fail(`Contract option ${option.name} is deprecated without a replacement`);
    }
  }
  return { commands: names.size, options: optionTokens.size };
}
