#!/usr/bin/env node

import { runCli } from "../src/commands.mjs";
import { exitCodeForError, UsageError } from "../src/errors.mjs";

const argv = process.argv.slice(2);

try {
  await runCli(argv);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  // Stacks are opt-in and only for unexpected failures. A usage error is fully
  // described by its message, so a stack there is noise (CFI-013).
  const wantsStack = argv.includes("--verbose") || argv.includes("-v");
  if (wantsStack && !(error instanceof UsageError)) {
    console.error(error.stack);
  }
  process.exitCode = exitCodeForError(error);
}
