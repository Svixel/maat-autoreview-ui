/**
 * Durable capture library for autoreview-ui.
 *
 * Capture output is ephemeral by default so a review can be inspected where it
 * was requested. This module copies its completed bundle into the sole state
 * tree, stages independent latest bytes, publishes them transactionally, and
 * appends immutable manifest records last. It never writes below the project
 * root.
 */

"use strict";

const {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { acquireLock, appendJsonLines, defaultStateDir, isWithinPath, releaseLock, serializeReviewEvents } = require("./review-record.cjs");
const { canonicalPathKey, isSafePathSegment, isSafeTargetId, resolveContainedRealPath } = require("./capture-contract.cjs");
const { recordCompleteness, validateJudgmentState } = require("../schemas/validator.cjs");

const DEFAULT_KEEP_RUNS = 30;
const LIBRARY_INSTALL_MARKER = "library-install.marker";
const LIBRARY_INSTALL_MARKER_VERSION = 1;
const REVIEW_CROP_JOURNAL = "review-crops.journal.json";

/**
 * Project-scoped library work (publication, retention, and review recording)
 * uses .library.lock. When a review record also needs its per-run
 * review.json.lock, the order is always library -> review. Keeping that outer
 * lease across capture-run validation prevents retention from deleting a run
 * between validation and review.json's atomic append.
 */

function libraryStateDir() {
  return defaultStateDir();
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function assertSafeProject(project) {
  if (!isSafePathSegment(project)) throw new Error("library project must be a safe path segment");
  return project;
}

function stateProjectDir(project, stateDir = libraryStateDir()) {
  return join(resolve(stateDir), assertSafeProject(project));
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function pathIsWithin(candidate, parent) {
  const rel = relative(parent, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Match review-record's durable publication discipline after a rename. */
function fsyncDirectory(directory) {
  let fd;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch {
    // Some filesystems cannot fsync directories. The file itself was fsynced
    // before its same-directory atomic rename, which remains the boundary.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fsyncFile(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The library state root is a configured boundary, but every directory the
 * library owns beneath it must be a real directory. This prevents a
 * pre-existing project, runs, latest, or staging symlink from redirecting a
 * write, rename, or recursive removal outside durable state.
 */
function createLibraryPathGuard(cfg, stateDir = libraryStateDir()) {
  if (typeof cfg.root !== "string" || !cfg.root.trim()) {
    throw new Error("library config root must be a non-empty string");
  }
  assertSafeProject(cfg.name);
  const configuredRoot = resolve(stateDir);
  if (isWithinPath(configuredRoot, cfg.root)) {
    throw new Error(`library state root is inside project root and is rejected: ${configuredRoot}`);
  }
  mkdirSync(configuredRoot, { recursive: true, mode: 0o700 });
  const stateRoot = realpathSync(configuredRoot);
  const rootStat = lstatSync(stateRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`library state root must be a non-symlink directory: ${configuredRoot}`);
  }
  if (isWithinPath(stateRoot, cfg.root)) {
    throw new Error(`library state root is inside project root and is rejected: ${stateRoot}`);
  }

  const assertContained = (path) => {
    const absolute = resolve(path);
    if (!pathIsWithin(absolute, stateRoot)) {
      throw new Error(`library path escapes state root: ${absolute}`);
    }
    // isWithinPath resolves every existing component and is therefore the
    // final defence against a path that is lexically safe but resolves into
    // the reviewed project.
    if (isWithinPath(absolute, cfg.root)) {
      throw new Error(`library state path is inside project root and is rejected: ${absolute}`);
    }
    return absolute;
  };

  const ensureDirectory = (path) => {
    const absolute = assertContained(path);
    const rel = relative(stateRoot, absolute);
    let current = stateRoot;
    for (const part of rel ? rel.split(sep) : []) {
      current = join(current, part);
      const stat = lstatOrNull(current);
      if (stat) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`library state directory is unsafe: ${current}`);
        }
      } else {
        try {
          mkdirSync(current, { mode: 0o700 });
        } catch (err) {
          // A concurrent library writer can create the same component after
          // our lstat. Re-read it below; any symlink or non-directory still
          // fails validation before this path is used.
          if (err.code !== "EEXIST") throw err;
        }
        const created = lstatSync(current);
        if (!created.isDirectory() || created.isSymbolicLink()) {
          throw new Error(`library state directory is unsafe: ${current}`);
        }
      }
    }
    const resolved = realpathSync(absolute);
    if (!pathIsWithin(resolved, stateRoot) || isWithinPath(resolved, cfg.root)) {
      throw new Error(`library state directory escapes containment: ${absolute}`);
    }
    return absolute;
  };

  const assertFile = (path, { allowMissing = true } = {}) => {
    const absolute = assertContained(path);
    assertDirectory(dirname(absolute));
    const stat = lstatOrNull(absolute);
    if (!stat) {
      if (!allowMissing) throw new Error(`library state file is missing: ${absolute}`);
      return absolute;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`library state file is unsafe: ${absolute}`);
    }
    const resolved = realpathSync(absolute);
    if (!pathIsWithin(resolved, stateRoot) || isWithinPath(resolved, cfg.root)) {
      throw new Error(`library state file escapes containment: ${absolute}`);
    }
    return absolute;
  };

  const assertDirectory = (path, { allowMissing = false } = {}) => {
    const absolute = assertContained(path);
    const rel = relative(stateRoot, absolute);
    let current = stateRoot;
    for (const part of rel ? rel.split(sep) : []) {
      current = join(current, part);
      const stat = lstatOrNull(current);
      if (!stat) {
        if (allowMissing && current === absolute) return null;
        throw new Error(`library state directory is missing: ${current}`);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`library state directory is unsafe: ${current}`);
      }
    }
    const resolved = realpathSync(absolute);
    if (!pathIsWithin(resolved, stateRoot) || isWithinPath(resolved, cfg.root)) {
      throw new Error(`library state directory escapes containment: ${absolute}`);
    }
    return absolute;
  };

  const assertDeletionTree = (path) => {
    assertDirectory(path);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) {
        throw new Error(`library refuses recursive delete through symlink: ${child}`);
      }
      if (stat.isDirectory()) assertDeletionTree(child);
    }
  };

  return {
    stateRoot,
    assertDirectory,
    assertFile,
    ensureDirectory,
    appendJsonLines(path, records) {
      assertFile(path);
      assertFile(`${path}.lock`);
      const result = appendJsonLines(path, records);
      assertFile(path, { allowMissing: false });
      return result;
    },
    copyFile(source, destination) {
      ensureDirectory(dirname(destination));
      assertFile(destination);
      copyFileSync(source, destination);
      assertFile(destination, { allowMissing: false });
    },
    removeDirectory(path) {
      assertDeletionTree(path);
      rmSync(path, { recursive: true, force: false });
    },
    removeDirectoryIfExists(path) {
      if (lstatOrNull(path)) this.removeDirectory(path);
    },
    removeFile(path) {
      assertFile(path, { allowMissing: false });
      rmSync(path, { force: false });
    },
    removeFileIfExists(path) {
      if (lstatOrNull(path)) this.removeFile(path);
    },
    renameFile(source, destination) {
      assertFile(source, { allowMissing: false });
      ensureDirectory(dirname(destination));
      assertFile(destination);
      renameSync(source, destination);
      assertFile(destination, { allowMissing: false });
    },
    writeFile(path, contents) {
      ensureDirectory(dirname(path));
      assertFile(path);
      writeFileSync(path, contents);
      assertFile(path, { allowMissing: false });
    },
    writeFileAtomic(path, contents, { beforeRename = null } = {}) {
      ensureDirectory(dirname(path));
      assertFile(path);
      const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
      assertFile(temporary);
      let fd;
      try {
        fd = openSync(temporary, "wx", 0o600);
        writeSync(fd, contents, undefined, "utf8");
        fsyncSync(fd);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      try {
        assertFile(temporary, { allowMissing: false });
        if (beforeRename) beforeRename({ path: resolve(path), temporary: resolve(temporary) });
        this.renameFile(temporary, path);
        fsyncDirectory(dirname(path));
      } catch (err) {
        try {
          if (lstatOrNull(temporary)) this.removeFile(temporary);
        } catch (cleanupErr) {
          throw new Error(`${err.message}; could not remove judgment-state temporary file: ${cleanupErr.message}`);
        }
        throw err;
      }
      return path;
    },
  };
}

function acquireLibraryLock(cfg, stateDir = libraryStateDir(), { finalizeRecoveredReview = null } = {}) {
  if (finalizeRecoveredReview !== null && typeof finalizeRecoveredReview !== "function") {
    throw new Error("library finalizeRecoveredReview must be a function when supplied");
  }
  const guard = createLibraryPathGuard(cfg, stateDir);
  const projectDir = join(guard.stateRoot, assertSafeProject(cfg.name));
  if (isWithinPath(projectDir, cfg.root)) {
    throw new Error(`library state root is inside project root and is rejected: ${projectDir}`);
  }
  guard.ensureDirectory(projectDir);
  const lockPath = join(projectDir, ".library.lock");
  guard.assertFile(lockPath);
  const lockFd = acquireLock(lockPath);
  const lease = { projectDir, lockPath, lockFd, guard };
  try {
    recoverPendingPublication(cfg, guard, projectDir);
    const recoveredReviewCrop = recoverPendingReviewCropPublication(cfg, guard, projectDir, {
      finalizeRecoveredReview,
      libraryLease: lease,
    });
    const recoveredReviewFinalization = recoveredReviewCrop?.reviewFinalization ?? null;
    return { ...lease, recoveredReviewCrop, recoveredReviewFinalization };
  } catch (err) {
    releaseLock(lockPath, lockFd);
    throw err;
  }
}

