/**
 * review-record.cjs — durable event-log storage for ui-review.
 *
 * A review log is newline-delimited JSON despite its historical `review.json`
 * filename: line one is the immutable record-header and every later line is a
 * review-event. Rewriting the short log under a lock gives every update an
 * atomic all-or-nothing commit while preserving the append-only event model.
 */

"use strict";

const {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} = require("node:fs");
const os = require("node:os");
const { basename, dirname, join, relative, resolve } = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const {
  legacyCropDigestEventIds,
  recordCompleteness,
  validateAppendCropDigestPolicy,
  validateAppendPosixShotHashPolicy,
  validateReviewEventBatch,
  validateReviewEvents,
} = require("../schemas/validator.cjs");
const { canonicalPathKey, isSafePathSegment } = require("./capture-contract.cjs");

const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 25;

function defaultStateDir() {
  return process.env.AUTOREVIEW_UI_STATE_DIR || join(os.homedir(), ".local", "state", "autoreview-ui");
}

function pause(ms) {
  // Lock contention is rare and short. A synchronous wait keeps this tiny CLI
  // dependency-free without spinning a CPU while another writer fsyncs.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function resolvedPath(path) {
  const suffix = [];
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

function isWithinPath(candidate, parent) {
  const rel = relative(resolvedPath(parent), resolvedPath(candidate));
  return rel === "" || (!rel.startsWith(`..${require("node:path").sep}`) && rel !== "..");
}

function safePathSegment(value, name) {
  if (!isSafePathSegment(value)) {
    throw new Error(`${name} must be a safe path segment`);
  }
  return value;
}

/**
 * Resolve the only permitted output location. `projectRoot` is compared after
 * path normalisation so a symlink-ish or `..` spelling cannot smuggle state
 * into the project. The state directory is created only by appendReviewRecord.
 */
function resolveReviewPath(header, { projectRoot, stateDir = defaultStateDir() }) {
  const project = safePathSegment(header.project, "record header project");
  const runId = safePathSegment(header.runId, "record header runId");
  const path = resolve(stateDir, project, "runs", runId, "review.json");
  if (isWithinPath(path, projectRoot)) {
    throw new Error(`review output path is inside project root and is rejected: ${path}`);
  }
  return path;
}

function readLog(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  try {
    return text.split("\n").map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`line ${index + 1}: ${err.message}`);
      }
    });
  } catch (err) {
    throw new Error(`existing review log is invalid: ${err.message}`);
  }
}

function lockMetadata() {
  return JSON.stringify({ pid: process.pid, createdAt: Date.now() });
}

/**
 * Publish lock metadata atomically: the temporary inode is completely written
 * and fsynced before its exclusive hard link becomes the visible lock. This
 * means a killed writer never leaves an empty, ownerless lock behind.
 */
function createLock(lockPath) {
  const directory = dirname(lockPath);
  const tempPath = join(directory, `.${basename(lockPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let tempFd;
  try {
    tempFd = openSync(tempPath, "wx", 0o600);
    writeSync(tempFd, `${lockMetadata()}\n`, undefined, "utf8");
    fsyncSync(tempFd);
  } finally {
    if (tempFd !== undefined) closeSync(tempFd);
  }
  try {
    linkSync(tempPath, lockPath);
    fsyncDirectory(directory);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return openSync(lockPath, "r");
}

function readLockSnapshot(lockPath) {
  let fd;
  try {
    fd = openSync(lockPath, "r");
    const metadata = JSON.parse(readFileSync(fd, "utf8"));
    if (!metadata || !Number.isInteger(metadata.pid) || metadata.pid <= 0 || !Number.isFinite(metadata.createdAt)) return null;
    const stat = fstatSync(fd);
    return { pid: metadata.pid, createdAt: metadata.createdAt, dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

/**
 * Claim a stale lock with a hard link before unlinking its public name.
 *
 * The claim is exclusive only when its inode has exactly two links: the public
 * lock name and this private claim. A concurrent reclaimer creates a third
 * link, so both contenders back off rather than letting one unlink a path that
 * another may already have replaced with a live lock. A contender that arrives
 * after this check also sees itself as the third link and cannot reclaim; it
 * therefore cannot install a new lock before this claimant removes the stale
 * public name. That makes the unlink safe without relying on a non-atomic
 * pathname-to-inode comparison.
 */
function reclaimStaleLock(lockPath) {
  const stale = readLockSnapshot(lockPath);
  if (!stale || processExists(stale.pid)) return false;
  const claimPath = join(dirname(lockPath), `.${basename(lockPath)}.reclaim.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`);
  try {
    try {
      linkSync(lockPath, claimPath);
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
    const claimed = statSync(claimPath);
    if (
      claimed.dev !== stale.dev ||
      claimed.ino !== stale.ino ||
      claimed.nlink !== 2
    ) return false;
    // Confirm the public name is still the stale inode as well. This catches a
    // prior reclaimer that removed it before our claim could become exclusive.
    let current;
    try {
      current = statSync(lockPath);
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
    if (current.dev !== stale.dev || current.ino !== stale.ino) return false;
    try {
      unlinkSync(lockPath);
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  } finally {
    try {
      unlinkSync(claimPath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
}

function acquireLock(lockPath, waitMs = LOCK_WAIT_MS) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return createLock(lockPath);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (reclaimStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for review-record lock: ${lockPath}`);
      pause(LOCK_RETRY_MS);
    }
  }
}

