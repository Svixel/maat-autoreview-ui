/**
 * Deterministic judge-pack construction. A pack deliberately contains only
 * resized image attachments, bounded Pass 3 contexts, editable prompts, and
 * crop-request scaffolding; it does not invoke a model or recapture an app.
 */

"use strict";

const { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { assignAssetIds } = require("./evidence.cjs");
const { canonicalPathKey, resolveContainedRealPath } = require("./capture-contract.cjs");
const {
  acquireLibraryLock,
  assetIdentity,
  libraryStateDir,
  readJudgmentState,
  releaseLibraryLock,
  sha256,
  snapshotImmutableAsset,
  snapshotLatestAssetsForTarget,
} = require("./library.cjs");
const { acquireJudgeLock, assertJudgeLock, releaseJudgeLock } = require("./judge-lock.cjs");
const { resizeLongEdgePng } = require("./png.cjs");
const { CHECKLIST_PHASES, validateExemplar, validateJudgePack } = require("../schemas/validator.cjs");

const SKILL_DIR = dirname(__dirname);
const JUDGE_LONG_EDGE = 1568;
const BATCH_MIN = 6;
// BATCH_MAX is the total attachment budget per engine call (screen images
// plus exemplars) and the default per-batch screen-image bound. The screen
// bound alone is configurable via judge.maxImagesPerBatch: the judgment
// protocol caps accepted findings at maxFindingsPerBatch (12, schema-bound),
// and eight content-dense screens in one batch can legitimately produce more
// than 12 real findings, forcing a contract violation (seen live 2026-08-12:
// seven settings sub-pages returned 19). Dense projects lower the screen
// bound; the attachment budget and exemplar capacity stay at 8.
const BATCH_MAX = 8;
const CHECKLIST_TEMPLATE = join(SKILL_DIR, "reference", "judge-checklist.md");
const STANDALONE_CHECKLIST_TEMPLATE = join(SKILL_DIR, "reference", "judge-checklist-standalone.md");
const VERIFICATION_TEMPLATE = join(SKILL_DIR, "reference", "judge-verification.md");
const VERIFICATION_CROP_ID = /^verify-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[a-f0-9]{16})?$/i;

function readJson(path, description) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`judge pack: could not parse ${description} at ${path}: ${err.message}`);
  }
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

function readPreviousPack(path, cfg) {
  if (!existsSync(path)) throw new Error(`judge pack: previous manifest does not exist: ${path}`);
  const pack = readJson(path, "previous judge pack");
  const validation = validateJudgePack(pack);
  if (!validation.valid) {
    throw new Error(`judge pack: previous manifest is invalid:\n${validation.errors.map((error) => `  - ${error}`).join("\n")}`);
  }
  if (pack.project !== cfg.name) {
    throw new Error(`judge pack: previous manifest project ${pack.project} does not match ${cfg.name}`);
  }
  return pack;
}

function packRelative(runDir, path) {
  const result = relative(runDir, path);
  if (!result || isAbsolute(result) || result === ".." || result.startsWith(`..${sep}`)) {
    throw new Error(`judge pack artifact escapes its run: ${path}`);
  }
  return result.split(sep).join("/");
}

function fileArtifact(runDir, path, description) {
  if (typeof path !== "string" || !path) throw new Error(`judge pack: ${description} has no path`);
  const absolute = resolve(runDir, path);
  const rel = relative(resolve(runDir), absolute);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`judge pack: ${description} escapes its capture run`);
  }
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`judge pack: ${description} is missing or unsafe: ${absolute}`);
  return absolute;
}

function sourcePngPath(shotsDir, path, targetId) {
  let absolute;
  try {
    ({ absolute } = resolveContainedRealPath(shotsDir, path, { rejectSymlinkComponents: true }));
  } catch (err) {
    throw new Error(`judge pack: target ${targetId} has an unsafe PNG path: ${path} (${err.message})`);
  }
  if (!absolute.toLowerCase().endsWith(".png")) {
    throw new Error(`judge pack: target ${targetId} has an unsafe PNG path: ${path}`);
  }
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`judge pack: target ${targetId} has a missing or unsafe PNG: ${path}`);
  }
  return absolute;
}

function targetBaseCapturedAssetHashes({ run, captureManifest, shotsDir, targetIds }) {
  const manifestTargets = new Map((captureManifest.targets || []).map((target) => [target.id, target]));
  const result = {};
  for (const targetId of targetIds) {
    const target = manifestTargets.get(targetId);
    if (!target) throw new Error(`judge pack: capture manifest is missing selected target ${targetId}`);
    const assets = {};
    const paths = [
      // Ordinary capture-time crops are stable judging inputs. Only executor
      // verification crops are append-only proof artifacts excluded from the
      // delta-selection digest.
      ...(target.shots || [])
        .filter((shot) => !(typeof shot?.cropId === "string" && VERIFICATION_CROP_ID.test(shot.cropId)))
        .map((shot) => shot?.path),
      ...(target.interactions || []).map((interaction) => interaction?.statePath),
    ].filter(Boolean);
    for (const path of paths) {
      const sourcePath = sourcePngPath(shotsDir, path, targetId);
      const asset = canonicalPathKey(relative(resolve(shotsDir), sourcePath));
      const hash = run.targetShotHashes?.[targetId]?.[asset];
      if (typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(hash)) {
        throw new Error(`judge pack: capture run is missing a valid hash for ${targetId}/${asset}`);
      }
      assets[asset] = hash;
    }
    if (!Object.keys(assets).length) throw new Error(`judge pack: selected target ${targetId} has no captured PNG assets`);
    result[targetId] = assets;
  }
  return result;
}

/**
 * Preserve the complete hash map as it existed when the pack was built. This
 * includes requested capture-time crops; only later digest-bound verification
 * crops may be absent when the executor compares the pack to run.json.
 */