function releaseLibraryLock(lease) {
  lease.guard.assertFile(lease.lockPath, { allowMissing: false });
  releaseLock(lease.lockPath, lease.lockFd);
}

function runDirectory(project, runId, stateDir = libraryStateDir()) {
  if (!isSafePathSegment(runId)) throw new Error("library runId must be a safe path segment");
  return join(stateProjectDir(project, stateDir), "runs", runId);
}

function manifestPath(project, stateDir = libraryStateDir()) {
  return join(stateProjectDir(project, stateDir), "manifest.jsonl");
}

function judgmentStatePath(project, stateDir = libraryStateDir()) {
  return join(stateProjectDir(project, stateDir), "judgments", "latest.json");
}

function emptyJudgmentState(project) {
  return {
    version: "judgment-state.v1",
    project,
    sequence: 0,
    targets: {},
  };
}

function readJudgmentStateInProject(cfg, lease) {
  const judgmentsDir = join(lease.projectDir, "judgments");
  const path = join(judgmentsDir, "latest.json");
  if (!lease.guard.assertDirectory(judgmentsDir, { allowMissing: true })) return emptyJudgmentState(cfg.name);
  lease.guard.assertFile(path);
  if (!lstatOrNull(path)) return emptyJudgmentState(cfg.name);
  let state;
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`library judgment state is corrupt at ${path}: ${err.message}`);
  }
  const validation = validateJudgmentState(state);
  if (!validation.valid) {
    throw new Error(`library judgment state is corrupt at ${path}:\n${validation.errors.map((error) => `  - ${error}`).join("\n")}`);
  }
  if (state.project !== cfg.name) throw new Error(`library judgment state belongs to a different project: ${path}`);
  return state;
}

/**
 * Read the durable judgment cursor while holding the existing project library
 * lease. This deliberately creates no per-file lock: .library.lock remains
 * the one serialization point for capture publication, review recording, and
 * judgment-state updates.
 */
function readJudgmentState(cfg, { stateDir = libraryStateDir(), libraryLease = null, finalizeRecoveredReview = null } = {}) {
  const lease = libraryLease ?? acquireLibraryLock(cfg, stateDir, { finalizeRecoveredReview });
  try {
    return readJudgmentStateInProject(cfg, lease);
  } finally {
    if (!libraryLease) releaseLibraryLock(lease);
  }
}

/**
 * Advance the project-level cursor only after a sealed judge record succeeds.
 * `judgedAt` is a monotonic sequence token rather than a wall-clock value so
 * ordering stays deterministic in fixture tests and across clock changes.
 */
function sealJudgmentState(
  cfg,
  {
    targets,
    stateDir = libraryStateDir(),
    libraryLease = null,
    beforeRename = null,
    reconcileOnly = false,
  } = {},
) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("library judgment state requires at least one sealed target");
  }
  const lease = libraryLease ?? acquireLibraryLock(cfg, stateDir);
  try {
    const previous = readJudgmentStateInProject(cfg, lease);
    const desiredTargets = new Map();
    const requestedRunTokens = new Map();
    for (const target of targets) {
      if (
        typeof target.evidenceDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(target.evidenceDigest) ||
        typeof target.rubricDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(target.rubricDigest)
      ) {
        throw new Error(`library judgment state target ${target.targetId} requires judgment evidenceDigest and rubricDigest`);
      }
      if (target.judgedAt !== undefined && (!Number.isInteger(target.judgedAt) || target.judgedAt < 1)) {
        throw new Error(`library judgment state target ${target.targetId} has an invalid ordering token`);
      }
      if (target.judgedAt !== undefined) {
        const requested = requestedRunTokens.get(target.runId);
        if (requested !== undefined && requested !== target.judgedAt) {
          throw new Error(`library judgment state run ${target.runId} has conflicting ordering tokens`);
        }
        requestedRunTokens.set(target.runId, target.judgedAt);
      }
      desiredTargets.set(target.targetId, {
        judgment: {
          fingerprint: target.fingerprint,
          ...(target.baseEvidenceDigest === undefined ? {} : { baseEvidenceDigest: target.baseEvidenceDigest }),
          evidenceDigest: target.evidenceDigest,
          rubricDigest: target.rubricDigest,
          ...(target.promptDigests === undefined ? {} : { promptDigests: target.promptDigests }),
          runId: target.runId,
          disposition: target.disposition,
        },
        requestedJudgedAt: target.judgedAt,
      });
    }
    const existingRunTokens = new Map();
    for (const target of Object.values(previous.targets)) {
      const existing = existingRunTokens.get(target.runId);
      if (existing !== undefined && existing !== target.judgedAt) {
        throw new Error(`library judgment state run ${target.runId} has conflicting ordering tokens`);
      }
      existingRunTokens.set(target.runId, target.judgedAt);
    }
    const explicitTokenCeiling = Math.max(previous.sequence, 0, ...requestedRunTokens.values());
    const allocatedJudgedAt = explicitTokenCeiling + 1;
    const changedTargets = [];
    const skippedTargets = [];
    for (const [targetId, desired] of desiredTargets) {
      const current = previous.targets[targetId];
      const sameRun = current?.runId === desired.judgment.runId;
      const knownRunToken = existingRunTokens.get(desired.judgment.runId);
      let judgedAt;
      if (sameRun) judgedAt = current.judgedAt;
      else if (knownRunToken !== undefined) judgedAt = knownRunToken;
      else if (desired.requestedJudgedAt !== undefined) judgedAt = desired.requestedJudgedAt;
      else if (reconcileOnly && current) {
        skippedTargets.push(targetId);
        continue;
      } else judgedAt = allocatedJudgedAt;

      if (current && !sameRun && current.judgedAt >= judgedAt) {
        skippedTargets.push(targetId);
        continue;
      }
      if (current) {
        const { judgedAt: _judgedAt, ...comparable } = current;
        if (isDeepStrictEqual(comparable, desired.judgment) && current.judgedAt === judgedAt) continue;
      }
      changedTargets.push([targetId, { ...desired.judgment, judgedAt }]);
    }
    const path = join(lease.projectDir, "judgments", "latest.json");
    if (!changedTargets.length) return { path, state: previous, updated: false, skippedTargets };

    const next = {
      ...previous,
      sequence: Math.max(previous.sequence, ...changedTargets.map(([, target]) => target.judgedAt)),
      targets: { ...previous.targets },
    };
    for (const [targetId, desired] of changedTargets) {
      next.targets[targetId] = desired;
    }
    const validation = validateJudgmentState(next);
    if (!validation.valid) {
      throw new Error(`library refusing invalid judgment state:\n${validation.errors.map((error) => `  - ${error}`).join("\n")}`);
    }
    lease.guard.writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, { beforeRename });
    return { path, state: next, updated: true, skippedTargets };
  } finally {
    if (!libraryLease) releaseLibraryLock(lease);
  }
}

function sameAssetIdentity(record, identity) {
  return record?.recordType === "asset" &&
    record.outcome === "captured" &&
    ["targetId", "appearance", "variant", "interaction", "crop"].every((key) => record[key] === identity[key]);
}

/**
 * Safely resolve one retained latest/ identity and its immutable manifest
 * provenance. This is read-only apart from the existing project lock lease;
 * it never repairs, publishes, or mutates library assets.
 */
function resolveLatestAsset(cfg, identity, { stateDir = libraryStateDir() } = {}) {
  const lease = acquireLibraryLock(cfg, stateDir);
  try {
    const path = latestAssetPathInProject(lease.projectDir, identity);
    const parent = dirname(path);
    if (!lstatOrNull(parent) || !lstatOrNull(path)) return null;
    lease.guard.assertDirectory(parent);
    lease.guard.assertFile(path, { allowMissing: false });
    const manifest = join(lease.projectDir, "manifest.jsonl");
    lease.guard.assertFile(manifest);
    const records = readManifestLinesAtPath(manifest);
    const record = [...records].reverse().find((candidate) => sameAssetIdentity(candidate, identity));
    if (!record || !isSafePathSegment(record.runId)) return null;
    return { path, runId: record.runId, identity: { ...identity } };
  } finally {
    releaseLibraryLock(lease);
  }
}

/**
 * Snapshot a retained asset while the publication lease still guarantees that
 * latest/ and manifest.jsonl describe the same publication. The image bytes
 * come from the immutable run named by the manifest, and latest/ must hash to
 * those exact bytes before this returns. Consumers may safely use `bytes`
 * after the lease is released without a later publication changing evidence.
 */
