import { fail } from "./errors.mjs";

// Argument parsing lives in cli-parser.mjs, driven by cli-contract.mjs. This
// remains the one place that turns a validated --scope into a scope value,
// including the project default for commands that do not pass the option.
export function scopeOption(options) {
  const scope = options.scope ?? "project";
  if (scope !== "project" && scope !== "user") {
    fail(`Invalid scope: ${scope}; expected project or user`);
  }
  return scope;
}