function targetCaptureAssetHashes({ run, targetIds }) {
  const result = {};
  for (const targetId of targetIds) {
    const captured = run.targetShotHashes?.[targetId];
    if (!captured || typeof captured !== "object" || Array.isArray(captured) || !Object.keys(captured).length) {
      throw new Error(`judge pack: selected target ${targetId} has no captured PNG hashes`);
    }
    const assets = {};
    for (const [asset, hash] of Object.entries(captured)) {
      if (typeof asset !== "string" || !asset || typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(hash)) {
        throw new Error(`judge pack: capture run has an invalid hash for ${targetId}/${asset}`);
      }
      assets[asset] = hash;
    }
    result[targetId] = assets;
  }
  return result;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalDigest(value) {
  return sha256(JSON.stringify(canonicalValue(value)));
}

function loadChecklistRubric() {
  const contract = {
    checklistPhases: CHECKLIST_PHASES,
    templates: {
      comparison: readFileSync(CHECKLIST_TEMPLATE, "utf8"),
      standalone: readFileSync(STANDALONE_CHECKLIST_TEMPLATE, "utf8"),
      verification: readFileSync(VERIFICATION_TEMPLATE, "utf8"),
    },
  };
  return { ...contract, digest: canonicalDigest(contract) };
}

function checklistRubricDigest() {
  return loadChecklistRubric().digest;
}

function targetEvidenceWithPromptDigests(evidence, promptDigests = {}) {
  const canonicalPromptDigests = Object.fromEntries(
    Object.entries(promptDigests).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    baseEvidenceDigest: evidence.baseEvidenceDigest,
    evidenceDigest: canonicalDigest({
      baseEvidenceDigest: evidence.baseEvidenceDigest,
      promptDigests: canonicalPromptDigests,
    }),
    rubricDigest: evidence.rubricDigest,
    promptDigests: canonicalPromptDigests,
  };
}

function bindTargetPromptDigests(evidenceByTarget, batches) {
  const promptDigestsByTarget = new Map(
    Object.keys(evidenceByTarget).map((targetId) => [targetId, {}]),
  );
  for (const batch of batches) {
    for (const targetId of batch.targetIds) {
      const digests = promptDigestsByTarget.get(targetId);
      if (!digests) throw new Error(`judge pack: batch ${batch.id} references target ${targetId} without judgment evidence`);
      digests[batch.id] = batch.promptDigest;
    }
  }
  return Object.fromEntries(Object.entries(evidenceByTarget).map(([targetId, evidence]) => [
    targetId,
    targetEvidenceWithPromptDigests(evidence, promptDigestsByTarget.get(targetId)),
  ]));
}

function cropAttachmentHashes({ run, captureManifest, shotsDir, targetIds }) {
  const selected = new Set(targetIds);
  const hashes = {};
  for (const target of captureManifest.targets || []) {
    if (!selected.has(target.id)) continue;
    for (const shot of target.shots || []) {
      if (!shot?.cropId || !shot.path) continue;
      const sourcePath = sourcePngPath(shotsDir, shot.path, target.id);
      const asset = canonicalPathKey(relative(resolve(shotsDir), sourcePath));
      const hash = run.targetShotHashes?.[target.id]?.[asset];
      if (typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(hash)) {
        throw new Error(`judge pack: capture run is missing a valid crop hash for ${target.id}/${asset}`);
      }
      hashes[`shots/${asset}`] = hash;
    }
  }
  return hashes;
}

function digestBoundVerificationCropAssets(pack, run, captureManifest, shotsDir) {
  const allowed = new Set();
  const manifestTargets = new Map((captureManifest?.targets || []).map((target) => [target?.id, target]));
  for (const targetId of pack.targets || []) {
    const target = manifestTargets.get(targetId);
    if (!target) continue;
    for (const shot of target.shots || []) {
      if (
        shot?.kind !== "crop" ||
        typeof shot.cropId !== "string" ||
        !VERIFICATION_CROP_ID.test(shot.cropId) ||
        shot.purpose !== shot.cropId ||
        typeof shot.sourceAssetId !== "string" ||
        !shot.sourceAssetId.startsWith(`${targetId}/`) ||
        shot.assetId !== `${shot.sourceAssetId}/crop/${shot.cropId}` ||
        typeof shot.path !== "string"
      ) continue;
      let asset;
      try {
        asset = canonicalPathKey(relative(resolve(shotsDir), sourcePngPath(shotsDir, shot.path, targetId)));
      } catch {
        continue;
      }
      const digest = run.targetShotHashes?.[targetId]?.[asset];
      if (
        /^sha256:[a-f0-9]{64}$/.test(digest || "") &&
        pack.attachmentHashes?.[`shots/${asset}`] === digest
      ) {
        allowed.add(`${targetId}/${asset}`);
      }
    }
  }
  return allowed;
}

function packAssetHashMismatches(pack, run, captureManifest, shotsDir) {
  const mismatches = [];
  const allowedVerificationCrops = captureManifest
    ? digestBoundVerificationCropAssets(pack, run, captureManifest, shotsDir)
    : new Set();
  for (const targetId of pack.targets || []) {
    const storedAssets = pack.targetShotHashes?.[targetId];
    const currentAssets = run.targetShotHashes?.[targetId];
    if (!storedAssets || !currentAssets) {
      mismatches.push(`${targetId}/*`);
      continue;
    }
    for (const [asset, hash] of Object.entries(storedAssets)) {
      if (currentAssets[asset] !== hash) mismatches.push(`${targetId}/${asset}`);
    }
    for (const asset of Object.keys(currentAssets)) {
      if (!(asset in storedAssets) && !allowedVerificationCrops.has(`${targetId}/${asset}`)) {
        mismatches.push(`${targetId}/${asset}`);
      }
    }
  }
  return mismatches;
}

/**
 * A pack is immutable evidence for its capture's original PNGs. Verification
 * may later add digest-bound verification crops to the run. Every other
 * current asset must exactly match the original key set and bytes.
 */
function assertPackAssetHashesMatchCapture(pack, run, captureManifest, shotsDir) {
  const mismatches = packAssetHashMismatches(pack, run, captureManifest, shotsDir);
  if (!mismatches.length) return;
  throw new Error(`judge pack captured asset hashes do not match the current capture for asset(s): ${mismatches.join(", ")}`);
}

function packFingerprintMismatches(pack, run) {
  return (pack.targets || []).filter((targetId) => pack.targetFingerprints?.[targetId] !== fingerprintFor(run, targetId));
}

function assertPackFingerprintsMatchCapture(pack, run) {
  const mismatches = packFingerprintMismatches(pack, run);
  if (!mismatches.length) return;
  throw new Error(`judge pack target fingerprints do not match the current capture run for target(s): ${mismatches.join(", ")}`);
}

function sameTargetSet(left, right) {
  const leftSet = new Set(left || []);
  const rightSet = new Set(right || []);
  return leftSet.size === rightSet.size && [...leftSet].every((targetId) => rightSet.has(targetId));
}

function loadPersistedJudgePack(runDir) {
  const judgeRoot = join(resolve(runDir), "judge");
  if (!existsSync(judgeRoot)) return null;
  const judgeStat = lstatSync(judgeRoot);
  if (!judgeStat.isDirectory() || judgeStat.isSymbolicLink()) throw new Error(`judge pack: judge directory is missing or unsafe: ${judgeRoot}`);
  const path = join(judgeRoot, "manifest.json");
  if (!existsSync(path)) return null;
  const manifestStat = lstatSync(path);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error(`judge pack: manifest is missing or unsafe: ${path}`);
  const pack = readJson(path, "judge-pack manifest");
  const validation = validateJudgePack(pack);
  if (!validation.valid) {
    throw new Error(`judge pack: manifest is invalid:\n${validation.errors.map((error) => `  - ${error}`).join("\n")}`);
  }
  return { path, pack };
}

function captureManifestForRun(runDir) {
  const path = fileArtifact(runDir, "shots/manifest.json", "capture manifest");
  const manifest = readJson(path, "capture manifest");
  if (!manifest || !Array.isArray(manifest.targets)) throw new Error("judge pack: capture manifest has invalid targets");
  return { captureManifest: manifest, shotsDir: join(resolve(runDir), "shots") };
}

function assertPersistedJudgePackAssetHashesMatchCapture(runDir, run, captureManifest = null) {
  const loaded = loadPersistedJudgePack(runDir);
  if (!loaded) return null;
  if (loaded.pack.runId !== run.runId) {
    throw new Error(`judge pack runId ${loaded.pack.runId} does not match the current capture run ${run.runId}`);
  }
  if (loaded.pack.project !== run.project) {
    throw new Error(`judge pack project ${loaded.pack.project} does not match the current capture project ${run.project}`);
  }
  const current = captureManifest
    ? { captureManifest, shotsDir: join(resolve(runDir), "shots") }
    : captureManifestForRun(runDir);
  assertPackAssetHashesMatchCapture(loaded.pack, run, current.captureManifest, current.shotsDir);
  return loaded;
}

/**
 * A manual record seals the same immutable judging surface as ui-judge. It
 * must therefore name exactly the pack's targets and current fingerprints,
 * not just reproduce the original PNG hashes. The locked commit preflight
 * additionally opts into the runner's shared packed-artifact verification.
 */
function assertPersistedJudgePackMatchesCapture(
  runDir,
  run,
  headerTargets,
  captureManifest = null,
  { verifyPackedArtifacts = false, judgeLock = null } = {},
) {
  const loaded = assertPersistedJudgePackAssetHashesMatchCapture(runDir, run, captureManifest);
  if (!loaded) return null;
  if (!sameTargetSet(headerTargets, loaded.pack.targets)) {
    throw new Error("judge pack targets do not exactly match the record header targets");
  }
  assertPackFingerprintsMatchCapture(loaded.pack, run);
  if (verifyPackedArtifacts) {
    assertJudgeLock(judgeLock, runDir);
    // Lazy loading avoids a module cycle during startup: judge-runner imports
    // the pack's pure prompt renderer, while this path runs only after both
    // modules are initialized and the record writer owns the judge lease.
    const { verifyPackArtifacts } = require("./judge-runner.cjs");
    verifyPackArtifacts(runDir, loaded.pack);
  }
  return loaded;
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch {
    // The file was fsynced before its same-directory atomic rename. Directory
    // fsync is an extra durability barrier where the host supports it.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeJsonAtomic(path, value, { rename = renameSync } = {}) {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try {
    rename(temporary, path);
    fsyncDirectory(directory);
  } catch (err) {
    try {
      unlinkSync(temporary);
    } catch (cleanupErr) {
      if (cleanupErr.code !== "ENOENT") throw new Error(`${err.message}; could not remove judge-pack temporary file: ${cleanupErr.message}`);
    }
    throw err;
  }
}

function loadExemplars(project) {
  const directory = join(SKILL_DIR, "projects", "exemplars", project);
  if (!existsSync(directory)) return [];
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`judge pack: exemplar directory is unsafe: ${directory}`);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`judge pack: exemplar is unsafe: ${path}`);
      const exemplar = readJson(path, "exemplar");
      const validation = validateExemplar(exemplar);
      if (!validation.valid) {
        throw new Error(`judge pack: invalid exemplar ${path}:\n${validation.errors.map((error) => `  - ${error}`).join("\n")}`);
      }
      return { id: basename(name, ".json"), path: packRelative(SKILL_DIR, path), ...exemplar };
    });
}