function snapshotLatestAsset(cfg, identity, { stateDir = libraryStateDir(), libraryLease = null } = {}) {
  const lease = libraryLease ?? acquireLibraryLock(cfg, stateDir);
  try {
    const latestPath = latestAssetPathInProject(lease.projectDir, identity);
    const latestParent = dirname(latestPath);
    if (!lstatOrNull(latestParent) || !lstatOrNull(latestPath)) return null;
    lease.guard.assertDirectory(latestParent);
    lease.guard.assertFile(latestPath, { allowMissing: false });
    const manifest = join(lease.projectDir, "manifest.jsonl");
    lease.guard.assertFile(manifest);
    const records = readManifestLinesAtPath(manifest);
    const record = [...records].reverse().find((candidate) => sameAssetIdentity(candidate, identity));
    if (!record || !isSafePathSegment(record.runId) || typeof record.assetPath !== "string" || !record.assetPath) return null;

    const immutableRun = join(lease.projectDir, "runs", record.runId);
    lease.guard.assertDirectory(immutableRun);
    const immutablePath = resolve(immutableRun, record.assetPath);
    if (!pathIsWithin(immutablePath, immutableRun) || immutablePath === immutableRun) {
      throw new Error(`library immutable asset path escapes run ${record.runId}: ${record.assetPath}`);
    }
    lease.guard.assertFile(immutablePath, { allowMissing: false });
    const bytes = readFileSync(immutablePath);
    const immutableHash = sha256(bytes);
    const latestHash = sha256(readFileSync(latestPath));
    if (latestHash !== immutableHash) {
      throw new Error(`library latest asset does not match immutable run ${record.runId} for ${identity.targetId}/${identity.appearance}/${identity.variant}`);
    }
    return {
      bytes,
      sha256: immutableHash,
      runId: record.runId,
      identity: { ...identity },
      assetPath: relative(lease.projectDir, immutablePath).split(sep).join("/"),
    };
  } finally {
    if (!libraryLease) releaseLibraryLock(lease);
  }
}

/**
 * Snapshot every currently retained latest/ identity for one target. Narrow
 * judge captures use this to bind all anchor variants into sibling evidence,
 * even when only one retained image is needed as display context.
 */
function snapshotLatestAssetsForTarget(cfg, targetId, { stateDir = libraryStateDir(), libraryLease = null } = {}) {
  if (!isSafePathSegment(targetId)) throw new Error(`library targetId is unsafe: ${targetId}`);
  const lease = libraryLease ?? acquireLibraryLock(cfg, stateDir);
  try {
    const manifest = join(lease.projectDir, "manifest.jsonl");
    lease.guard.assertFile(manifest);
    const identities = new Map();
    for (const record of [...readManifestLinesAtPath(manifest)].reverse()) {
      if (record?.recordType !== "asset" || record.outcome !== "captured" || record.targetId !== targetId) continue;
      const identity = {
        targetId,
        appearance: record.appearance,
        variant: record.variant,
        interaction: record.interaction ?? null,
        crop: record.crop ?? null,
      };
      const key = JSON.stringify([
        identity.targetId,
        identity.appearance,
        identity.variant,
        identity.interaction,
        identity.crop,
      ]);
      if (!identities.has(key)) identities.set(key, identity);
    }
    return [...identities]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, identity]) => snapshotLatestAsset(cfg, identity, { stateDir, libraryLease: lease }))
      .filter(Boolean);
  } finally {
    if (!libraryLease) releaseLibraryLock(lease);
  }
}

/**
 * Snapshot an explicitly immutable library path while holding the same lease
 * used for latest/ publication. Unlike latest/, this never follows a mutable
 * pointer: callers receive the run-qualified bytes only when their declared
 * SHA-256 digest still matches.
 */
function snapshotImmutableAsset(cfg, screenshot, { stateDir = libraryStateDir(), libraryLease = null } = {}) {
  if (!screenshot || typeof screenshot.libraryPath !== "string" || typeof screenshot.sha256 !== "string") {
    throw new Error("library immutable asset requires libraryPath and sha256");
  }
  const match = /^runs\/([^/]+)\/(.+\.png)$/.exec(screenshot.libraryPath);
  if (!match || !isSafePathSegment(match[1]) || !/^sha256:[a-f0-9]{64}$/.test(screenshot.sha256)) {
    throw new Error(`library immutable asset reference is invalid: ${screenshot.libraryPath}`);
  }
  const [, runId] = match;
  const lease = libraryLease ?? acquireLibraryLock(cfg, stateDir);
  try {
    const immutableRun = join(lease.projectDir, "runs", runId);
    const path = resolve(lease.projectDir, screenshot.libraryPath);
    if (!lstatOrNull(immutableRun) || !lstatOrNull(path)) return null;
    if (!pathIsWithin(path, immutableRun) || path === immutableRun) {
      throw new Error(`library immutable asset path escapes run ${runId}: ${screenshot.libraryPath}`);
    }
    lease.guard.assertDirectory(immutableRun);
    lease.guard.assertFile(path, { allowMissing: false });
    const bytes = readFileSync(path);
    const actual = sha256(bytes);
    if (actual !== screenshot.sha256) {
      throw new Error(`library immutable asset digest does not match ${screenshot.libraryPath}`);
    }
    return { bytes, sha256: actual, runId, libraryPath: screenshot.libraryPath };
  } finally {
    if (!libraryLease) releaseLibraryLock(lease);
  }
}

function libraryConfig(cfg) {
  return {
    keepRuns: cfg.library?.keepRuns ?? DEFAULT_KEEP_RUNS,
    maxBytes: cfg.library?.maxBytes ?? null,
  };
}

function libraryInstallMarkerPath(runDir) {
  return join(runDir, LIBRARY_INSTALL_MARKER);
}

/**
 * The marker is written before any capture bytes enter a library run directory.
 * Its presence positively identifies a private library installation that can be
 * reclaimed if the manifest commit never happens. Any absent, malformed, or
 * mismatched marker is deliberately treated as an unknown, preserved directory.
 */
function hasLibraryInstallMarker(runDir, runId) {
  const path = libraryInstallMarkerPath(runDir);
  const stat = lstatOrNull(path);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return false;
  try {
    const marker = JSON.parse(readFileSync(path, "utf8"));
    return marker?.version === LIBRARY_INSTALL_MARKER_VERSION && marker.runId === runId;
  } catch {
    return false;
  }
}

function writeLibraryInstallMarker(runDir, runId, guard) {
  guard.writeFile(
    libraryInstallMarkerPath(runDir),
    JSON.stringify({ version: LIBRARY_INSTALL_MARKER_VERSION, runId }),
  );
}

function completeLibraryInstallMarker(runDir, runId, guard) {
  if (hasLibraryInstallMarker(runDir, runId)) {
    guard.removeFile(libraryInstallMarkerPath(runDir));
  }
}

function copyDirectory(source, destination, guard) {
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`library source directory must be a non-symlink directory: ${source}`);
  }
  guard.ensureDirectory(destination);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(from, to, guard);
    } else if (entry.isFile()) {
      const stat = lstatSync(from);
      if (stat.isSymbolicLink()) throw new Error(`library refuses symlinked asset: ${from}`);
      guard.copyFile(from, to);
    } else {
      throw new Error(`library refuses non-file asset: ${from}`);
    }
  }
}

function reviewCropSegment(value) {
  return `i-${Buffer.from(String(value), "utf8").toString("base64url")}`;
}

function reviewCropPathInRun(destinationRun, { targetId, assetId, cropId }) {
  return join(
    destinationRun,
    "review-crops",
    reviewCropSegment(targetId),
    reviewCropSegment(assetId),
    `${reviewCropSegment(cropId)}.png`,
  );
}

function cropBindingsFromEvents(events) {
  const bindings = new Map();
  for (const event of events || []) {
    const finding = event?.kind === "disposition" ? event.finding : null;
    if (!finding || finding.cropId === undefined) continue;
    // Digest-less crop events are pre-policy legacy records. They remain
    // readable and sealable, but cannot name publishable durable evidence.
    if (finding.cropDigest === undefined) continue;
    if (typeof finding.cropDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(finding.cropDigest)) {
      throw new Error(`library record crop ${finding.targetId}/${finding.cropId} has no valid sealed crop digest`);
    }
    const key = `${finding.targetId}\u0000${finding.assetId}\u0000${finding.cropId}`;
    const prior = bindings.get(key);
    if (prior && (
      prior.cropDigest !== finding.cropDigest ||
      prior.assetId !== finding.assetId ||
      !isDeepStrictEqual(prior.region, finding.region)
    )) {
      throw new Error(`library record crop ${finding.targetId}/${finding.cropId} has conflicting sealed bindings`);
    }
    bindings.set(key, {
      targetId: finding.targetId,
      cropId: finding.cropId,
      cropDigest: finding.cropDigest,
      assetId: finding.assetId,
      region: finding.region,
    });
  }
  return [...bindings.values()];
}

