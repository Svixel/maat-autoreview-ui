/**
 * Per-capture-run serialization for every judge-pack mutation.
 *
 * The lock mechanics deliberately come from review-record.cjs: atomic
 * hard-link publication, the two-link stale-reclaim claim, and the existing
 * bounded wait/retry policy stay identical to the other durable writers.
 */

"use strict";

const { existsSync, lstatSync, mkdirSync, realpathSync } = require("node:fs");
const { isAbsolute, join, relative, resolve, sep } = require("node:path");
const { resolveContainedRealPath } = require("./capture-contract.cjs");
const { acquireLock, readLockSnapshot, releaseLock } = require("./review-record.cjs");

const JUDGE_LOCK_OWNER_ENV = "AUTOREVIEW_UI_JUDGE_LOCK_OWNER_PID";
const LEASE = Symbol("autoreview-ui judge lock lease");

function pathIsWithin(candidate, parent) {
  const rel = relative(parent, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Prove the complete write path safe before judgeLockPath may create judge/.
 * Canonicalizing the run root also means a symlinked parent is never traversed
 * again after this read-only check; the run itself and every existing judge
 * descendant must be real, non-symlink entries.
 */
function preflightJudgeRunPath(runDir, projectRoot) {
  const requestedRunDir = resolve(runDir);
  let runStat;
  try {
    runStat = lstatSync(requestedRunDir);
  } catch (err) {
    throw new Error(`judge capture run directory is unavailable: ${requestedRunDir} (${err.message})`);
  }
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
    throw new Error(`judge capture run directory must be a real non-symlink directory: ${requestedRunDir}`);
  }
  if (typeof projectRoot !== "string" || !projectRoot) {
    throw new Error("judge lock acquisition requires the reviewed project root");
  }

  const realRunDir = realpathSync(requestedRunDir);
  let realProjectRoot;
  try {
    const projectStat = lstatSync(resolve(projectRoot));
    if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) throw new Error("not a real directory");
    realProjectRoot = realpathSync(resolve(projectRoot));
  } catch (err) {
    throw new Error(`reviewed project root is unavailable or unsafe: ${resolve(projectRoot)} (${err.message})`);
  }
  if (pathIsWithin(realRunDir, realProjectRoot)) {
    throw new Error(`judge capture run directory is inside project root and is rejected: ${realRunDir}`);
  }

  try {
    resolveContainedRealPath(realRunDir, join("judge", ".judge.lock"), {
      rejectSymlinkComponents: true,
    });
  } catch (err) {
    throw new Error(`judge lock path is unsafe for capture run ${realRunDir}: ${err.message}`);
  }
  return realRunDir;
}

function judgeLockPath(runDir, { createJudgeDir = false } = {}) {
  const absoluteRunDir = resolve(runDir);
  const judgeDir = join(absoluteRunDir, "judge");
  if (!existsSync(judgeDir) && createJudgeDir) {
    try {
      mkdirSync(judgeDir, { mode: 0o700 });
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
  let stat;
  try {
    stat = lstatSync(judgeDir);
  } catch (err) {
    throw new Error(`judge lock directory is unavailable: ${judgeDir} (${err.message})`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`judge lock directory is missing or unsafe: ${judgeDir}`);
  }
  return join(judgeDir, ".judge.lock");
}

function acquireJudgeLock(runDir, { waitMs, createJudgeDir = false, projectRoot } = {}) {
  const absoluteRunDir = preflightJudgeRunPath(runDir, projectRoot);
  const lockPath = judgeLockPath(absoluteRunDir, { createJudgeDir });
  let lockFd;
  try {
    lockFd = waitMs === undefined ? acquireLock(lockPath) : acquireLock(lockPath, waitMs);
  } catch (err) {
    if (/timed out waiting for review-record lock/.test(err.message)) {
      throw new Error(`another judge operation is running for capture run: ${absoluteRunDir}`);
    }
    throw err;
  }
  return {
    [LEASE]: true,
    runDir: absoluteRunDir,
    lockPath,
    lockFd,
    ownerPid: process.pid,
    inherited: false,
    released: false,
  };
}

/**
 * ui-judge invokes ui-review --record as a direct child while retaining the
 * operation-wide lease. The child may share that lease only when both its
 * actual parent and the public lock metadata identify the same live owner.
 */
function inheritJudgeLock(runDir, ownerPid, { parentPid = process.ppid } = {}) {
  const absoluteRunDir = realpathSync(resolve(runDir));
  const parsedOwner = Number(ownerPid);
  const lockPath = judgeLockPath(absoluteRunDir);
  const snapshot = readLockSnapshot(lockPath);
  if (
    !Number.isSafeInteger(parsedOwner) ||
    parsedOwner <= 0 ||
    parsedOwner !== parentPid ||
    snapshot?.pid !== parsedOwner
  ) {
    throw new Error(`cannot inherit judge operation lock for capture run: ${absoluteRunDir}`);
  }
  return {
    [LEASE]: true,
    runDir: absoluteRunDir,
    lockPath,
    lockFd: null,
    ownerPid: parsedOwner,
    inherited: true,
    released: false,
  };
}

function assertJudgeLock(lease, runDir) {
  const absoluteRunDir = realpathSync(resolve(runDir));
  if (!lease?.[LEASE] || lease.released || lease.runDir !== absoluteRunDir) {
    throw new Error(`judge operation lock is not held for capture run: ${absoluteRunDir}`);
  }
  const snapshot = readLockSnapshot(lease.lockPath);
  if (snapshot?.pid !== lease.ownerPid) {
    throw new Error(`judge operation lock ownership changed for capture run: ${absoluteRunDir}`);
  }
  return lease;
}

function releaseJudgeLock(lease) {
  if (!lease?.[LEASE] || lease.released) throw new Error("judge operation lock lease is invalid or already released");
  assertJudgeLock(lease, lease.runDir);
  if (!lease.inherited) releaseLock(lease.lockPath, lease.lockFd);
  lease.released = true;
}

module.exports = {
  JUDGE_LOCK_OWNER_ENV,
  acquireJudgeLock,
  assertJudgeLock,
  inheritJudgeLock,
  judgeLockPath,
  preflightJudgeRunPath,
  releaseJudgeLock,
};