/**
 * Available exemplars are copied into the immutable judge build at pack time;
 * an executor never resolves a mutable latest/ pointer. The manifest validator
 * requires this attachment to be digest-bound before this function is reached.
 */
function resolveExemplarScreenshot(exemplar, runDir) {
  const screenshot = exemplar?.screenshot;
  if (screenshot?.status === "unavailable") return null;
  if (screenshot?.status !== "available" || typeof screenshot.attachment !== "string" || !screenshot.attachment) {
    throw new Error(`judge pack: available exemplar ${exemplar?.id ?? "<unknown>"} has no immutable attachment`);
  }
  return fileArtifact(runDir, screenshot.attachment, `exemplar ${exemplar.id}`);
}

function snapshotExemplars({ cfg, exemplars, stateDir, libraryLease = null }) {
  return exemplars.map((exemplar) => {
    const screenshot = exemplar.screenshot;
    if (screenshot.status === "unavailable") return { exemplar };
    const snapshot = snapshotImmutableAsset(cfg, screenshot, { stateDir, libraryLease });
    if (!snapshot) {
      return {
        exemplar: {
          ...exemplar,
          screenshot: {
            ...screenshot,
            status: "unavailable",
            reason: `The immutable exemplar asset is not retained: ${screenshot.libraryPath}`,
          },
        },
      };
    }
    return { exemplar, snapshot };
  });
}

function exemplarEvidence(snapshots) {
  return snapshots.map(({ exemplar }) => ({
    id: exemplar.id,
    path: exemplar.path,
    metadataDigest: canonicalDigest({
      rubricVersion: exemplar.rubricVersion,
      curator: exemplar.curator,
      expectedFindings: exemplar.expectedFindings,
      severity: exemplar.severity,
    }),
    attachment: exemplar.screenshot.status === "available"
      ? {
        status: "available",
        libraryPath: exemplar.screenshot.libraryPath,
        sha256: exemplar.screenshot.sha256,
      }
      : { status: "unavailable" },
  }));
}

/**
 * Prepare target-local evidence before selection. The bytes come from immutable
 * snapshots so later library changes cannot alter what is packed or digested.
 */
function targetIdsWithComparisonAnchors(cfg, targetIds) {
  const selected = new Set(targetIds);
  const required = new Set(targetIds);
  for (const group of cfg.reviewGroups || []) {
    if (group.targetIds.some((targetId) => selected.has(targetId))) required.add(group.anchorId);
  }
  return [...required];
}

function comparisonEvidenceByTarget({ cfg, captureManifest, shotsDir, targetIds, stateDir, libraryLease = null }) {
  const selected = new Set(targetIds);
  const byTarget = assetsByTarget({
    cfg,
    captureManifest,
    shotsDir,
    targetIds: targetIdsWithComparisonAnchors(cfg, targetIds),
  });
  const result = new Map(targetIds.map((targetId) => [targetId, []]));
  const anchorsByGroup = new Map();
  for (const group of cfg.reviewGroups || []) {
    const members = group.targetIds.filter((targetId) => selected.has(targetId));
    if (!members.length) continue;
    let anchors = byTarget.get(group.anchorId) || [];
    if (!anchors.length) {
      anchors = resolveLibraryAnchors(cfg, group, selected, stateDir, libraryLease);
    }
    if (!anchors.length) {
      throw new Error(
        `judge pack: review group ${group.id} needs anchor ${group.anchorId}; no matching retained latest/ asset exists, so capture ${group.anchorId} or include it in --targets`,
      );
    }
    // assetsByTarget is sorted by assetId. Snapshot every relevant anchor asset
    // in that order so a later byte change in any viewport, appearance,
    // variant, or interaction state changes every sibling's stable evidence.
    const resolvedAnchors = anchors.map((anchor) => {
      const sourceBytes = anchor.sourceBytes ?? readFileSync(anchor.sourcePath);
      return { ...anchor, sourceBytes };
    });
    anchorsByGroup.set(group.id, resolvedAnchors);
    const anchorEvidence = resolvedAnchors.map((anchor) => ({
      assetId: anchor.assetId,
      identity: anchor.identity,
      sha256: anchor.librarySource?.sha256 ?? sha256(anchor.sourceBytes),
    }));
    const definition = {
      id: group.id,
      targetIds: group.targetIds,
      anchorId: group.anchorId,
      purpose: group.purpose,
    };
    for (const targetId of members) result.get(targetId).push({ definition, anchors: anchorEvidence });
  }
  return { byTarget: result, anchorsByGroup };
}