function cropSourceForBinding({ runDir, run, binding }) {
  const shotsDir = join(runDir, "shots");
  const manifestPath = join(shotsDir, "manifest.json");
  const manifest = readJson(manifestPath, "capture manifest");
  const target = (manifest.targets || []).find((entry) => entry?.id === binding.targetId);
  const cropIdMatches = (target?.shots || []).filter((shot) => shot?.cropId === binding.cropId && typeof shot.path === "string");
  const matches = cropIdMatches.filter((shot) =>
    shot?.cropId === binding.cropId &&
    shot?.sourceAssetId === binding.assetId &&
    typeof shot.path === "string",
  );
  if (matches.length !== 1) {
    if (matches.length === 0 && cropIdMatches.length === 1) {
      throw new Error(`library crop source asset does not match finding for ${binding.targetId}/${binding.assetId}/${binding.cropId}`);
    }
    throw new Error(`library cannot resolve exactly one capture crop for ${binding.targetId}/${binding.assetId}/${binding.cropId}`);
  }
  const crop = matches[0];
  if (crop.sourceAssetId !== binding.assetId) {
    throw new Error(`library crop source asset does not match finding for ${binding.targetId}/${binding.cropId}`);
  }
  if (!isDeepStrictEqual(crop.rect, binding.region)) {
    throw new Error(`library crop region does not match finding for ${binding.targetId}/${binding.cropId}`);
  }
  let source;
  try {
    ({ absolute: source } = resolveContainedRealPath(shotsDir, crop.path, { rejectSymlinkComponents: true }));
  } catch (err) {
    throw new Error(`library crop source is unsafe: ${crop.path} (${err.message})`);
  }
  const relativePath = relative(resolve(shotsDir), source);
  if (!relativePath || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`) || !relativePath.toLowerCase().endsWith(".png")) {
    throw new Error(`library crop source escapes capture shots/: ${crop.path}`);
  }
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`library crop source is missing or unsafe: ${source}`);
  const hash = sha256File(source);
  if (hash !== binding.cropDigest || run.targetShotHashes?.[binding.targetId]?.[canonicalPathKey(relativePath)] !== binding.cropDigest) {
    throw new Error(`library crop digest does not match the capture identity for ${binding.targetId}/${binding.cropId}`);
  }
  return source;
}

function reviewCropJournalPath(projectDir) {
  return join(projectDir, REVIEW_CROP_JOURNAL);
}

function journalReviewCropPath(projectDir, path, prefix, label) {
  if (typeof path !== "string" || !path) throw new Error(`library review-crop journal has an invalid ${label}`);
  const absolute = resolve(projectDir, path);
  const rel = relative(projectDir, absolute);
  if (!pathIsWithin(absolute, projectDir) || !rel.startsWith(prefix)) {
    throw new Error(`library review-crop journal ${label} escapes project state: ${path}`);
  }
  return absolute;
}

const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JUDGMENT_DISPOSITIONS = new Set(["clean", "accepted", "rejected", "not-judged"]);

function reviewFinalizationIdentity(value, runId) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
    throw new Error("library review-crop journal has an invalid review finalization identity");
  }
  if (value.packId !== null && (typeof value.packId !== "string" || !UUID_RE.test(value.packId))) {
    throw new Error("library review-crop journal has an invalid finalization packId");
  }
  if (!Array.isArray(value.targets) || !value.targets.length) {
    throw new Error("library review-crop journal finalization has no targets");
  }
  const targetIds = new Set();
  const targets = value.targets.map((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error("library review-crop journal has an invalid finalization target");
    }
    const allowed = new Set([
      "targetId", "fingerprint", "baseEvidenceDigest", "evidenceDigest", "rubricDigest",
      "promptDigests", "runId", "judgedAt", "disposition",
    ]);
    if (Object.keys(target).some((key) => !allowed.has(key))) {
      throw new Error("library review-crop journal finalization target has unexpected fields");
    }
    if (!isSafeTargetId(target.targetId) || targetIds.has(target.targetId)) {
      throw new Error("library review-crop journal finalization has an invalid or duplicate targetId");
    }
    targetIds.add(target.targetId);
    if (target.runId !== runId || !UUID_RE.test(target.runId)) {
      throw new Error("library review-crop journal finalization target has an invalid runId");
    }
    if (target.judgedAt !== undefined && (!Number.isInteger(target.judgedAt) || target.judgedAt < 1)) {
      throw new Error("library review-crop journal finalization target has an invalid ordering token");
    }
    if (target.fingerprint !== null && (typeof target.fingerprint !== "string" || !SHA256_DIGEST_RE.test(target.fingerprint))) {
      throw new Error("library review-crop journal finalization target has an invalid fingerprint");
    }
    for (const key of ["baseEvidenceDigest", "evidenceDigest", "rubricDigest"]) {
      if (typeof target[key] !== "string" || !SHA256_DIGEST_RE.test(target[key])) {
        throw new Error(`library review-crop journal finalization target has an invalid ${key}`);
      }
    }
    if (!target.promptDigests || typeof target.promptDigests !== "object" || Array.isArray(target.promptDigests)) {
      throw new Error("library review-crop journal finalization target has invalid promptDigests");
    }
    for (const digest of Object.values(target.promptDigests)) {
      if (typeof digest !== "string" || !SHA256_DIGEST_RE.test(digest)) {
        throw new Error("library review-crop journal finalization target has an invalid prompt digest");
      }
    }
    if (!JUDGMENT_DISPOSITIONS.has(target.disposition)) {
      throw new Error("library review-crop journal finalization target has an invalid disposition");
    }
    return structuredClone(target);
  });
  return { version: 1, packId: value.packId, targets };
}

function readReviewCropJournal(guard, projectDir) {
  const path = reviewCropJournalPath(projectDir);
  if (!lstatOrNull(path)) return null;
  guard.assertFile(path, { allowMissing: false });
  const journal = readJson(path, "review-crop publication journal");
  if (
    ![2, 3].includes(journal?.version) ||
    !isSafePathSegment(journal.runId) ||
    typeof journal.reviewPath !== "string" ||
    typeof journal.reviewDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(journal.reviewDigest) ||
    typeof journal.stagingDir !== "string" ||
    !Array.isArray(journal.entries)
  ) {
    throw new Error("library review-crop publication journal is invalid");
  }
  const destinationRun = join(projectDir, "runs", journal.runId);
  guard.assertDirectory(destinationRun);
  const reviewPath = journalReviewCropPath(projectDir, journal.reviewPath, `runs${sep}`, "reviewPath");
  if (reviewPath !== join(destinationRun, "review.json")) {
    throw new Error("library review-crop publication journal has an invalid review path");
  }
  const stagingDir = journalReviewCropPath(projectDir, journal.stagingDir, `runs${sep}`, "stagingDir");
  if (dirname(stagingDir) !== destinationRun || !basename(stagingDir).startsWith(".review-crops-staging-")) {
    throw new Error("library review-crop publication journal has an invalid staging directory");
  }
  if (lstatOrNull(stagingDir)) guard.assertDirectory(stagingDir);
  const finalRoot = join(destinationRun, "review-crops");
  const entries = journal.entries.map((entry) => {
    if (!entry || typeof entry.sha256 !== "string" || !SHA256_DIGEST_RE.test(entry.sha256)) {
      throw new Error("library review-crop publication journal has an invalid digest");
    }
    const destination = journalReviewCropPath(projectDir, entry.destination, `runs${sep}`, "destination");
    if (destination === finalRoot || !pathIsWithin(destination, finalRoot)) {
      throw new Error("library review-crop publication journal has an invalid destination");
    }
    const staged = journalReviewCropPath(stagingDir, entry.staged, `review-crops${sep}`, "staged path");
    return { destination, staged, sha256: entry.sha256 };
  });
  const finalization = journal.version === 3
    ? reviewFinalizationIdentity(journal.finalization, journal.runId)
    : undefined;
  if (!entries.length && !finalization) {
    throw new Error("library review-crop publication journal has neither crop entries nor review finalization identity");
  }
  return {
    path,
    version: journal.version,
    runId: journal.runId,
    reviewPath,
    reviewDigest: journal.reviewDigest,
    stagingDir,
    entries,
    finalization,
  };
}

/** Resolve an interrupted crop transaction according to the review-log commit. */
function recoverPendingReviewCropPublication(
  cfg,
  guard,
  projectDir,
  { finalizeRecoveredReview = null, libraryLease = null } = {},
) {
  const journal = readReviewCropJournal(guard, projectDir);
  if (!journal) return null;
  const reviewStat = lstatOrNull(journal.reviewPath);
  if (reviewStat) guard.assertFile(journal.reviewPath, { allowMissing: false });
  const committed = !!reviewStat && sha256File(journal.reviewPath) === journal.reviewDigest;
  if (committed) {
    for (const entry of journal.entries) {
      if (lstatOrNull(entry.destination)) {
        guard.assertFile(entry.destination, { allowMissing: false });
        if (sha256File(entry.destination) !== entry.sha256) {
          throw new Error(`library review-crop destination digest does not match journal: ${entry.destination}`);
        }
        continue;
      }
      guard.assertFile(entry.staged, { allowMissing: false });
      if (sha256File(entry.staged) !== entry.sha256) {
        throw new Error(`library staged review-crop digest does not match journal: ${entry.staged}`);
      }
      guard.renameFile(entry.staged, entry.destination);
      fsyncDirectory(dirname(entry.destination));
    }
  } else {
    // The prospective review log never committed. New-protocol writers cannot
    // have promoted a crop yet, but removing a matching partial destination
    // also makes recovery safe if a process was interrupted mid-cleanup.
    for (const entry of journal.entries) {
      if (!lstatOrNull(entry.destination)) continue;
      guard.assertFile(entry.destination, { allowMissing: false });
      if (sha256File(entry.destination) !== entry.sha256) {
        throw new Error(`library uncommitted review-crop destination does not match journal: ${entry.destination}`);
      }
      guard.removeFile(entry.destination);
      fsyncDirectory(dirname(entry.destination));
    }
  }
  let reviewFinalization = null;
  if (committed && journal.finalization) {
    // The v3 journal is the durable post-commit authority. Reconcile an
    // available executed-pack mirror before the cursor so an interrupted cursor
    // write cannot discard the already-committed pack verdicts. The cursor then
    // advances from immutable journal identities regardless of which capture
    // run triggered recovery or whether the original capture still exists.
    const recovery = {
      committed: true,
      runId: journal.runId,
      reviewPath: journal.reviewPath,
      promoted: true,
      finalization: journal.finalization,
    };
    const mirrorResult = typeof finalizeRecoveredReview === "function"
      ? finalizeRecoveredReview({ libraryLease, recovery })
      : null;
    if (mirrorResult !== null && mirrorResult?.finalized !== true) {
      throw new Error(
        `library committed review-crop journal finalization did not confirm completion and was left pending: ${journal.path}`,
      );
    }
    const cursorResult = sealJudgmentState(cfg, {
      libraryLease,
      targets: journal.finalization.targets,
      reconcileOnly: true,
    });
    reviewFinalization = {
      finalized: true,
      changed: cursorResult.updated === true || mirrorResult?.changed === true,
      packUpdated: mirrorResult?.packUpdated === true,
      cursorUpdated: cursorResult.updated === true || mirrorResult?.cursorUpdated === true,
      targets: structuredClone(journal.finalization.targets),
    };
  }
  // Remove private staging first. If the process stops before journal cleanup,
  // a second recovery can validate the already-promoted final paths without
  // requiring staged copies to remain.
  guard.removeDirectoryIfExists(journal.stagingDir);
  guard.removeFile(journal.path);
  fsyncDirectory(projectDir);
  return {
    committed,
    runId: journal.runId,
    reviewPath: journal.reviewPath,
    promoted: committed,
    finalization: journal.finalization ?? null,
    reviewFinalization,
  };
}

/**
 * Prepare append-only crop evidence for one prospective review-log commit.
 * Staged bytes and their journal live inside the durable run, while final crop
 * paths remain absent until the caller atomically commits the exact bound log
 * and invokes commit().
 */
function persistReviewCrops({ cfg, libraryLease, runDir, run, events, reviewPath, combinedEvents, finalization = null }) {
  if (!libraryLease?.guard || !libraryLease?.projectDir) {
    throw new Error("library review-crop persistence requires the project library lease");
  }
  const bindings = cropBindingsFromEvents(events);
  const { guard, projectDir } = libraryLease;
  const destinationRun = join(projectDir, "runs", run.runId);
  guard.ensureDirectory(destinationRun);
  const expectedReviewPath = join(destinationRun, "review.json");
  const canonicalReviewPath = join(realpathSync(dirname(resolve(reviewPath))), basename(reviewPath));
  if (canonicalReviewPath !== expectedReviewPath || !Array.isArray(combinedEvents)) {
    throw new Error(`library review-crop persistence requires the exact prospective review log at ${expectedReviewPath}`);
  }
  const complete = recordCompleteness(combinedEvents).complete;
  if (complete && finalization === null) {
    throw new Error("library sealed review-crop persistence requires immutable review finalization identity");
  }
  if (!complete && finalization !== null) {
    throw new Error("library unsealed review-crop persistence cannot carry a finalization identity");
  }
  let recoveryFinalization = reviewFinalizationIdentity(finalization, run.runId);
  if (recoveryFinalization) {
    // Reserving the ordering token is pre-commit preparation, so it must not
    // pull cursor validation ahead of the review-log transaction commit. If
    // the cursor path is currently unreadable, retain a tokenless identity;
    // post-commit sealing will report the original error, and any later
    // recovery treats that legacy-shaped identity conservatively.
    let previous = null;
    try {
      previous = readJudgmentStateInProject(cfg, libraryLease);
    } catch {
      previous = null;
    }
    const existingRunTokens = new Set(
      Object.values(previous?.targets ?? {})
        .filter((target) => target.runId === run.runId)
        .map((target) => target.judgedAt),
    );
    const suppliedRunTokens = new Set(
      recoveryFinalization.targets
        .map((target) => target.judgedAt)
        .filter((judgedAt) => judgedAt !== undefined),
    );
    if (existingRunTokens.size > 1 || suppliedRunTokens.size > 1) {
      throw new Error(`library review finalization run ${run.runId} has conflicting ordering tokens`);
    }
    const existingRunToken = existingRunTokens.values().next().value;
    const suppliedRunToken = suppliedRunTokens.values().next().value;
    if (existingRunToken !== undefined && suppliedRunToken !== undefined && existingRunToken !== suppliedRunToken) {
      throw new Error(`library review finalization run ${run.runId} changed its ordering token`);
    }
    const judgedAt = existingRunToken ?? suppliedRunToken ?? (previous ? previous.sequence + 1 : undefined);
    if (judgedAt !== undefined) {
      recoveryFinalization = reviewFinalizationIdentity({
        ...recoveryFinalization,
        targets: recoveryFinalization.targets.map((target) => ({ ...target, judgedAt })),
      }, run.runId);
    }
  }
  if (!bindings.length && recoveryFinalization === null) return { bindings, commit() {} };
  const journalPath = reviewCropJournalPath(projectDir);
  if (lstatOrNull(journalPath)) throw new Error(`library review-crop publication journal already exists: ${journalPath}`);
  const stagingDir = join(destinationRun, `.review-crops-staging-${process.pid}-${randomUUID()}`);
  guard.ensureDirectory(stagingDir);
  const entries = [];
  try {
    for (const binding of bindings) {
      const source = cropSourceForBinding({ runDir, run, binding });
      const destination = reviewCropPathInRun(destinationRun, binding);
      if (lstatOrNull(destination)) {
        guard.assertFile(destination, { allowMissing: false });
        if (sha256File(destination) !== binding.cropDigest) {
          throw new Error(`library review crop already exists with different bytes: ${binding.targetId}/${binding.cropId}`);
        }
        continue;
      }
      const staged = join(
        stagingDir,
        "review-crops",
        reviewCropSegment(binding.targetId),
        reviewCropSegment(binding.assetId),
        `${reviewCropSegment(binding.cropId)}.png`,
      );
      guard.copyFile(source, staged);
      fsyncFile(staged);
      if (sha256File(staged) !== binding.cropDigest) {
        throw new Error(`library staged review-crop digest does not match sealed record: ${binding.targetId}/${binding.cropId}`);
      }
      entries.push({
        sha256: binding.cropDigest,
        destination: relative(projectDir, destination),
        staged: relative(stagingDir, staged),
      });
    }
    if (!entries.length && recoveryFinalization === null) return { bindings, commit() {} };
    guard.writeFileAtomic(journalPath, JSON.stringify({
      version: 3,
      runId: run.runId,
      reviewPath: relative(projectDir, expectedReviewPath),
      reviewDigest: sha256(Buffer.from(serializeReviewEvents(combinedEvents), "utf8")),
      stagingDir: relative(projectDir, stagingDir),
      entries,
      finalization: recoveryFinalization,
    }, null, 2));
    return {
      bindings,
      commit(finalizeRecoveredReview = null) {
        return recoverPendingReviewCropPublication(cfg, guard, projectDir, {
          finalizeRecoveredReview,
          libraryLease,
        });
      },
    };
  } finally {
    // If a journal exists, recovery owns the staging directory. Otherwise it
    // contains only unpublished copies and is safe to remove immediately.
    if (!lstatOrNull(journalPath)) guard.removeDirectoryIfExists(stagingDir);
  }
}

function safeAssetPath(shotsRoot, path) {
  if (typeof path !== "string" || !path) throw new Error("library asset path must be a non-empty string");
  const absolute = resolve(path);
  const rel = relative(resolve(shotsRoot), absolute);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !rel.toLowerCase().endsWith(".png")) {
    throw new Error(`library asset path escapes shots directory: ${path}`);
  }
  return rel;
}

function rebaseAssetPath(path, sourceShots, destinationShots) {
  const asset = safeAssetPath(sourceShots, path);
  return join(destinationShots, asset);
}

function rebaseManifestPaths(value, sourceShots, destinationShots) {
  const copy = JSON.parse(JSON.stringify(value));
  const rebaseTargets = (targets) => {
    for (const target of targets || []) {
      for (const shot of target.shots || []) {
        if (shot.path) shot.path = rebaseAssetPath(shot.path, sourceShots, destinationShots);
      }
      for (const interaction of target.interactions || []) {
        if (interaction.statePath) interaction.statePath = rebaseAssetPath(interaction.statePath, sourceShots, destinationShots);
      }
    }
  };
  rebaseTargets(copy.targets);
  rebaseTargets(copy.shots?.targets);
  return copy;
}

function encodeIdentitySegment(value) {
  // Prefix prevents the URI-safe values "." and ".." from becoming path
  // traversal aliases. Base64url preserves a reversible identity without ever
  // introducing path separators.
  return `i-${Buffer.from(value == null ? "\0" : String(value), "utf8").toString("base64url")}`;
}

function appearanceFor(viewport, captureManifest, cfg) {
  const direct = viewport?.appearance;
  if (typeof direct === "string" && direct) return direct;
  const viewportName = typeof viewport === "string" ? viewport : viewport?.name;
  const declaration = (captureManifest.viewports || []).find((item) => item?.name === viewportName);
  if (typeof declaration?.appearance === "string" && declaration.appearance) return declaration.appearance;
  for (const appearance of cfg.capture?.appearance || []) {
    if (typeof viewportName === "string" && viewportName.endsWith(`-${appearance}`)) return appearance;
  }
  return "default";
}

function assetIdentity(target, asset, captureManifest, cfg, interaction = false) {
  const appearance = appearanceFor(asset.viewport, captureManifest, cfg);
  const viewportName = typeof asset.viewport === "string" ? asset.viewport : asset.viewport?.name ?? "default";
  const kind = asset.kind ?? "default";
  // Web's sweep axis is the viewport, while native's is appearance. Fold the
  // web viewport into the variant identity so 375px and desktop captures never
  // overwrite one another in latest/.
  const variant = asset.variant ?? ((cfg.capture?.mode ?? "playwright") === "playwright" ? `${viewportName}:${kind}` : kind);
  return {
    targetId: target.id,
    appearance,
    variant: String(variant),
    interaction: interaction ? String(asset.id) : asset.interactionId ?? null,
    crop: asset.cropId ?? (asset.kind === "clip" ? "clip" : null),
  };
}

function latestAssetPath(project, identity, stateDir = libraryStateDir()) {
  return latestAssetPathInProject(stateProjectDir(project, stateDir), identity);
}

function latestAssetPathInProject(projectDir, identity) {
  const parts = [
    projectDir,
    "latest",
    encodeIdentitySegment(identity.targetId),
    encodeIdentitySegment(identity.appearance),
    encodeIdentitySegment(identity.variant),
    encodeIdentitySegment(identity.interaction),
    `${encodeIdentitySegment(identity.crop)}.png`,
  ];
  return join(...parts);
}

function replaceLatest(source, destination, guard) {
  const sourceStat = lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`library asset is missing or unsafe: ${source}`);
  guard.assertFile(source, { allowMissing: false });
  guard.ensureDirectory(dirname(destination));
  const temp = join(dirname(destination), `.${basename(destination)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  guard.copyFile(source, temp);
  guard.renameFile(temp, destination);
}

function stagedLatestAssetPath(stagingDir, projectDir, latestPath) {
  const asset = relative(projectDir, latestPath);
  if (isAbsolute(asset) || asset === ".." || asset.startsWith(`..${sep}`) || !asset.startsWith(`latest${sep}`)) {
    throw new Error(`library latest path escapes project state: ${latestPath}`);
  }
  return join(stagingDir, asset);
}

function stagedLatestEntries(source, destination, guard, entries = []) {
  guard.assertDirectory(source);
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      stagedLatestEntries(from, to, guard, entries);
    } else if (entry.isFile()) {
      guard.assertFile(from, { allowMissing: false });
      entries.push({ source: from, destination: to });
    } else {
      throw new Error(`library staging asset is unsafe: ${from}`);
    }
  }
  return entries;
}

