import { fail } from "./errors.mjs";

const VALUE_OPTIONS = new Set([
  "--agent",
  "--skill",
  "--scope",
  "--root",
]);
const BOOLEAN_OPTIONS = new Set([
  "--dry-run",
  "--replace",
  "--frozen",
  "--quiet",
]);

function addValue(options, name, value) {
  if (!value) fail(`${name} requires a value`);
  if (name === "--agent" || name === "--skill") {
    const key = name.slice(2) + "s";
    options[key] ??= [];
    for (const item of value.split(",").map((part) => part.trim()).filter(Boolean)) {
      if (!options[key].includes(item)) options[key].push(item);
    }
    return;
  }
  options[name.slice(2).replaceAll("-", "_")] = value;
}

export function parseOptions(args) {
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (VALUE_OPTIONS.has(name)) {
      const value = equals === -1 ? args[++index] : arg.slice(equals + 1);
      addValue(options, name, value);
    } else if (BOOLEAN_OPTIONS.has(name)) {
      if (equals !== -1) fail(`${name} does not take a value`);
      options[name.slice(2).replaceAll("-", "_")] = true;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { options, positional };
}

export function scopeOption(options) {
  const scope = options.scope ?? "project";
  if (scope !== "project" && scope !== "user") {
    fail(`Invalid scope: ${scope}; expected project or user`);
  }
  return scope;
}

export function onePositional(positional, label) {
  if (positional.length !== 1) fail(`Expected one ${label}`);
  return positional[0];
}