function targetJudgmentEvidence({ cfg, run, captureManifest, shotsDir, bundle, targetIds, exemplars, stateDir, libraryLease = null }) {
  const rubricDigest = checklistRubricDigest();
  const snapshots = snapshotExemplars({ cfg, exemplars: exemplars ?? loadExemplars(cfg.name), stateDir, libraryLease });
  const exemplarsForEvidence = exemplarEvidence(snapshots);
  const assetHashes = targetBaseCapturedAssetHashes({ run, captureManifest, shotsDir, targetIds });
  const comparisonEvidence = comparisonEvidenceByTarget({ cfg, captureManifest, shotsDir, targetIds, stateDir, libraryLease });
  const evidenceByTarget = {};
  for (const targetId of targetIds) {
    const context = bundle.judgeContext?.[targetId];
    // A manual record can legitimately have no judge pack/context. Its
    // explicit null digest prevents that absence from silently sharing the
    // digest of a populated Pass 3 context; judge-pack construction still
    // rejects a selected target without its required context below.
    const judgeContextDigest = canonicalDigest(context ?? null);
    const baseEvidenceDigest = canonicalDigest({
      baseCapturedAssetHashes: assetHashes[targetId],
      rubricDigest,
      exemplars: exemplarsForEvidence,
      judgeContextDigest,
      comparisonGroups: comparisonEvidence.byTarget.get(targetId) || [],
    });
    evidenceByTarget[targetId] = targetEvidenceWithPromptDigests({
      baseEvidenceDigest,
      rubricDigest,
    });
  }
  return { evidenceByTarget, snapshots, comparisonAnchors: comparisonEvidence.anchorsByGroup };
}

function materializeExemplars({ snapshots, buildRoot, runDir, artifacts, attachmentHashes }) {
  const destinationDir = join(buildRoot, "exemplars");
  ensureDirectory(destinationDir);
  return snapshots.map(({ exemplar, snapshot }, index) => {
    const screenshot = exemplar.screenshot;
    if (screenshot.status === "unavailable") return exemplar;
    const destination = join(destinationDir, `${String(index + 1).padStart(3, "0")}-${exemplar.id}.png`);
    writeFileSync(destination, snapshot.bytes);
    const attachment = packRelative(runDir, destination);
    attachmentHashes[attachment] = snapshot.sha256;
    artifacts.push(attachment);
    return {
      ...exemplar,
      screenshot: {
        ...screenshot,
        attachment,
      },
    };
  });
}

function fingerprintFor(run, targetId) {
  const value = run.targetFingerprints?.[targetId];
  return typeof value === "string" ? value : value?.fingerprint ?? null;
}

function resolveRequestedTargetIds(run, requestedTargetIds = null) {
  const requested = requestedTargetIds === null ? new Set(run.targetIds) : new Set(requestedTargetIds);
  const unavailable = [...requested].filter((targetId) => !run.targetIds.includes(targetId));
  if (unavailable.length) {
    throw new Error(`judge pack: requested target(s) are absent from the completed capture: ${unavailable.join(", ")}`);
  }
  return run.targetIds.filter((targetId) => requested.has(targetId));
}

function selectTargets(run, judgedFingerprints = {}, evidenceByTarget = {}, requestedTargetIds = null) {
  const requested = new Set(resolveRequestedTargetIds(run, requestedTargetIds));
  const targets = [];
  const skippedTargets = [];
  const reselectedTargets = [];
  for (const targetId of run.targetIds) {
    if (!requested.has(targetId)) continue;
    const fingerprint = fingerprintFor(run, targetId);
    const judgment = judgedFingerprints[targetId];
    const currentEvidence = evidenceByTarget[targetId];
    // A missing fingerprint is explicitly unverifiable, so it cannot be used
    // to suppress a later review under the loop cap. A sealed not-judged
    // target likewise has unresolved evidence and must be selected again,
    // even when its visual fingerprint has not changed. Legacy raw
    // judgepack.v1 fingerprints have no disposition, so they too are
    // intentionally non-suppressing.
    const isCompletedJudgment = judgment &&
      typeof judgment === "object" &&
      judgment.fingerprint === fingerprint &&
      judgment.disposition !== "not-judged";
    if (fingerprint === null || !isCompletedJudgment || !currentEvidence) {
      targets.push(targetId);
      continue;
    }
    // Exact executed prompt bytes are generation-specific because artifact
    // paths include the pack id. Select against the stable inputs that render
    // those prompts, then seal the exact prompt digests into evidenceDigest.
    // Legacy judgments without baseEvidenceDigest deliberately reselect once.
    if (judgment.baseEvidenceDigest !== currentEvidence.baseEvidenceDigest) {
      targets.push(targetId);
      reselectedTargets.push({
        targetId,
        reason: judgment.rubricDigest && judgment.rubricDigest !== currentEvidence.rubricDigest
          ? "rubric-changed"
          : "evidence-changed",
      });
      continue;
    }
    skippedTargets.push({ targetId, reason: "fingerprint and judgment evidence match the durable sealed judgment" });
  }
  return { targets, skippedTargets, reselectedTargets };
}

function changedTargets(run, previousPack, evidenceByTarget = {}) {
  return selectTargets(run, previousPack?.judgedFingerprints || {}, evidenceByTarget).targets;
}

function assetsByTarget({ cfg, captureManifest, shotsDir, targetIds = null }) {
  assignAssetIds(captureManifest, cfg);
  const selected = targetIds === null ? null : new Set(targetIds);
  const result = new Map();
  for (const target of captureManifest.targets || []) {
    if (selected && !selected.has(target.id)) continue;
    const configuredTarget = (cfg.routes || []).find((route) => route.id === target.id) || target;
    const assets = [];
    for (const shot of target.shots || []) {
      if (!shot.assetId || !shot.path) continue;
      // Executor verification crops remain durable, digest-bound evidence,
      // but a later pack must not judge those zooms as ordinary screens.
      if (typeof shot.cropId === "string" && VERIFICATION_CROP_ID.test(shot.cropId)) continue;
      assets.push({
        targetId: target.id,
        assetId: shot.assetId,
        identity: assetIdentity(configuredTarget, shot, captureManifest, cfg),
        sourcePath: sourcePngPath(shotsDir, shot.path, target.id),
      });
    }
    for (const interaction of target.interactions || []) {
      if (!interaction.assetId || !interaction.statePath) continue;
      assets.push({
        targetId: target.id,
        assetId: interaction.assetId,
        identity: assetIdentity(configuredTarget, interaction, captureManifest, cfg, true),
        sourcePath: sourcePngPath(shotsDir, interaction.statePath, target.id),
      });
    }
    result.set(target.id, assets.sort((left, right) => left.assetId.localeCompare(right.assetId)));
  }
  return result;
}

