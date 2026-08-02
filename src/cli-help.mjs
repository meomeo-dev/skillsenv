import {
  COMMANDS,
  commandOptions,
  findCommand,
  GLOBAL_OPTIONS,
} from "./cli-contract.mjs";
import { failUsage } from "./errors.mjs";

const GLOBAL_NAMES = new Set(GLOBAL_OPTIONS.map((option) => option.name));

function optionSignature(option) {
  const head = option.short ? `${option.short}, ${option.name}` : `    ${option.name}`;
  return option.kind === "value" ? `${head} ${option.metavar}` : head;
}

function pad(rows) {
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}

function usageLine(path, command) {
  const parts = ["skillsenv", ...path];
  if (command?.subcommands) parts.push("<command>");
  for (const argument of command?.positional ?? []) {
    parts.push(argument.required ? `<${argument.name}>` : `[${argument.name}]`);
  }
  parts.push("[options]");
  return `Usage: ${parts.join(" ")}`;
}

function optionSections(command) {
  const all = commandOptions(command);
  const specific = all.filter((option) => !GLOBAL_NAMES.has(option.name) &&
    !option.deprecated);
  const globals = all.filter((option) => GLOBAL_NAMES.has(option.name) &&
    !option.deprecated);
  const deprecated = all.filter((option) => option.deprecated);
  const lines = [];
  if (specific.length) {
    lines.push("", "Options:");
    lines.push(...pad(specific.map((o) => [optionSignature(o), o.describe])));
  }
  if (globals.length) {
    lines.push("", "Global options:");
    lines.push(...pad(globals.map((o) => [optionSignature(o), o.describe])));
  }
  if (deprecated.length) {
    lines.push("", "Deprecated:");
    lines.push(...pad(deprecated.map((o) => [optionSignature(o), o.describe])));
  }
  return lines;
}

function commandRows(commands) {
  return commands.map((command) => {
    const alias = (command.aliases ?? []).length
      ? ` (alias: ${command.aliases.join(", ")})`
      : "";
    return [command.name, `${command.summary}${alias}`];
  });
}

function rootHelp() {
  const groups = COMMANDS.filter((command) => command.subcommands);
  const leaves = COMMANDS.filter((command) => !command.subcommands);
  const lines = [
    "Usage: skillsenv <command> [options]",
    "",
    "Commands:",
    ...pad(commandRows(leaves)),
  ];
  for (const group of groups) {
    lines.push("", `${group.summary}:`);
    lines.push(...pad(
      group.subcommands.map((sub) => [
        `${group.name} ${sub.name}`,
        sub.summary,
      ]),
    ));
  }
  lines.push(...optionSections({ options: [] }));
  lines.push("", "Run skillsenv help <command> for command details.");
  return lines.join("\n");
}

function groupHelp(path, command) {
  const lines = [
    usageLine(path, command),
    "",
    command.summary,
    "",
    "Commands:",
    ...pad(commandRows(command.subcommands)),
    ...optionSections({ options: [] }),
  ];
  return lines.join("\n");
}

function leafHelp(path, command) {
  const lines = [usageLine(path, command), "", command.summary];
  if ((command.aliases ?? []).length) {
    lines.push("", `Alias: ${command.aliases.join(", ")}`);
  }
  if (command.outputFormats) {
    lines.push("", `Output formats: ${command.outputFormats.join(", ")}`);
  }
  lines.push(...optionSections(command));
  return lines.join("\n");
}

// Rendered from the contract, so there is no second copy of the help text to
// drift out of sync (CFI-004).
export function renderHelp(path = []) {
  if (!path.length) return rootHelp();
  let level = COMMANDS;
  let command = null;
  const resolved = [];
  for (const token of path) {
    const found = findCommand(token, level);
    if (!found) {
      const where = resolved.length ? `${resolved.join(" ")} subcommand` : "command";
      failUsage(`Unknown ${where}: ${token}; run skillsenv help`);
    }
    resolved.push(found.name);
    command = found;
    level = found.subcommands ?? [];
    if (!found.subcommands) break;
  }
  if (resolved.length < path.length) {
    failUsage(`skillsenv ${resolved.join(" ")} has no subcommands`);
  }
  if (command.subcommands) return groupHelp(resolved, command);
  return leafHelp(resolved, command);
}