function rollbackLatestPublication(applied, guard) {
  const errors = [];
  for (const entry of [...applied].reverse()) {
    try {
      guard.removeFile(entry.destination);
      if (entry.previous) {
        guard.ensureDirectory(dirname(entry.destination));
        guard.renameFile(entry.previous, entry.destination);
      }
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length) {
    throw new Error(`library latest rollback failed: ${errors.map((err) => err.message).join("; ")}`);
  }
}

/**
 * Publish staged latest assets as a reversible generation. Every rename that
 * advances latest has its previous bytes retained in staging until the manifest
 * append commits. The on-disk journal records the old bytes before any rename
 * so a killed process can restore the prior latest generation on its next
 * library-lock acquisition.
 */
function publishStagedLatest(stagingDir, projectDir, runId, guard) {
  const stagedLatest = join(stagingDir, "latest");
  if (!lstatOrNull(stagedLatest)) return null;
  const entries = stagedLatestEntries(stagedLatest, join(projectDir, "latest"), guard);
  const rollbackRoot = join(stagingDir, ".latest-rollback");
  const planned = entries.map((entry) => {
    guard.ensureDirectory(dirname(entry.destination));
    const destinationStat = lstatOrNull(entry.destination);
    let previous = null;
    if (destinationStat) {
      guard.assertFile(entry.destination, { allowMissing: false });
      const relativeDestination = relative(projectDir, entry.destination);
      previous = join(rollbackRoot, relativeDestination);
    }
    return { ...entry, previous };
  });
  const journalPath = join(projectDir, "publish.journal.json");
  writePublishJournal(guard, journalPath, {
    version: 1,
    runId,
    stagingDir: basename(stagingDir),
    replacements: planned.map((entry) => ({
      destination: relative(projectDir, entry.destination),
      backup: entry.previous ? relative(projectDir, entry.previous) : null,
    })),
  });
  const applied = [];
  try {
    for (const entry of planned) {
      if (entry.previous) {
        guard.ensureDirectory(dirname(entry.previous));
        guard.renameFile(entry.destination, entry.previous);
      }
      try {
        guard.renameFile(entry.source, entry.destination);
      } catch (err) {
        if (entry.previous && lstatOrNull(entry.previous)) guard.renameFile(entry.previous, entry.destination);
        throw err;
      }
      applied.push(entry);
    }
  } catch (err) {
    try {
      rollbackLatestPublication(applied, guard);
      guard.removeFile(journalPath);
    } catch (rollbackErr) {
      throw new Error(`${err.message}; ${rollbackErr.message}`);
    }
    throw err;
  }
  let rolledBack = false;
  return {
    commit() {
      guard.removeFile(journalPath);
    },
    rollback() {
      if (rolledBack) return;
      rollbackLatestPublication(applied, guard);
      guard.removeFile(journalPath);
      rolledBack = true;
    },
  };
}

function writePublishJournal(guard, path, journal) {
  if (lstatOrNull(path)) throw new Error(`library publication journal already exists: ${path}`);
  guard.writeFile(path, JSON.stringify(journal, null, 2));
}

function journalPathWithinProject(projectDir, path, prefix, label) {
  if (typeof path !== "string" || !path) throw new Error(`library publication journal has an invalid ${label}`);
  const absolute = resolve(projectDir, path);
  const rel = relative(projectDir, absolute);
  if (!pathIsWithin(absolute, projectDir) || !rel.startsWith(`${prefix}${sep}`)) {
    throw new Error(`library publication journal ${label} escapes project state: ${path}`);
  }
  return absolute;
}

function readPublishJournal(guard, projectDir) {
  const path = join(projectDir, "publish.journal.json");
  if (!lstatOrNull(path)) return null;
  guard.assertFile(path, { allowMissing: false });
  let journal;
  try {
    journal = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`library publication journal is invalid: ${err.message}`);
  }
  if (!journal || journal.version !== 1 || !isSafePathSegment(journal.runId)) {
    throw new Error("library publication journal is invalid");
  }
  if (typeof journal.stagingDir !== "string" || !journal.stagingDir.startsWith(`.latest-staging-${journal.runId}-`)) {
    throw new Error("library publication journal has an invalid staging directory");
  }
  const stagingDir = resolve(projectDir, journal.stagingDir);
  if (dirname(stagingDir) !== projectDir) {
    throw new Error("library publication journal staging directory escapes project state");
  }
  guard.assertDirectory(stagingDir);
  if (!Array.isArray(journal.replacements)) throw new Error("library publication journal has invalid replacements");
  const replacements = journal.replacements.map((replacement) => {
    const destination = journalPathWithinProject(projectDir, replacement?.destination, "latest", "destination");
    if (replacement.backup == null) return { destination, backup: null };
    const backup = journalPathWithinProject(projectDir, replacement.backup, journal.stagingDir, "backup");
    const expectedBackup = join(stagingDir, ".latest-rollback", relative(projectDir, destination));
    if (backup !== expectedBackup) throw new Error("library publication journal has an invalid backup location");
    return { destination, backup };
  });
  return { path, runId: journal.runId, stagingDir, replacements };
}