/**
 * A narrow --targets capture can omit its comparison anchor. Snapshot every
 * retained latest/ identity for that anchor so all viewports, appearances,
 * variants, interactions, and crops participate in sibling evidence.
 */
function assetIdForRetainedIdentity(identity) {
  const base = [
    identity.targetId,
    identity.appearance,
    identity.variant,
    identity.interaction ?? "base",
  ].join("/");
  return identity.crop == null ? base : `${base}/crop/${identity.crop}`;
}

function resolveLibraryAnchors(cfg, group, selected, stateDir, libraryLease = null) {
  if (selected.has(group.anchorId)) return [];
  return snapshotLatestAssetsForTarget(cfg, group.anchorId, { stateDir, libraryLease }).map((snapshot) => ({
    targetId: group.anchorId,
    assetId: assetIdForRetainedIdentity(snapshot.identity),
    identity: snapshot.identity,
    sourceBytes: snapshot.bytes,
    librarySource: {
      view: "runs",
      runId: snapshot.runId,
      identity: snapshot.identity,
      assetPath: snapshot.assetPath,
      sha256: snapshot.sha256,
    },
  }));
}

function orderScreenBuckets(cfg, targetIds, byTarget, stateDir, resolvedAnchors = new Map(), libraryLease = null) {
  const selected = new Set(targetIds);
  const consumed = new Set();
  const buckets = [];
  for (const group of cfg.reviewGroups || []) {
    const included = group.targetIds.filter((targetId) => selected.has(targetId));
    if (!included.length) continue;
    let anchorAssets = byTarget.get(group.anchorId) || [];
    const resolvedAnchorAssets = resolvedAnchors.get(group.id) || [];
    if (resolvedAnchorAssets.length) {
      const resolvedAssetIds = new Set(resolvedAnchorAssets.map((asset) => asset.assetId));
      anchorAssets = [
        ...resolvedAnchorAssets,
        ...anchorAssets.filter((asset) => !resolvedAssetIds.has(asset.assetId)),
      ];
    } else if (!anchorAssets.length) {
      anchorAssets = resolveLibraryAnchors(cfg, group, selected, stateDir, libraryLease);
      if (!anchorAssets.length) {
        throw new Error(
          `judge pack: review group ${group.id} needs anchor ${group.anchorId}; no matching retained latest/ asset exists, so capture ${group.anchorId} or include it in --targets`,
        );
      }
    }
    const [comparisonAnchor, ...remainingAnchorAssets] = anchorAssets;
    // An unchanged anchor is comparison context, not a second judging target.
    // Keep exactly its designated anchor image in every split batch; putting
    // all of a reference-heavy anchor's assets ahead of the selected sibling
    // can otherwise construct a zero-target batch.
    const items = [{
      ...comparisonAnchor,
      anchorId: group.anchorId,
      groupId: group.id,
      referenceOnly: !selected.has(group.anchorId),
      comparisonAnchor: true,
    }];
    if (selected.has(group.anchorId)) {
      items.push(...remainingAnchorAssets.map((asset) => ({
        ...asset,
        anchorId: group.anchorId,
        groupId: group.id,
        referenceOnly: false,
      })));
    }
    for (const targetId of group.targetIds) {
      if (!selected.has(targetId) || targetId === group.anchorId) continue;
      const assets = byTarget.get(targetId) || [];
      if (!assets.length) throw new Error(`judge pack: selected target ${targetId} has no captured PNG assets`);
      items.push(...assets.map((asset) => ({ ...asset, anchorId: group.anchorId, groupId: group.id, referenceOnly: false })));
    }
    included.forEach((targetId) => consumed.add(targetId));
    buckets.push({ groupId: group.id, anchorId: group.anchorId, purpose: group.purpose, items });
  }
  const standalone = [];
  for (const targetId of [...selected].filter((id) => !consumed.has(id)).sort()) {
    const assets = byTarget.get(targetId) || [];
    if (!assets.length) throw new Error(`judge pack: selected target ${targetId} has no captured PNG assets`);
    standalone.push(...assets.map((asset) => ({ ...asset, anchorId: null, groupId: null, referenceOnly: false })));
  }
  if (standalone.length) {
    buckets.push({
      groupId: null,
      anchorId: null,
      purpose: "Review standalone targets without an inter-screen comparison anchor.",
      items: standalone,
    });
  }
  return buckets;
}

function resolveImagesPerBatch(cfg) {
  const configured = cfg?.judge?.maxImagesPerBatch;
  if (configured === undefined) return BATCH_MAX;
  if (!Number.isInteger(configured) || configured < 2 || configured > BATCH_MAX) {
    throw new Error(`judge pack: judge.maxImagesPerBatch must be an integer between 2 and ${BATCH_MAX}`);
  }
  return configured;
}

function padBatch(batch, repeated, imagesPerBatch) {
  // The consistency phase wants surrounding screens; pad by repetition, but
  // never above the configured per-batch image bound.
  const padTo = Math.min(BATCH_MIN, imagesPerBatch);
  while (batch.length < padTo) batch.push({ ...repeated, repeatedForContext: true });
  return batch;
}

function splitComparisonGroup(items, imagesPerBatch) {
  const anchor = items[0];
  if (!anchor?.comparisonAnchor) throw new Error("judge pack: comparison group has no first anchor image");
  if (items.some((item) => item.groupId !== anchor.groupId || item.anchorId !== anchor.anchorId)) {
    throw new Error("judge pack: comparison group contains mixed group or anchor identities");
  }
  const batches = [];
  const payload = items.slice(1);
  let cursor = 0;
  do {
    const batch = [{ ...anchor }];
    batch.push(...payload.slice(cursor, cursor + imagesPerBatch - 1));
    cursor += imagesPerBatch - 1;
    batches.push(padBatch(batch, anchor, imagesPerBatch));
  } while (cursor < payload.length);
  return batches;
}

function splitStandaloneScreens(items, imagesPerBatch) {
  if (items.some((item) => item.groupId !== null || item.anchorId !== null)) {
    throw new Error("judge pack: standalone batch contains comparison-group labeling");
  }
  const batches = [];
  let cursor = 0;
  while (cursor < items.length) {
    const batch = items.slice(cursor, cursor + imagesPerBatch);
    cursor += imagesPerBatch;
    batches.push(padBatch(batch, batch[0], imagesPerBatch));
  }
  return batches;
}

function splitBatches(items, imagesPerBatch = BATCH_MAX) {
  if (!items.length) return [];
  return items[0].groupId === null
    ? splitStandaloneScreens(items, imagesPerBatch)
    : splitComparisonGroup(items, imagesPerBatch);
}

function renderTemplate(template, values) {
  return template.replace(/\{\{(batchJson|contextsJson|exemplarsJson)\}\}/g, (_, key) => values[key]);
}

