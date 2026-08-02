export class SkillsenvError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SkillsenvError";
    this.details = details;
  }
}

export function fail(message, details) {
  throw new SkillsenvError(message, details);
}