/**
 * A journal remains only if a process was killed during publication or after
 * manifest append but before journal cleanup. A committed run keeps newest
 * latest bytes; an uncommitted run is rolled back and its private copy is
 * reclaimed. Both branches finish by removing the now-resolved journal.
 */
function recoverPendingPublication(cfg, guard, projectDir) {
  const journal = readPublishJournal(guard, projectDir);
  if (!journal) return;
  const manifest = join(projectDir, "manifest.jsonl");
  guard.assertFile(manifest);
  const committed = readManifestLinesAtPath(manifest).some((record) => record.runId === journal.runId);
  if (!committed) {
    for (const replacement of [...journal.replacements].reverse()) {
      if (replacement.backup && lstatOrNull(replacement.backup)) {
        if (lstatOrNull(replacement.destination)) guard.removeFile(replacement.destination);
        guard.ensureDirectory(dirname(replacement.destination));
        guard.renameFile(replacement.backup, replacement.destination);
      } else if (!replacement.backup && lstatOrNull(replacement.destination)) {
        guard.removeFile(replacement.destination);
      }
    }
    const runDir = join(projectDir, "runs", journal.runId);
    if (lstatOrNull(runDir)) {
      guard.assertDirectory(runDir);
      if (hasLibraryInstallMarker(runDir, journal.runId)) guard.removeDirectory(runDir);
    }
  } else {
    // A process can die after the manifest's atomic append but before it
    // removes the marker. The manifest commit completes that installation.
    const runDir = join(projectDir, "runs", journal.runId);
    if (lstatOrNull(runDir)) {
      guard.assertDirectory(runDir);
      completeLibraryInstallMarker(runDir, journal.runId, guard);
    }
  }
  guard.removeDirectory(journal.stagingDir);
  guard.removeFile(journal.path);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`library could not read ${label}: ${err.message}`);
  }
}

