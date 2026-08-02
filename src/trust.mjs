import { realpathSync } from "node:fs";

import { fail } from "./errors.mjs";
import { pathExists, readYaml, sha256, writeYaml } from "./io.mjs";

function emptyTrust() {
  return { schema_version: 1, projects: {} };
}

export function loadTrust(path) {
  if (!pathExists(path)) return emptyTrust();
  const trust = readYaml(path, "Skillsenv trust store");
  if (trust.schema_version !== 1 || !trust.projects ||
      Array.isArray(trust.projects)) {
    fail("Skillsenv trust store requires schema_version: 1 and projects");
  }
  return trust;
}

function projectKey(root) {
  return sha256(realpathSync(root));
}

export function trustProject(path, root, manifest, lock) {
  const canonicalRoot = realpathSync(root);
  const trust = loadTrust(path);
  trust.projects[projectKey(canonicalRoot)] = {
    root: canonicalRoot,
    manifest_sha256: manifest.sha256,
    lock_sha256: lock.sha256,
  };
  writeYaml(path, trust);
}

export function untrustProject(path, root) {
  const trust = loadTrust(path);
  delete trust.projects[projectKey(root)];
  writeYaml(path, trust);
}

export function trustStatus(path, root, manifest, lock) {
  const canonicalRoot = realpathSync(root);
  const record = loadTrust(path).projects[projectKey(canonicalRoot)];
  if (!record) return { trusted: false, reason: "project is not trusted" };
  if (record.root !== canonicalRoot) {
    return { trusted: false, reason: "trusted project root changed" };
  }
  if (record.manifest_sha256 !== manifest.sha256) {
    return { trusted: false, reason: "manifest changed after trust" };
  }
  if (record.lock_sha256 !== lock.sha256) {
    return { trusted: false, reason: "lock file changed after trust" };
  }
  return { trusted: true, reason: null };
}

export function assertTrusted(path, root, manifest, lock) {
  const status = trustStatus(path, root, manifest, lock);
  if (!status.trusted) fail(`Project activation refused: ${status.reason}`);
}