/**
 * Exemplar attachment capacity and availability are fully known once the
 * pack has materialized its immutable exemplar snapshots and image list.
 * Keeping this selection pure lets the builder and executor render the exact
 * same final prompt bytes from the same packed inputs.
 */
function initialExemplarPlan(exemplars, screenAttachmentCount) {
  const entries = exemplars.map((exemplar) => ({ exemplarId: exemplar.id, exemplar }));
  const available = entries.filter(({ exemplar }) => exemplar.screenshot.status === "available");
  const unavailableExemplars = entries.filter(({ exemplar }) => exemplar.screenshot.status === "unavailable");
  const attachedExemplars = available.slice(0, Math.max(0, BATCH_MAX - screenAttachmentCount));
  const attachedIds = new Set(attachedExemplars.map(({ exemplarId }) => exemplarId));
  const unattachedExemplars = available.filter(({ exemplarId }) => !attachedIds.has(exemplarId));
  return { attachedExemplars, unavailableExemplars, unattachedExemplars };
}

function renderInitialPrompt(prompt, { screenAttachmentCount, exemplars }) {
  const { attachedExemplars, unavailableExemplars, unattachedExemplars } = initialExemplarPlan(
    exemplars,
    screenAttachmentCount,
  );
  const attachmentMap = attachedExemplars.map(({ exemplarId, exemplar }, index) => ({
    attachmentIndex: screenAttachmentCount + index + 1,
    exemplarId,
    exemplar,
  }));
  const unavailable = unavailableExemplars.map(({ exemplarId, exemplar }) => ({
    exemplarId,
    exemplar,
    status: "unavailable",
  }));
  const omittedForCapacity = unattachedExemplars.map(({ exemplarId, exemplar }) => ({
    exemplarId,
    exemplar,
    status: "available-but-not-attached",
  }));
  return `${prompt}\n\n## Runtime exemplar attachment map\n\nCurrent-run screenshots occupy attachment indexes 1 through ${screenAttachmentCount}. Each attached exemplar below is identified by its exact attachment index and full curated metadata.\n\n\`\`\`json\n${JSON.stringify({ attachedExemplars: attachmentMap, unavailableExemplars: unavailable, unattachedExemplars: omittedForCapacity }, null, 2)}\n\`\`\`\n\nUnavailable and available-but-not-attached exemplars have no image attachment; do not treat either as visual evidence.`;
}

function templateForBatch(batch) {
  return batch.anchorId === null ? STANDALONE_CHECKLIST_TEMPLATE : CHECKLIST_TEMPLATE;
}

function assertBatchCoverage(targets, batches) {
  if (!targets.length) return;
  const coveredTargets = new Set(batches.flatMap((batch) => batch.targetIds));
  const uncoveredTargets = targets.filter((targetId) => !coveredTargets.has(targetId));
  if (uncoveredTargets.length) {
    throw new Error(`judge pack: generated batches do not cover selected target(s): ${uncoveredTargets.join(", ")}`);
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`judge pack: directory is missing or unsafe: ${path}`);
  }
  return path;
}

/**
 * The default (agent) executor records through ui-review. Once that record is
 * sealed, mirror its selected fingerprint and final disposition into this
 * validated manifest so a later --previous-pack invocation remains useful if
 * the state cursor cannot be read. There is deliberately no independent ad
 * hoc pack-state format.
 */
function updateJudgePackJudgmentsLocked({ cfg, runDir, run, targets, judgeLock }) {
  assertJudgeLock(judgeLock, runDir);
  const judgeRoot = join(resolve(runDir), "judge");
  if (!existsSync(judgeRoot)) return null;
  const judgeStat = lstatSync(judgeRoot);
  if (!judgeStat.isDirectory() || judgeStat.isSymbolicLink()) {
    throw new Error(`judge pack: judge directory is missing or unsafe: ${judgeRoot}`);
  }
  const path = join(judgeRoot, "manifest.json");
  if (!existsSync(path)) return null;
  const manifestStat = lstatSync(path);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(`judge pack: manifest is missing or unsafe: ${path}`);
  }
  const pack = readJson(path, "judge-pack manifest");
  const validation = validateJudgePack(pack);
  if (!validation.valid) {
    throw new Error(`judge pack: cannot persist sealed fingerprints to an invalid manifest:\n${validation.errors.map((error) => `  - ${error}`).join("\n")}`);
  }
  if (pack.project !== cfg.name || pack.runId !== run.runId) {
    throw new Error(`judge pack: manifest does not belong to sealed run ${run.runId}`);
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("judge pack: sealed record has no targets to persist");
  }
  const next = structuredClone(pack);
  let updated = false;
  for (const target of targets) {
    if (typeof target.evidenceDigest !== "string" || typeof target.rubricDigest !== "string") {
      throw new Error(`judge pack: sealed target ${target.targetId} has no judgment-evidence digest`);
    }
    const targetEvidence = {
      baseEvidenceDigest: target.baseEvidenceDigest,
      evidenceDigest: target.evidenceDigest,
      rubricDigest: target.rubricDigest,
      promptDigests: target.promptDigests,
    };
    const judgedFingerprint = {
      fingerprint: target.fingerprint,
      ...targetEvidence,
      disposition: target.disposition,
    };
    next.targetJudgmentEvidence ??= {};
    next.judgedFingerprints ??= {};
    if (!isDeepStrictEqual(next.targetJudgmentEvidence[target.targetId], targetEvidence)) {
      next.targetJudgmentEvidence[target.targetId] = targetEvidence;
      updated = true;
    }
    if (!isDeepStrictEqual(next.judgedFingerprints[target.targetId], judgedFingerprint)) {
      next.judgedFingerprints[target.targetId] = judgedFingerprint;
      updated = true;
    }
  }
  if (!updated) return { path, pack, updated: false };
  const nextValidation = validateJudgePack(next);
  if (!nextValidation.valid) {
    throw new Error(`judge pack: refusing to persist invalid sealed fingerprints:\n${nextValidation.errors.map((error) => `  - ${error}`).join("\n")}`);
  }
  writeJsonAtomic(path, next);
  return { path, pack: next, updated: true };
}

function updateJudgePackJudgments(options) {
  const judgeRoot = join(resolve(options.runDir), "judge");
  // Recording a run that has never had a judge pack remains a no-op here.
  // Callers that already hold the run lease pass it through, closing the race
  // between this existence check and a concurrent pack build.
  if (!options.judgeLock && !existsSync(judgeRoot)) return null;
  const judgeLock = options.judgeLock ?? acquireJudgeLock(options.runDir, {
    waitMs: options.judgeLockWaitMs,
    createJudgeDir: false,
    projectRoot: options.cfg?.root,
  });
  const ownsJudgeLock = !options.judgeLock;
  try {
    return updateJudgePackJudgmentsLocked({ ...options, judgeLock });
  } finally {
    if (ownsJudgeLock) releaseJudgeLock(judgeLock);
  }
}

/**
 * Build a new generation under judge/builds/<packId>/ and publish its root
 * manifest. Older pack artifacts remain intact for diagnosis.
 */