function persistedAssetRecords({ cfg, run, captureManifest, shotsDir, runDir, provenance, latestStagingDir, projectDir, guard }) {
  const byId = new Map((captureManifest.targets || []).map((target) => [target.id, target]));
  const records = [];
  const takenAt = run.completedAt || new Date().toISOString();
  for (const targetId of run.targetIds || []) {
    const target = (run.targets || []).find((item) => item.id === targetId) || { id: targetId };
    const manifestTarget = byId.get(targetId) || { shots: [], interactions: [] };
    const fingerprintEntry = run.targetFingerprints?.[targetId] || null;
    const common = {
      schemaVersion: 1,
      targetId,
      takenAt,
      branch: provenance.branch,
      commit: provenance.commit,
      patchHash: provenance.patchHash,
      targetFingerprint: fingerprintEntry?.fingerprint ?? null,
      fingerprintInputs: fingerprintEntry?.inputs ?? null,
      appBuild: fingerprintEntry?.inputs?.appBuild ?? provenance.appBuild,
      device: provenance.device,
      runId: run.runId,
    };
    for (const shot of manifestTarget.shots || []) {
      if (!shot.path) continue;
      const asset = safeAssetPath(shotsDir, shot.path);
      const identity = assetIdentity(target, shot, captureManifest, cfg);
      const source = join(shotsDir, asset);
      if (!existsSync(source)) continue;
      const latestPath = latestAssetPathInProject(projectDir, identity);
      replaceLatest(source, stagedLatestAssetPath(latestStagingDir, projectDir, latestPath), guard);
      records.push({
        ...common,
        recordType: "asset",
        ...identity,
        assetPath: relative(runDir, source),
        latestPath: relative(projectDir, latestPath),
        outcome: "captured",
        reason: null,
      });
    }
    for (const interaction of manifestTarget.interactions || []) {
      if (!interaction.statePath) continue;
      const asset = safeAssetPath(shotsDir, interaction.statePath);
      const identity = assetIdentity(target, interaction, captureManifest, cfg, true);
      const source = join(shotsDir, asset);
      if (!existsSync(source)) continue;
      const latestPath = latestAssetPathInProject(projectDir, identity);
      replaceLatest(source, stagedLatestAssetPath(latestStagingDir, projectDir, latestPath), guard);
      records.push({
        ...common,
        recordType: "asset",
        ...identity,
        assetPath: relative(runDir, source),
        latestPath: relative(projectDir, latestPath),
        outcome: "captured",
        reason: null,
      });
    }
    // A target summary keeps a failed/skipped target explicit even when its run
    // contains successful assets. Freshness deliberately consults this summary
    // so a partial target is never certified as fresh.
    records.push({
      ...common,
      recordType: "target",
      appearance: null,
      variant: null,
      interaction: null,
      crop: null,
      assetPath: null,
      latestPath: null,
      outcome: run.targetOutcomes?.[targetId] ?? "failed",
      reason: manifestTarget.reason ?? null,
    });
  }
  return records;
}

function directoryBytes(path, guard) {
  guard.assertDirectory(path);
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error(`library refuses symlinked run content: ${child}`);
    if (stat.isDirectory()) total += directoryBytes(child, guard);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}

function runEntries(projectDir, guard, committedRunIds) {
  const runsDir = join(projectDir, "runs");
  if (!lstatOrNull(runsDir)) return [];
  guard.assertDirectory(runsDir);
  return readdirSync(runsDir, { withFileTypes: true })
    .map((entry) => {
      const path = join(runsDir, entry.name);
      guard.assertDirectory(path);
      // Review-only and otherwise unknown run directories predate the durable
      // library. They have no manifest commit and must not affect either
      // keepRuns or maxBytes accounting.
      if (!committedRunIds.has(entry.name)) return null;
      const runPath = join(path, "run.json");
      let completedAt = null;
      if (lstatOrNull(runPath)) {
        guard.assertFile(runPath, { allowMissing: false });
        try { completedAt = readJson(runPath, "run.json").completedAt ?? null; } catch { /* mtime fallback */ }
      }
      const reviewPath = join(path, "review.json");
      const hasReview = !!lstatOrNull(reviewPath);
      if (hasReview) guard.assertFile(reviewPath, { allowMissing: false });
      const stat = lstatSync(path);
      return {
        name: entry.name,
        path,
        timestamp: Date.parse(completedAt || "") || stat.mtimeMs,
        bytes: directoryBytes(path, guard),
        hasReview,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp || a.name.localeCompare(b.name));
}

function readManifestLinesAtPath(path) {
  const stat = lstatOrNull(path);
  if (!stat) return [];
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`library manifest is unsafe: ${path}`);
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`library manifest line ${index + 1} is invalid: ${err.message}`);
    }
  });
}

function committedRunIds(projectDir, guard) {
  const manifest = join(projectDir, "manifest.jsonl");
  guard.assertFile(manifest);
  return new Set(readManifestLinesAtPath(manifest).map((record) => record.runId).filter(isSafePathSegment));
}

/**
 * Reclaim only private library installations that reached runs/<id>/ but not
 * the manifest commit. Unmarked directories are historical review homes or
 * unknown data, so they are deliberately preserved.
 */
function reconcileUncommittedRuns(projectDir, guard, { preserveRunId = null } = {}) {
  const committed = committedRunIds(projectDir, guard);
  const runsDir = join(projectDir, "runs");
  if (!lstatOrNull(runsDir)) return;
  guard.assertDirectory(runsDir);
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    const runDir = join(runsDir, entry.name);
    guard.assertDirectory(runDir);
    if (committed.has(entry.name)) {
      completeLibraryInstallMarker(runDir, entry.name, guard);
      continue;
    }
    if (entry.name !== preserveRunId && hasLibraryInstallMarker(runDir, entry.name)) {
      guard.removeDirectory(runDir);
    }
  }
}

function plannedLibraryRetention(cfg, { guard, projectDir, preserveRunId = null, prospectiveRunId = null } = {}) {
  if (!guard || !projectDir) throw new Error("library retention requires the library path guard");
  const { keepRuns, maxBytes } = libraryConfig(cfg);
  const committed = committedRunIds(projectDir, guard);
  if (prospectiveRunId) {
    const runDir = join(projectDir, "runs", prospectiveRunId);
    if (hasLibraryInstallMarker(runDir, prospectiveRunId)) committed.add(prospectiveRunId);
  }
  const entries = runEntries(projectDir, guard, committed);
  const removedEntries = [];
  const takeOldestPrunable = () => {
    // A review record is the user-authored outcome for that capture. Keep its
    // complete run directory rather than separating review.json from the
    // screenshots and immutable capture identity it describes.
    const index = entries.findIndex((entry) => entry.name !== preserveRunId && !entry.hasReview);
    if (index === -1) return null;
    return entries.splice(index, 1)[0];
  };
  while (entries.length > keepRuns) {
    const oldest = takeOldestPrunable();
    if (!oldest) break;
    removedEntries.push(oldest);
  }
  if (maxBytes != null) {
    let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    while (entries.length && bytes > maxBytes) {
      const oldest = takeOldestPrunable();
      if (!oldest) break;
      bytes -= oldest.bytes;
      removedEntries.push(oldest);
    }
    return {
      removedEntries,
      result: {
        removed: removedEntries.map((entry) => entry.name),
        retained: entries.map((entry) => entry.name),
        bytes,
        quotaExceeded: bytes > maxBytes,
      },
    };
  }
  return {
    removedEntries,
    result: { removed: removedEntries.map((entry) => entry.name), retained: entries.map((entry) => entry.name) },
  };
}

