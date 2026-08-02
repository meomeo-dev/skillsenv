export class SkillsenvError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SkillsenvError";
    this.details = details;
  }
}

// Argument and usage problems. Kept distinct from runtime failures so the entry
// point can honour the exit-code contract in docs/cli-ux-conventions.md.
export class UsageError extends SkillsenvError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = "UsageError";
  }
}

export function fail(message, details) {
  throw new SkillsenvError(message, details);
}

export function failUsage(message, details) {
  throw new UsageError(message, details);
}

export const EXIT_SUCCESS = 0;
export const EXIT_RUNTIME = 1;
export const EXIT_USAGE = 2;

// 0 success, 2 usage error, 1 runtime or external resource failure.
export function exitCodeForError(error) {
  if (!error) return EXIT_SUCCESS;
  return error instanceof UsageError ? EXIT_USAGE : EXIT_RUNTIME;
}