function buildJudgePackLocked({ cfg, runDir, previousPackPath = null, stateDir = libraryStateDir(), targetIds = null, afterSourceResolution = null, exemplarDefinitions = null, writeRootManifest = writeJsonAtomic, judgeLock }) {
  assertJudgeLock(judgeLock, runDir);
  const verificationCropJournal = join(runDir, "judge", "verification-crop.journal.json");
  let hasVerificationCropJournal;
  try {
    hasVerificationCropJournal = pathEntryExists(verificationCropJournal);
  } catch (err) {
    throw new Error(`judge pack: could not inspect pending verification-crop journal ${verificationCropJournal}: ${err.message}`);
  }
  if (hasVerificationCropJournal) {
    try {
      // Lazy loading avoids making the deterministic builder depend on any
      // executor path unless there is an interrupted transaction to resolve.
      const { recoverPendingVerificationCropTransaction } = require("./judge-runner.cjs");
      recoverPendingVerificationCropTransaction({ runDir, judgeLock });
    } catch (err) {
      throw new Error(
        `judge pack: refusing to rebuild because pending verification-crop journal recovery could not complete at ${verificationCropJournal}: ${err.message}. ` +
        "Restore the journal's referenced judge manifest and crop artifacts, then retry the rebuild.",
      );
    }
  }
  // Capture identity is intentionally loaded only after the per-run judge
  // lease is held and verification-crop recovery has finished. Callers may
  // pass stale objects, but they can never become pack inputs.
  const { finalizeCommittedReview, loadCompletedCaptureRun } = require("./ui-review");
  const captureRun = loadCompletedCaptureRun(runDir, cfg);
  const currentRun = captureRun.run;
  const libraryLease = acquireLibraryLock(cfg, stateDir, {
    finalizeRecoveredReview({ libraryLease: recoveryLease, recovery }) {
      if (recovery.runId !== currentRun.runId) {
        // The project-scoped journal is finalized from its own immutable
        // target identity by the library. A different active run has no pack
        // mirror it can safely update while holding this run's judge lock.
        return null;
      }
      return finalizeCommittedReview({
        cfg,
        captureRun,
        reviewPath: recovery.reviewPath,
        libraryLease: recoveryLease,
        judgeLock,
        expectedFinalization: recovery.finalization,
      });
    },
  });
  try {
  const bundlePath = join(runDir, "bundle.json");
  const manifestPath = join(runDir, "shots", "manifest.json");
  if (!existsSync(bundlePath)) throw new Error(`judge pack: bundle.json is required to reuse Pass 3 judgeContext: ${bundlePath}`);
  if (!existsSync(manifestPath)) throw new Error(`judge pack: capture manifest is required: ${manifestPath}`);
  const bundle = readJson(bundlePath, "capture bundle");
  const captureManifest = readJson(manifestPath, "capture manifest");
  if (!bundle?.judgeContext || typeof bundle.judgeContext !== "object" || Array.isArray(bundle.judgeContext)) {
    throw new Error("judge pack: bundle has no Pass 3 judgeContext; rebuild the capture bundle before judging");
  }

  const judgeRoot = join(runDir, "judge");
  ensureDirectory(judgeRoot);
  ensureDirectory(join(judgeRoot, "builds"));
  // A caller may explicitly supply a validated prior pack when the durable
  // state root is unavailable. Otherwise every new capture consults the
  // project cursor, never the mutable manifest in this capture directory.
  const previous = previousPackPath
    ? readPreviousPack(resolve(previousPackPath), cfg)
    : null;
  const curatedExemplars = exemplarDefinitions ?? loadExemplars(cfg.name);
  // Resolve the explicit request before touching any target evidence. Only
  // those targets and the comparison anchors they actually need may cause PNG
  // validation or a retained-library lookup.
  const evidenceTargetIds = resolveRequestedTargetIds(currentRun, targetIds);
  const preparedEvidence = targetJudgmentEvidence({
    cfg,
    run: currentRun,
    captureManifest,
    shotsDir: join(runDir, "shots"),
    bundle,
    targetIds: evidenceTargetIds,
    exemplars: curatedExemplars,
    stateDir,
    libraryLease,
  });
  const priorJudgments = previous
    ? previous.judgedFingerprints
    : Object.fromEntries(
      Object.entries(readJudgmentState(cfg, { stateDir, libraryLease }).targets).map(([targetId, judgment]) => [targetId, {
        fingerprint: judgment.fingerprint,
        baseEvidenceDigest: judgment.baseEvidenceDigest,
        evidenceDigest: judgment.evidenceDigest,
        rubricDigest: judgment.rubricDigest,
        promptDigests: judgment.promptDigests,
        disposition: judgment.disposition,
      }]),
    );
  const { targets, skippedTargets, reselectedTargets } = selectTargets(
    currentRun,
    priorJudgments,
    preparedEvidence.evidenceByTarget,
    targetIds,
  );
  // The manifest may only carry the judgments it relies on — the skipped
  // targets. A target selected for fresh judging has, by definition,
  // outgrown its sealed judgment (new fingerprint or new evidence); copying
  // that stale entry into the pack makes the runner's consistency check
  // read the pack as corrupt and demand a rebuild that reproduces the same
  // pack. Found live on the first cross-run pack build (2026-08-12).
  const skippedTargetIds = new Set(skippedTargets.map((entry) => entry.targetId));
  const carriedJudgments = Object.fromEntries(
    Object.entries(priorJudgments || {}).filter(([targetId]) => skippedTargetIds.has(targetId)),
  );
  for (const targetId of targets) {
    if (!bundle.judgeContext[targetId]) {
      throw new Error(`judge pack: bundle has no judgeContext slice for target ${targetId}`);
    }
  }

  const packId = randomUUID();
  const buildRoot = join(judgeRoot, "builds", packId);
  const imagesDir = join(buildRoot, "images");
  const contextsDir = join(buildRoot, "contexts");
  const batchesDir = join(buildRoot, "batches");
  const promptsDir = join(buildRoot, "prompts");
  mkdirSync(buildRoot, { mode: 0o700 });
  for (const directory of [imagesDir, contextsDir, batchesDir, promptsDir]) ensureDirectory(directory);

  const artifacts = [];
  const contexts = targets.sort().map((targetId) => {
    const path = join(contextsDir, `${targetId}.json`);
    // This is intentionally a straight serialization of bundle.judgeContext;
    // the pack must never rebuild, enrich, or widen the Pass 3 slice.
    writeJson(path, bundle.judgeContext[targetId]);
    const relativePath = packRelative(runDir, path);
    artifacts.push(relativePath);
    return { targetId, path: relativePath };
  });

  const screenBatches = targets.length
    ? orderScreenBuckets(
      cfg,
      targets,
      assetsByTarget({
        cfg,
        captureManifest,
        shotsDir: join(runDir, "shots"),
        targetIds: targetIdsWithComparisonAnchors(cfg, targets),
      }),
      stateDir,
      preparedEvidence.comparisonAnchors,
      libraryLease,
    )
      .flatMap((bucket) => splitBatches(bucket.items, resolveImagesPerBatch(cfg)).map((items) => ({ ...bucket, items })))
    : [];
  // Test-only injection point: a later latest/ publication must not affect
  // an anchor already snapshotted under the library lease above.
  if (afterSourceResolution) afterSourceResolution();
  const attachmentHashes = cropAttachmentHashes({
    run: currentRun,
    captureManifest,
    shotsDir: join(runDir, "shots"),
    targetIds: targets,
  });
  const exemplars = materializeExemplars({
    snapshots: preparedEvidence.snapshots,
    buildRoot,
    runDir,
    artifacts,
    attachmentHashes,
  });
  const sourceImages = new Map();
  for (const screenBatch of screenBatches) {
    for (const screen of screenBatch.items) {
      if (sourceImages.has(screen.assetId)) continue;
      const index = String(sourceImages.size + 1).padStart(3, "0");
      const destination = join(imagesDir, `${index}-${screen.targetId}.png`);
      const source = screen.sourceBytes ?? readFileSync(screen.sourcePath);
      if (screen.librarySource?.sha256 && sha256(source) !== screen.librarySource.sha256) {
        throw new Error(`judge pack: retained anchor bytes no longer match immutable provenance for ${screen.assetId}`);
      }
      const resized = resizeLongEdgePng(source, JUDGE_LONG_EDGE);
      writeFileSync(destination, resized);
      const relativePath = packRelative(runDir, destination);
      sourceImages.set(screen.assetId, relativePath);
      attachmentHashes[relativePath] = sha256(resized);
      artifacts.push(relativePath);
    }
  }

  const batches = [];
  for (const [index, screenBatch] of screenBatches.entries()) {
    const screensInBatch = screenBatch.items;
    const id = `batch-${String(index + 1).padStart(2, "0")}`;
    const { anchorId, groupId, purpose } = screenBatch;
    const imageListPath = join(batchesDir, `${id}.images.json`);
    const promptPath = join(promptsDir, `${id}.md`);
    const images = screensInBatch.map((screen, imageIndex) => ({
      order: imageIndex + 1,
      targetId: screen.targetId,
      assetId: screen.assetId,
      image: sourceImages.get(screen.assetId),
      sha256: attachmentHashes[sourceImages.get(screen.assetId)],
      anchor: anchorId !== null && imageIndex === 0,
      referenceOnly: screen.referenceOnly === true,
      ...(screen.librarySource ? { librarySource: screen.librarySource } : {}),
      ...(screen.repeatedForContext ? { repeatedForContext: true } : {}),
    }));
    const targetIds = [...new Set(images.filter((image) => !image.referenceOnly).map((image) => image.targetId))];
    const imageList = {
      version: "judge-image-list.v1",
      id,
      groupId,
      anchorId,
      targetIds,
      purpose,
      images,
    };
    writeJson(imageListPath, imageList);
    const imageListDigest = sha256(readFileSync(imageListPath));
    const batch = {
      id,
      groupId,
      anchorId,
      targetIds,
      checklistPhases: CHECKLIST_PHASES,
      imageList: packRelative(runDir, imageListPath),
      imageListDigest,
      prompt: packRelative(runDir, promptPath),
    };
    const contextsForBatch = Object.fromEntries(
      targetIds.filter((targetId) => bundle.judgeContext[targetId]).map((targetId) => [targetId, bundle.judgeContext[targetId]]),
    );
    const template = readFileSync(templateForBatch(batch), "utf8");
    const promptBytes = Buffer.from(renderTemplate(template, {
      batchJson: JSON.stringify({ ...batch, images: imageList.images }, null, 2),
      contextsJson: JSON.stringify(contextsForBatch, null, 2),
      exemplarsJson: JSON.stringify(exemplars, null, 2),
    }), "utf8");
    writeFileSync(promptPath, promptBytes);
    const finalPromptBytes = Buffer.from(renderInitialPrompt(promptBytes.toString("utf8"), {
      screenAttachmentCount: imageList.images.length,
      exemplars,
    }), "utf8");
    batch.promptDigest = sha256(finalPromptBytes);
    artifacts.push(batch.imageList, batch.prompt);
    batches.push(batch);
  }

  assertBatchCoverage(targets, batches);

  const cropRequestsPath = join(buildRoot, "crop-requests.json");
  writeJson(cropRequestsPath, []);
  artifacts.push(packRelative(runDir, cropRequestsPath));
  const targetFingerprints = Object.fromEntries(targets.map((targetId) => [targetId, fingerprintFor(currentRun, targetId)]));
  const targetEvidence = bindTargetPromptDigests(
    Object.fromEntries(targets.map((targetId) => [targetId, preparedEvidence.evidenceByTarget[targetId]])),
    batches,
  );
  const targetShotHashes = targetCaptureAssetHashes({ run: currentRun, targetIds: targets });
  const pack = {
    version: "judgepack.v1",
    packId,
    runId: currentRun.runId,
    project: cfg.name,
    createdAt: new Date().toISOString(),
    targets,
    targetFingerprints,
    targetJudgmentEvidence: targetEvidence,
    judgedFingerprints: carriedJudgments,
    targetShotHashes,
    attachmentHashes,
    skippedTargets,
    reselectedTargets,
    batches,
    contexts,
    cropRequests: packRelative(runDir, cropRequestsPath),
    exemplars,
    artifacts: [...new Set(["judge/manifest.json", ...artifacts])].sort(),
  };
  const validation = validateJudgePack(pack);
  if (!validation.valid) throw new Error(`judge pack: generated manifest is invalid:\n${validation.errors.map((error) => `  - ${error}`).join("\n")}`);
  writeRootManifest(join(judgeRoot, "manifest.json"), pack);
  return { path: join(judgeRoot, "manifest.json"), pack };
  } finally {
    releaseLibraryLock(libraryLease);
  }
}