function pruneLibraryRuns(cfg, { stateDir = libraryStateDir(), preserveRunId = null, libraryLockHeld = false, libraryGuard = null, projectDir = null } = {}) {
  const lease = libraryLockHeld ? null : acquireLibraryLock(cfg, stateDir);
  const guard = lease?.guard ?? libraryGuard;
  const stateProject = lease?.projectDir ?? projectDir;
  try {
    if (!guard || !stateProject) throw new Error("library lock holder must provide its path guard");
    reconcileUncommittedRuns(stateProject, guard, { preserveRunId });
    const plan = plannedLibraryRetention(cfg, { guard, projectDir: stateProject, preserveRunId });
    for (const entry of plan.removedEntries) {
      guard.removeDirectory(entry.path);
    }
    return plan.result;
  } finally {
    if (lease) releaseLibraryLock(lease);
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function writePersistedBundle(destinationRun, persistedBundle, persisted, retention, guard) {
  persistedBundle.library = {
    ...(persistedBundle.library || {}),
    ...persisted,
    retention,
  };
  guard.writeFile(join(destinationRun, "bundle.json"), JSON.stringify(persistedBundle, null, 2));
}

/**
 * Retention must assess the durable bundle, but deleting old runs remains a
 * post-commit action. Write the bundle with a candidate retention result and
 * re-plan until its size-dependent quota result is stable.
 */
function finalizeBundleAndPlanRetention({ cfg, destinationRun, persistedBundle, persisted, preserveRunId, prospectiveRunId = null, projectDir, guard }) {
  reconcileUncommittedRuns(projectDir, guard, { preserveRunId });
  let retention = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    writePersistedBundle(destinationRun, persistedBundle, persisted, retention, guard);
    let next;
    try {
      next = plannedLibraryRetention(cfg, { guard, projectDir, preserveRunId, prospectiveRunId }).result;
    } catch (err) {
      next = {
        removed: [],
        retained: [preserveRunId],
        warning: `library retention could not complete: ${err.message}`,
      };
      writePersistedBundle(destinationRun, persistedBundle, persisted, next, guard);
      return next;
    }
    if (sameJson(next, retention)) return retention;
    retention = next;
  }
  throw new Error("library retention plan did not stabilize after writing bundle.json");
}

/**
 * Copy the completed output bundle into state, stage every captured latest
 * asset, publish the complete latest generation, append immutable library
 * records as the commit, then apply retention. Review records land in this
 * exact run directory later through review-record.cjs.
 */
function persistRunBundle({ cfg, outDir, bundle, provenance, stateDir = libraryStateDir() }) {
  const sourceRunPath = join(outDir, "run.json");
  const sourceShots = join(outDir, "shots");
  const sourceRun = readJson(sourceRunPath, "capture run.json");
  const sourceCaptureManifest = readJson(join(sourceShots, "manifest.json"), "capture manifest");
  if (!isSafePathSegment(sourceRun.runId)) throw new Error("library capture run has an unsafe runId");
  // This guard must precede every state-tree mutation, including lock and
  // staging-directory creation. Retention repeats it for direct callers.
  // Publishing all parts of a capture together matters: a manifest record is
  // only meaningful alongside the run bytes and the corresponding latest
  // bytes. This is the outer lock for publication, retention, and review
  // recording; review-record.cjs takes its per-run lock only inside it.
  const libraryLease = acquireLibraryLock(cfg, stateDir);
  const projectDir = libraryLease.projectDir;
  const guard = libraryLease.guard;
  const destinationRun = join(projectDir, "runs", sourceRun.runId);
  const reportedProjectDir = stateProjectDir(cfg.name, stateDir);
  const reportedDestinationRun = runDirectory(cfg.name, sourceRun.runId, stateDir);
  const manifest = join(projectDir, "manifest.jsonl");
  let manifestCommitted = false;
  let latestPublication = null;
  const latestStagingDir = join(
    projectDir,
    `.latest-staging-${sourceRun.runId}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    if (lstatOrNull(destinationRun)) {
      guard.assertDirectory(destinationRun);
      guard.assertFile(manifest);
      const committed = readManifestLinesAtPath(manifest).some((record) => record.runId === sourceRun.runId);
      if (committed) throw new Error(`library run already exists and is not overwritten: ${destinationRun}`);
      if (!hasLibraryInstallMarker(destinationRun, sourceRun.runId)) {
        throw new Error(`library run is uncommitted but not a marked library installation and is preserved: ${destinationRun}`);
      }
      // An interrupted library publication left a private, uncommitted copy.
      // The install marker proves this directory can be safely replaced.
      guard.removeDirectory(destinationRun);
    }
    guard.ensureDirectory(destinationRun);
    // Write the positive ownership marker before installing any capture bytes.
    // It remains until the manifest's atomic append commits this run.
    writeLibraryInstallMarker(destinationRun, sourceRun.runId, guard);
    const destinationShots = join(destinationRun, "shots");
    copyDirectory(sourceShots, destinationShots, guard);
    const captureManifest = rebaseManifestPaths(sourceCaptureManifest, sourceShots, destinationShots);
    guard.writeFile(join(destinationShots, "manifest.json"), JSON.stringify(captureManifest, null, 2));
    for (const target of captureManifest.targets || []) {
      if (!target?.id) continue;
      guard.writeFile(join(destinationShots, `${target.id}.manifest.json`), JSON.stringify(target, null, 2));
    }
    const run = {
      ...sourceRun,
      outDir: destinationShots,
      library: { stateDir: reportedProjectDir, runDir: reportedDestinationRun },
    };
    guard.writeFile(join(destinationRun, "run.json"), JSON.stringify(run, null, 2));
    const persistedBundle = rebaseManifestPaths(bundle, sourceShots, destinationShots);
    persistedBundle.outDir = destinationRun;
    persistedBundle.library = {
      ...(persistedBundle.library || {}),
      mode: "persistent",
      stateDir: reportedProjectDir,
      runDir: reportedDestinationRun,
    };

    const records = persistedAssetRecords({
      cfg,
      run,
      captureManifest,
      shotsDir: destinationShots,
      runDir: destinationRun,
      provenance,
      latestStagingDir,
      projectDir,
      guard,
    });
    const persisted = {
      runDir: reportedDestinationRun,
      manifest,
      records: records.length,
    };
    // The final bundle exists before the manifest commit and quota planning
    // reads that exact on-disk directory. No old runs have been deleted yet.
    let plannedRetention = finalizeBundleAndPlanRetention({
      cfg,
      destinationRun,
      persistedBundle,
      persisted,
      preserveRunId: sourceRun.runId,
      prospectiveRunId: sourceRun.runId,
      projectDir,
      guard,
    });
    // Latest must be complete before the manifest becomes visible. Keep the
    // publication reversible until the manifest's atomic append succeeds.
    latestPublication = publishStagedLatest(latestStagingDir, projectDir, sourceRun.runId, guard);
    guard.appendJsonLines(persisted.manifest, records);
    manifestCommitted = true;
    completeLibraryInstallMarker(destinationRun, sourceRun.runId, guard);
    // Re-plan without the temporary marker now that the committed directory's
    // final on-disk size is known. This keeps quota reporting exact at a tight
    // maxBytes boundary while pruning still remains post-commit.
    plannedRetention = finalizeBundleAndPlanRetention({
      cfg,
      destinationRun,
      persistedBundle,
      persisted,
      preserveRunId: sourceRun.runId,
      projectDir,
      guard,
    });
    if (latestPublication) latestPublication.commit();
    let retention;
    try {
      retention = pruneLibraryRuns(cfg, {
        stateDir,
        preserveRunId: sourceRun.runId,
        libraryLockHeld: true,
        libraryGuard: guard,
        projectDir,
      });
    } catch (err) {
      // Retention must never invalidate an otherwise complete publication.
      // Keep the just-installed run and emit a durable warning for the caller.
      retention = {
        removed: [],
        retained: [sourceRun.runId],
        warning: `library retention could not complete: ${err.message}`,
      };
    }
    return { ...persisted, retention: retention ?? plannedRetention };
  } catch (err) {
    if (!manifestCommitted && latestPublication) {
      try {
        latestPublication.rollback();
      } catch (rollbackErr) {
        throw new Error(`${err.message}; ${rollbackErr.message}`);
      }
    }
    throw err;
  } finally {
    guard.removeDirectoryIfExists(latestStagingDir);
    releaseLibraryLock(libraryLease);
  }
}

function readManifestLines(project, stateDir = libraryStateDir()) {
  const path = manifestPath(project, stateDir);
  return readManifestLinesAtPath(path);
}

module.exports = {
  DEFAULT_KEEP_RUNS,
  acquireLibraryLock,
  appearanceFor,
  assetIdentity,
  latestAssetPath,
  libraryStateDir,
  libraryConfig,
  judgmentStatePath,
  manifestPath,
  persistReviewCrops,
  persistRunBundle,
  pruneLibraryRuns,
  readJudgmentState,
  readManifestLines,
  releaseLibraryLock,
  resolveLatestAsset,
  snapshotLatestAsset,
  snapshotLatestAssetsForTarget,
  snapshotImmutableAsset,
  runDirectory,
  sealJudgmentState,
  sha256,
  stateProjectDir,
};