function releaseLock(lockPath, lockFd) {
  closeSync(lockFd);
  unlinkSync(lockPath);
}

function fsyncDirectory(directory) {
  // APFS accepts directory fsync; filesystems that do not still have the file
  // fsync + atomic rename guarantee, so do not hide a successful record write.
  let fd;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch {
    // Best-effort durability enhancement after a portable atomic rename.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function serializeReviewEvents(events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function writeAtomically(path, events) {
  const directory = dirname(path);
  const tempPath = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const body = serializeReviewEvents(events);
  let fd;
  try {
    fd = openSync(tempPath, "w", 0o600);
    writeSync(fd, body, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  renameSync(tempPath, path);
  fsyncDirectory(directory);
}

/**
 * Append JSONL records with the exact same hard-link lock, fsync and atomic
 * rename discipline as review.json. The library manifest is intentionally
 * separate from the review event log, but it must never acquire a weaker lock
 * just because its records are append-only.
 */
function appendJsonLines(path, records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("appendJsonLines requires a non-empty array of records");
  }
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const lockFd = acquireLock(lockPath);
  try {
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const suffix = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const tempPath = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
    let fd;
    try {
      fd = openSync(tempPath, "w", 0o600);
      writeSync(fd, existing, undefined, "utf8");
      writeSync(fd, suffix, undefined, "utf8");
      fsyncSync(fd);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    renameSync(tempPath, path);
    fsyncDirectory(directory);
    return { path, appended: records.length };
  } finally {
    releaseLock(lockPath, lockFd);
  }
}

function canonicalHeader(header, logPath) {
  if (!header || typeof header !== "object" || Array.isArray(header) || header.targetShotHashes === undefined) {
    return header;
  }
  const normalizedHashes = {};
  for (const [targetId, assets] of Object.entries(header.targetShotHashes || {})) {
    if (!assets || typeof assets !== "object" || Array.isArray(assets)) {
      normalizedHashes[targetId] = assets;
      continue;
    }
    const normalizedAssets = {};
    for (const [asset, digest] of Object.entries(assets)) {
      const canonical = canonicalPathKey(asset);
      if (Object.prototype.hasOwnProperty.call(normalizedAssets, canonical)) {
        throw new Error(`existing review log has colliding legacy shot-hash keys for target ${targetId}: ${logPath}`);
      }
      normalizedAssets[canonical] = digest;
    }
    normalizedHashes[targetId] = normalizedAssets;
  }
  return { ...header, targetShotHashes: normalizedHashes };
}

function hasLegacyWindowsHeaderKeys(header) {
  return Object.values(header?.targetShotHashes || {}).some((assets) =>
    assets && typeof assets === "object" && !Array.isArray(assets) && Object.keys(assets).some((asset) => asset.includes("\\")),
  );
}

function sameHeader(left, right, logPath) {
  return isDeepStrictEqual(canonicalHeader(left, logPath), canonicalHeader(right, logPath));
}

/**
 * Validate, lock, fsync and atomically append a batch of review events. Each
 * input batch includes the record header; after first write the immutable
 * header is compared and only its later event records are appended.
 */
function appendReviewRecord(inputEvents, options) {
  if (!Array.isArray(options?.targetIds)) {
    throw new Error("review-record requires targetIds from the selected project config");
  }
  if (options.beforeCommit !== undefined && typeof options.beforeCommit !== "function") {
    throw new Error("review-record beforeCommit must be a function when supplied");
  }
  if (options.afterCommit !== undefined && typeof options.afterCommit !== "function") {
    throw new Error("review-record afterCommit must be a function when supplied");
  }
  if (options.onSealedExisting !== undefined && typeof options.onSealedExisting !== "function") {
    throw new Error("review-record onSealedExisting must be a function when supplied");
  }
  const inputValidation = validateReviewEventBatch(inputEvents);
  if (!inputValidation.valid) {
    throw new Error(`invalid review events:\n${inputValidation.errors.map((error) => `  - ${error}`).join("\n")}`);
  }
  const pathPolicy = validateAppendPosixShotHashPolicy(inputEvents);
  if (!pathPolicy.valid) {
    throw new Error(`review header append policy is invalid:\n${pathPolicy.errors.map((error) => `  - ${error}`).join("\n")}`);
  }
  const header = inputEvents[0];
  const path = resolveReviewPath(header, options);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const lockFd = acquireLock(lockPath);
  try {
    const existing = readLog(path);
    const legacyWindowsHeader = existing.length > 0 && hasLegacyWindowsHeaderKeys(existing[0]);
    if (legacyWindowsHeader) {
      console.error(`WARNING: canonicalizing legacy Windows shot-hash keys while reading review log: ${path}`);
    }
    const legacyEventIds = legacyCropDigestEventIds(existing);
    if (legacyEventIds.length) {
      console.error(`WARNING: accepting legacy crop-backed review event(s) without cropDigest: ${legacyEventIds.join(", ")}`);
    }
    if (existing.length > 0 && !sameHeader(existing[0], header, path)) {
      throw new Error(`record header does not match existing run ${header.runId}`);
    }
    const existingValidationEvents = existing.length === 0
      ? existing
      : [canonicalHeader(existing[0], path), ...existing.slice(1)];
    const existingCompleteness = recordCompleteness(existingValidationEvents);
    if (existingCompleteness.sealed && options.onSealedExisting) {
      const existingValidation = validateReviewEvents(existingValidationEvents, {
        targetIds: options.targetIds,
        capturedTargetIds: options.capturedTargetIds,
        capturedTargetOutcomes: options.capturedTargetOutcomes,
        capturedTargetShotHashes: options.capturedTargetShotHashes,
      });
      if (!existingValidation.valid) {
        throw new Error(`existing review event sequence is invalid:\n${existingValidation.errors.map((error) => `  - ${error}`).join("\n")}`);
      }
      const handled = options.onSealedExisting({
        path,
        existingEvents: existing,
        combinedEvents: existing,
        completeness: existingCompleteness,
      });
      if (handled?.handled) {
        return {
          path,
          appended: 0,
          events: existing.length,
          combinedEvents: existing,
          completeness: existingCompleteness,
          finalization: handled,
        };
      }
    }
    const next = existing.length === 0 ? inputEvents : (() => {
      return [...existing, ...inputEvents.slice(1)];
    })();
    // The stored header remains byte-for-byte legacy data in `next`; only its
    // read-view is canonicalized for validation and comparison. Incoming
    // batches still pass the append-only header policy above and therefore
    // must use POSIX separators.
    const validationEvents = existing.length === 0
      ? next
      : [canonicalHeader(next[0], path), ...next.slice(1)];
    const combinedValidation = validateReviewEvents(validationEvents, {
      targetIds: options.targetIds,
      capturedTargetIds: options.capturedTargetIds,
      capturedTargetOutcomes: options.capturedTargetOutcomes,
      capturedTargetShotHashes: options.capturedTargetShotHashes,
    });
    if (!combinedValidation.valid) {
      throw new Error(`review event sequence is invalid:\n${combinedValidation.errors.map((error) => `  - ${error}`).join("\n")}`);
    }
    const cropPolicy = validateAppendCropDigestPolicy(inputEvents, existing);
    if (!cropPolicy.valid) {
      throw new Error(`review crop append policy is invalid:\n${cropPolicy.errors.map((error) => `  - ${error}`).join("\n")}`);
    }
    // The prepare hook runs only after the prospective combined log has passed
    // every structural and sequence check, while this review lock remains
    // held. It may stage journaled evidence, but final evidence paths must wait
    // until writeAtomically makes this log the transaction commit.
    const prepared = options.beforeCommit
      ? options.beforeCommit({ path, existingEvents: existing, combinedEvents: next })
      : undefined;
    writeAtomically(path, next);
    if (options.afterCommit) {
      options.afterCommit({ path, existingEvents: existing, combinedEvents: next, prepared });
    }
    return {
      path,
      appended: inputEvents.length - (existing.length === 0 ? 0 : 1),
      events: next.length,
      // Consumers that derive durable state must use the validated whole log,
      // not merely the append that happened to contain the terminal seal.
      combinedEvents: next,
      completeness: recordCompleteness(next),
    };
  } finally {
    releaseLock(lockPath, lockFd);
  }
}

module.exports = {
  acquireLock,
  appendJsonLines,
  appendReviewRecord,
  defaultStateDir,
  isWithinPath,
  readLog,
  readLockSnapshot,
  reclaimStaleLock,
  releaseLock,
  resolveReviewPath,
  serializeReviewEvents,
};