function buildJudgePack(options) {
  const judgeLock = options.judgeLock ?? acquireJudgeLock(options.runDir, {
    waitMs: options.judgeLockWaitMs,
    createJudgeDir: true,
    projectRoot: options.cfg?.root,
  });
  const ownsJudgeLock = !options.judgeLock;
  try {
    return buildJudgePackLocked({ ...options, judgeLock });
  } finally {
    if (ownsJudgeLock) releaseJudgeLock(judgeLock);
  }
}

module.exports = {
  BATCH_MAX,
  BATCH_MIN,
  CHECKLIST_TEMPLATE,
  JUDGE_LONG_EDGE,
  VERIFICATION_TEMPLATE,
  buildJudgePack,
  checklistRubricDigest,
  changedTargets,
  assertPackAssetHashesMatchCapture,
  assertPackFingerprintsMatchCapture,
  assertPersistedJudgePackAssetHashesMatchCapture,
  assertPersistedJudgePackMatchesCapture,
  initialExemplarPlan,
  loadExemplars,
  loadChecklistRubric,
  renderInitialPrompt,
  resolveExemplarScreenshot,
  splitBatches,
  targetEvidenceWithPromptDigests,
  targetJudgmentEvidence,
  updateJudgePackJudgments,
  writeJsonAtomic,
};
