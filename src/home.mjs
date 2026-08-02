import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { fail } from "./errors.mjs";
import { sha256 } from "./io.mjs";

export function resolveSkillsenvHome({ env = process.env, homeDir = homedir() } = {}) {
  const configured = env.SKILLSENV_HOME?.trim();
  if (configured && !isAbsolute(configured)) {
    fail("SKILLSENV_HOME must be an absolute path");
  }
  return resolve(configured || join(homeDir, ".skillsenv"));
}

export function homePaths(context = {}) {
  const root = resolveSkillsenvHome(context);
  return {
    root,
    config: join(root, "config.yaml"),
    userManifest: join(root, "user.yaml"),
    userLock: join(root, "user.lock"),
    trust: join(root, "trust.yaml"),
    marketplaceCache: join(root, "cache", "marketplaces"),
    pluginCache: join(root, "cache", "plugins"),
    state: join(root, "state"),
    backups: join(root, "backups"),
  };
}

export function projectStatePath(paths, projectRoot) {
  const canonicalRoot = realpathSync(projectRoot);
  return join(paths.state, "projects", `${sha256(canonicalRoot).slice(0, 20)}.json`);
}
