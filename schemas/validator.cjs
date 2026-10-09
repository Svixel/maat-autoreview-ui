/**
 * Versioned contract validation for autoreview-ui.
 *
 * The skill deliberately has no general-purpose schema dependency: these four
 * small, stable records are easier to audit as explicit validation than as a
 * hidden transitive runtime. The JSON Schema files remain the portable
 * contract; this module enforces their cross-field and event-log rules.
 */

"use strict";

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { isSafePathSegment, isSafeTargetId } = require("../scripts/capture-contract.cjs");
const { MAX_TIMEOUT_MS, WEB_CAPTURE_TIMEOUT_KEYS, isValidTimeoutMs } = require("../scripts/web-capture-timeouts.cjs");
const { RULE_IDS } = require("../scripts/ui-scan-core.cjs");
const { RN_RULE_IDS } = require("../scripts/ui-scan-core-rn.cjs");

// The rule ids each scan ruleset can emit; scan.ignoreRules must name ids of
// the configured ruleset so a typo fails validation instead of ignoring nothing.
const SCAN_RULE_IDS = Object.freeze({ "web-css": RULE_IDS, "rn-stylesheet": RN_RULE_IDS });

const SCHEMA_DIR = __dirname;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{7,64}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const SCOPES = new Set(["in-scope", "follow-up", "escalate"]);
const INITIAL_VERDICTS = new Set(["finding", "not-judged"]);
const VERIFIER_VERDICTS = new Set(["confirmed", "rejected", "not-judged"]);
const DISPOSITIONS = new Set(["accepted", "rejected", "not-judged"]);
const CHECKLIST_PHASES = Object.freeze(["visual-polish", "layout-economy", "consistency", "accessibility", "intent"]);
const COVERAGE_RESULTS = new Set(["clean", "findings", "not-judged"]);
const DEFAULT_MAX_FINDINGS_PER_BATCH = 12;

function schemas() {
  return Object.fromEntries(
    ["finding.v2.json", "review-event.v1.json", "receipt.v1.json", "config.v2.json", "judgepack.v1.json", "judge-response.v1.json", "judgment-state.v1.json", "exemplar.v1.json"].map((name) => [
      name,
      JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8")),
    ]),
  );
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validationResult(errors) {
  return { valid: errors.length === 0, errors };
}

function push(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function requiredObject(value, path, errors) {
  if (!isObject(value)) {
    push(errors, path, "must be an object");
    return false;
  }
  return true;
}

function nonEmptyString(value, path, errors) {
  if (typeof value !== "string" || !value.trim()) push(errors, path, "must be a non-empty string");
}

function uuid(value, path, errors) {
  if (typeof value !== "string" || !UUID_RE.test(value)) push(errors, path, "must be a UUID");
}

function isoDate(value, path, errors) {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    push(errors, path, "must be an RFC 3339 date-time");
  }
}

function noUnexpected(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) push(errors, `${path}.${key}`, "is not allowed");
  }
}

function validateRegion(region, path, errors) {
  if (!requiredObject(region, path, errors)) return;
  noUnexpected(region, new Set(["x", "y", "w", "h", "normalized"]), path, errors);
  for (const key of ["x", "y", "w", "h", "normalized"]) {
    if (!(key in region)) push(errors, `${path}.${key}`, "is required");
  }
  for (const key of ["x", "y", "w", "h"]) {
    if (typeof region[key] !== "number" || !Number.isFinite(region[key])) {
      push(errors, `${path}.${key}`, "must be a finite number");
    }
  }
  if (region.normalized !== true) push(errors, `${path}.normalized`, "must be true");
  if (typeof region.x === "number" && (region.x < 0 || region.x > 1)) push(errors, `${path}.x`, "must be within 0..1");
  if (typeof region.y === "number" && (region.y < 0 || region.y > 1)) push(errors, `${path}.y`, "must be within 0..1");
  if (typeof region.w === "number" && (region.w <= 0 || region.w > 1)) push(errors, `${path}.w`, "must be within (0, 1]");
  if (typeof region.h === "number" && (region.h <= 0 || region.h > 1)) push(errors, `${path}.h`, "must be within (0, 1]");
  if (typeof region.x === "number" && typeof region.w === "number" && region.x + region.w > 1) {
    push(errors, path, "must stay within the asset horizontally (x + w <= 1)");
  }
  if (typeof region.y === "number" && typeof region.h === "number" && region.y + region.h > 1) {
    push(errors, path, "must stay within the asset vertically (y + h <= 1)");
  }
}

function validateCandidate(candidate, path, errors, { finalized = false } = {}) {
  if (!requiredObject(candidate, path, errors)) return;
  const allowed = new Set([
    "id", "ruleId", "targetId", "assetId", "region", "cropId", "cropDigest", "evidence", "priority", "confidence", "initialVerdict", "scope",
  ]);
  if (finalized) {
    allowed.add("verifierVerdict");
    allowed.add("disposition");
    allowed.add("exemplarRefs");
  }
  noUnexpected(candidate, allowed, path, errors);
  for (const key of ["id", "ruleId", "targetId", "assetId", "region", "evidence", "priority", "confidence", "initialVerdict", "scope"]) {
    if (!(key in candidate)) push(errors, `${path}.${key}`, "is required");
  }
  uuid(candidate.id, `${path}.id`, errors);
  for (const key of ["ruleId", "targetId", "assetId", "evidence"]) nonEmptyString(candidate[key], `${path}.${key}`, errors);
  if (candidate.cropId !== undefined) nonEmptyString(candidate.cropId, `${path}.cropId`, errors);
  if (candidate.cropId === undefined && candidate.cropDigest !== undefined) {
    push(errors, `${path}.cropDigest`, "requires cropId");
  }
  if (candidate.cropDigest !== undefined && (typeof candidate.cropDigest !== "string" || !SHA256_RE.test(candidate.cropDigest))) {
    push(errors, `${path}.cropDigest`, "must be a sha256: digest");
  }
  validateRegion(candidate.region, `${path}.region`, errors);
  if (!PRIORITIES.has(candidate.priority)) push(errors, `${path}.priority`, "must be P0, P1, P2, or P3");
  if (typeof candidate.confidence !== "number" || candidate.confidence < 0 || candidate.confidence > 1) {
    push(errors, `${path}.confidence`, "must be within 0..1");
  }
  if (!INITIAL_VERDICTS.has(candidate.initialVerdict)) push(errors, `${path}.initialVerdict`, "is invalid");
  if (!SCOPES.has(candidate.scope)) push(errors, `${path}.scope`, "is invalid");
}

function validateFinding(finding) {
  const errors = [];
  if (!requiredObject(finding, "finding", errors)) return validationResult(errors);
  const allowed = new Set([
    "id", "ruleId", "targetId", "assetId", "region", "cropId", "cropDigest", "evidence", "priority", "confidence", "initialVerdict", "verifierVerdict", "disposition", "exemplarRefs", "scope",
  ]);
  noUnexpected(finding, allowed, "finding", errors);
  validateCandidate(finding, "finding", errors, { finalized: true });
  for (const key of ["verifierVerdict", "disposition"]) {
    if (!(key in finding)) push(errors, `finding.${key}`, "is required");
  }
  if (!VERIFIER_VERDICTS.has(finding.verifierVerdict)) push(errors, "finding.verifierVerdict", "is invalid");
  if (!DISPOSITIONS.has(finding.disposition)) push(errors, "finding.disposition", "is invalid");
  if (finding.exemplarRefs !== undefined) {
    if (!Array.isArray(finding.exemplarRefs) || finding.exemplarRefs.some((value) => typeof value !== "string" || !value.trim())) {
      push(errors, "finding.exemplarRefs", "must be an array of non-empty strings");
    } else if (new Set(finding.exemplarRefs).size !== finding.exemplarRefs.length) {
      push(errors, "finding.exemplarRefs", "must not contain duplicates");
    }
  }
  if (finding.verifierVerdict === "confirmed" && finding.disposition !== "accepted") {
    push(errors, "finding.disposition", "must be accepted after a confirmed verification");
  }
  if (finding.verifierVerdict === "rejected" && finding.disposition !== "rejected") {
    push(errors, "finding.disposition", "must be rejected after a rejected verification");
  }
  if (finding.verifierVerdict === "not-judged" && finding.disposition !== "not-judged") {
    push(errors, "finding.disposition", "must be not-judged after a not-judged verification");
  }
  if (finding.initialVerdict === "not-judged" && finding.verifierVerdict !== "not-judged") {
    push(errors, "finding.verifierVerdict", "must remain not-judged when the initial verdict is not-judged");
  }
  return validationResult(errors);
}

/**
 * The JSON Schema expresses the fixed envelope. This companion validator
 * binds a response to the runtime batch target ids, so an empty/partial
 * findings list can never masquerade as a completed clean review.
 */
function validateJudgeResponse(response, {
  targetIds,
  phases = CHECKLIST_PHASES,
  maxFindings = DEFAULT_MAX_FINDINGS_PER_BATCH,
} = {}) {
  const errors = [];
  if (!requiredObject(response, "judgeResponse", errors)) return validationResult(errors);
  noUnexpected(response, new Set(["findings", "coverage"]), "judgeResponse", errors);
  for (const key of ["findings", "coverage"]) if (!(key in response)) push(errors, `judgeResponse.${key}`, "is required");
  if (!Array.isArray(response.findings)) push(errors, "judgeResponse.findings", "must be an array");
  if (!Number.isInteger(maxFindings) || maxFindings < 1) {
    push(errors, "judgeResponse maxFindings", "must be a positive integer");
  } else if (Array.isArray(response.findings) && response.findings.length > maxFindings) {
    push(errors, "judgeResponse.findings", `must contain at most ${maxFindings} findings (received ${response.findings.length})`);
  }
  if (!Array.isArray(targetIds) || targetIds.length === 0 || targetIds.some((targetId) => !isSafeTargetId(targetId)) || new Set(targetIds || []).size !== targetIds?.length) {
    push(errors, "judgeResponse targetIds", "must be a non-empty unique array of safe target ids");
  }
  if (!Array.isArray(phases) || phases.length !== CHECKLIST_PHASES.length || phases.some((phase, index) => phase !== CHECKLIST_PHASES[index])) {
    push(errors, "judgeResponse phases", "must be the canonical checklist phases");
  }
  if (!Array.isArray(response.coverage)) {
    push(errors, "judgeResponse.coverage", "must be an array");
    return validationResult(errors);
  }
  const knownTargets = new Set(Array.isArray(targetIds) ? targetIds : []);
  const knownPhases = new Set(Array.isArray(phases) ? phases : []);
  const seen = new Set();
  response.coverage.forEach((entry, index) => {
    const path = `judgeResponse.coverage[${index}]`;
    if (!requiredObject(entry, path, errors)) return;
    noUnexpected(entry, new Set(["targetId", "phase", "result"]), path, errors);
    for (const key of ["targetId", "phase", "result"]) if (!(key in entry)) push(errors, `${path}.${key}`, "is required");
    if (!knownTargets.has(entry.targetId)) push(errors, `${path}.targetId`, "must name a target in this batch");
    if (!knownPhases.has(entry.phase)) push(errors, `${path}.phase`, "must be a checklist phase for this batch");
    if (!COVERAGE_RESULTS.has(entry.result)) push(errors, `${path}.result`, "must be clean, findings, or not-judged");
    const pair = `${entry.targetId}\u0000${entry.phase}`;
    if (seen.has(pair)) push(errors, path, "duplicates a targetId/phase coverage entry");
    seen.add(pair);
  });
  for (const targetId of knownTargets) {
    for (const phase of knownPhases) {
      if (!seen.has(`${targetId}\u0000${phase}`)) {
        push(errors, "judgeResponse.coverage", `is missing ${targetId}/${phase}`);
      }
    }
  }
  return validationResult(errors);
}

function validateExemplar(exemplar) {
  const errors = [];
  if (!requiredObject(exemplar, "exemplar", errors)) return validationResult(errors);
  noUnexpected(exemplar, new Set(["screenshot", "rubricVersion", "curator", "expectedFindings", "severity"]), "exemplar", errors);
  for (const key of ["screenshot", "rubricVersion", "curator", "expectedFindings", "severity"]) {
    if (!(key in exemplar)) push(errors, `exemplar.${key}`, "is required");
  }
  if (!requiredObject(exemplar.screenshot, "exemplar.screenshot", errors)) {
    // The remaining metadata can still report useful errors.
  } else {
    noUnexpected(exemplar.screenshot, new Set(["status", "libraryPath", "sha256", "attachment", "reason"]), "exemplar.screenshot", errors);
    if (!["available", "unavailable"].includes(exemplar.screenshot.status)) {
      push(errors, "exemplar.screenshot.status", "must be available or unavailable");
    }
    if (exemplar.screenshot.status === "available") {
      nonEmptyString(exemplar.screenshot.libraryPath, "exemplar.screenshot.libraryPath", errors);
      if (typeof exemplar.screenshot.libraryPath === "string" && !/^runs\/[0-9a-f-]{36}\/.+\.png$/.test(exemplar.screenshot.libraryPath)) {
        push(errors, "exemplar.screenshot.libraryPath", "must be a run-qualified PNG path");
      }
      if (typeof exemplar.screenshot.sha256 !== "string" || !SHA256_RE.test(exemplar.screenshot.sha256)) {
        push(errors, "exemplar.screenshot.sha256", "must be a sha256: digest");
      }
    }
    if (exemplar.screenshot.status === "unavailable") {
      nonEmptyString(exemplar.screenshot.reason, "exemplar.screenshot.reason", errors);
    }
    if (exemplar.screenshot.attachment !== undefined) nonEmptyString(exemplar.screenshot.attachment, "exemplar.screenshot.attachment", errors);
  }
  nonEmptyString(exemplar.rubricVersion, "exemplar.rubricVersion", errors);
  nonEmptyString(exemplar.curator, "exemplar.curator", errors);
  if (!Array.isArray(exemplar.expectedFindings) || exemplar.expectedFindings.length === 0 || exemplar.expectedFindings.some((value) => typeof value !== "string" || !value.trim())) {
    push(errors, "exemplar.expectedFindings", "must be a non-empty array of strings");
  }
  if (!PRIORITIES.has(exemplar.severity)) push(errors, "exemplar.severity", "must be P0, P1, P2, or P3");
  return validationResult(errors);
}

function validateFingerprintMap(value, path, errors) {
  if (!requiredObject(value, path, errors)) return;
  for (const [targetId, fingerprint] of Object.entries(value)) {
    if (!isSafeTargetId(targetId)) push(errors, `${path}.${targetId}`, "must use a safe target id");
    if (fingerprint !== null && (typeof fingerprint !== "string" || !SHA256_RE.test(fingerprint))) {
      push(errors, `${path}.${targetId}`, "must be a sha256: digest or null");
    }
  }
}

function validateTargetShotHashMap(value, path, errors) {
  if (!requiredObject(value, path, errors)) return;
  for (const [targetId, assets] of Object.entries(value)) {
    const targetPath = `${path}.${targetId}`;
    if (!isSafeTargetId(targetId)) push(errors, targetPath, "must use a safe target id");
    if (!isObject(assets) || Object.keys(assets).length === 0) {
      push(errors, targetPath, "must be a non-empty object of captured asset hashes");
      continue;
    }
    for (const [asset, hash] of Object.entries(assets)) {
      nonEmptyString(asset, `${targetPath}.${asset}`, errors);
      if (typeof asset === "string" && asset.includes("\\")) {
        push(errors, `${targetPath}.${asset}`, "must use forward-slash POSIX path separators");
      }
      if (typeof hash !== "string" || !SHA256_RE.test(hash)) {
        push(errors, `${targetPath}.${asset}`, "must be a sha256: digest");
      }
    }
  }
}

function validateAttachmentHashMap(value, path, errors) {
  if (!requiredObject(value, path, errors)) return;
  for (const [asset, hash] of Object.entries(value)) {
    nonEmptyString(asset, `${path}.${asset}`, errors);
    if (typeof hash !== "string" || !SHA256_RE.test(hash)) {
      push(errors, `${path}.${asset}`, "must be a sha256: digest");
    }
  }
}

function validateDigestMap(value, path, errors) {
  if (!requiredObject(value, path, errors)) return;
  for (const [key, digest] of Object.entries(value)) {
    nonEmptyString(key, `${path}.${key}`, errors);
    if (typeof digest !== "string" || !SHA256_RE.test(digest)) {
      push(errors, `${path}.${key}`, "must be a sha256: digest");
    }
  }
}

function validateTargetJudgmentEvidenceMap(value, path, errors) {
  // Absent maps are the published judgepack.v1 legacy representation. New
  // packs always write one; old packs remain readable and therefore cannot
  // suppress a target without an evidenceDigest in its judgment entry.
  if (value === undefined) return;
  if (!requiredObject(value, path, errors)) return;
  for (const [targetId, evidence] of Object.entries(value)) {
    const evidencePath = `${path}.${targetId}`;
    if (!isSafeTargetId(targetId)) push(errors, evidencePath, "must use a safe target id");
    if (!requiredObject(evidence, evidencePath, errors)) continue;
    noUnexpected(evidence, new Set(["baseEvidenceDigest", "evidenceDigest", "rubricDigest", "promptDigests"]), evidencePath, errors);
    for (const key of ["baseEvidenceDigest", "evidenceDigest", "rubricDigest"]) {
      if (!(key in evidence)) push(errors, `${evidencePath}.${key}`, "is required");
      else if (typeof evidence[key] !== "string" || !SHA256_RE.test(evidence[key])) {
        push(errors, `${evidencePath}.${key}`, "must be a sha256: digest");
      }
    }
    if (!("promptDigests" in evidence)) push(errors, `${evidencePath}.promptDigests`, "is required");
    else validateDigestMap(evidence.promptDigests, `${evidencePath}.promptDigests`, errors);
  }
}

function validateJudgedFingerprintMap(value, path, errors) {
  if (!requiredObject(value, path, errors)) return;
  for (const [targetId, judgment] of Object.entries(value)) {
    const entryPath = `${path}.${targetId}`;
    if (!isSafeTargetId(targetId)) push(errors, entryPath, "must use a safe target id");
    // Pre-disposition judgepack.v1 manifests stored a raw fingerprint. Keep
    // them readable, but callers must treat them as unresolved because that
    // representation cannot prove the target was not `not-judged`.
    if (judgment === null || typeof judgment === "string") {
      if (judgment !== null && !SHA256_RE.test(judgment)) push(errors, entryPath, "must be a sha256: digest or null");
      continue;
    }
    if (!requiredObject(judgment, entryPath, errors)) continue;
    noUnexpected(judgment, new Set(["fingerprint", "baseEvidenceDigest", "evidenceDigest", "rubricDigest", "promptDigests", "disposition"]), entryPath, errors);
    for (const key of ["fingerprint", "disposition"]) if (!(key in judgment)) push(errors, `${entryPath}.${key}`, "is required");
    if (judgment.fingerprint !== null && (typeof judgment.fingerprint !== "string" || !SHA256_RE.test(judgment.fingerprint))) {
      push(errors, `${entryPath}.fingerprint`, "must be a sha256: digest or null");
    }
    for (const key of ["baseEvidenceDigest", "evidenceDigest", "rubricDigest"]) {
      if (judgment[key] !== undefined && (typeof judgment[key] !== "string" || !SHA256_RE.test(judgment[key]))) {
        push(errors, `${entryPath}.${key}`, "must be a sha256: digest");
      }
    }
    if (judgment.promptDigests !== undefined) validateDigestMap(judgment.promptDigests, `${entryPath}.promptDigests`, errors);
    if (!["clean", "accepted", "rejected", "not-judged"].includes(judgment.disposition)) {
      push(errors, `${entryPath}.disposition`, "is invalid");
    }
  }
}

function validateJudgmentState(state) {
  const errors = [];
  if (!requiredObject(state, "judgmentState", errors)) return validationResult(errors);
  noUnexpected(state, new Set(["version", "project", "sequence", "targets"]), "judgmentState", errors);
  for (const key of ["version", "project", "sequence", "targets"]) if (!(key in state)) push(errors, `judgmentState.${key}`, "is required");
  if (state.version !== "judgment-state.v1") push(errors, "judgmentState.version", "must be judgment-state.v1");
  nonEmptyString(state.project, "judgmentState.project", errors);
  if (!isSafePathSegment(state.project)) push(errors, "judgmentState.project", "must be a safe path segment");
  if (!Number.isInteger(state.sequence) || state.sequence < 0) push(errors, "judgmentState.sequence", "must be a non-negative integer");
  if (!requiredObject(state.targets, "judgmentState.targets", errors)) return validationResult(errors);
  for (const [targetId, target] of Object.entries(state.targets)) {
    const path = `judgmentState.targets.${targetId}`;
    if (!isSafeTargetId(targetId)) push(errors, path, "must use a safe target id");
    if (!requiredObject(target, path, errors)) continue;
    noUnexpected(target, new Set(["fingerprint", "baseEvidenceDigest", "evidenceDigest", "rubricDigest", "promptDigests", "runId", "judgedAt", "disposition"]), path, errors);
    for (const key of ["fingerprint", "runId", "judgedAt", "disposition"]) if (!(key in target)) push(errors, `${path}.${key}`, "is required");
    if (target.fingerprint !== null && (typeof target.fingerprint !== "string" || !SHA256_RE.test(target.fingerprint))) {
      push(errors, `${path}.fingerprint`, "must be a sha256: digest or null");
    }
    for (const key of ["baseEvidenceDigest", "evidenceDigest", "rubricDigest"]) {
      if (target[key] !== undefined && (typeof target[key] !== "string" || !SHA256_RE.test(target[key]))) {
        push(errors, `${path}.${key}`, "must be a sha256: digest");
      }
    }
    if (target.promptDigests !== undefined) validateDigestMap(target.promptDigests, `${path}.promptDigests`, errors);
    uuid(target.runId, `${path}.runId`, errors);
    if (!Number.isInteger(target.judgedAt) || target.judgedAt < 1) push(errors, `${path}.judgedAt`, "must be a positive integer");
    else if (Number.isInteger(state.sequence) && target.judgedAt > state.sequence) push(errors, `${path}.judgedAt`, "must not exceed state sequence");
    if (!["clean", "accepted", "rejected", "not-judged"].includes(target.disposition)) {
      push(errors, `${path}.disposition`, "is invalid");
    }
  }
  return validationResult(errors);
}

function validateJudgePack(pack) {
  const errors = [];
  if (!requiredObject(pack, "judgePack", errors)) return validationResult(errors);
  const allowed = new Set([
    "version", "packId", "runId", "project", "createdAt", "targets", "targetFingerprints", "targetJudgmentEvidence", "judgedFingerprints",
    "targetShotHashes", "attachmentHashes", "skippedTargets", "reselectedTargets", "batches", "contexts", "cropRequests", "exemplars", "artifacts",
  ]);
  const required = [...allowed].filter((key) => !["targetJudgmentEvidence", "reselectedTargets"].includes(key));
  noUnexpected(pack, allowed, "judgePack", errors);
  for (const key of required) if (!(key in pack)) push(errors, `judgePack.${key}`, "is required");
  if (pack.version !== "judgepack.v1") push(errors, "judgePack.version", "must be judgepack.v1");
  uuid(pack.packId, "judgePack.packId", errors);
  uuid(pack.runId, "judgePack.runId", errors);
  nonEmptyString(pack.project, "judgePack.project", errors);
  if (!isSafePathSegment(pack.project)) push(errors, "judgePack.project", "must be a safe path segment");
  isoDate(pack.createdAt, "judgePack.createdAt", errors);
  if (!Array.isArray(pack.targets) || pack.targets.some((targetId) => !isSafeTargetId(targetId)) || new Set(pack.targets || []).size !== pack.targets?.length) {
    push(errors, "judgePack.targets", "must be a unique array of safe target ids");
  }
  validateFingerprintMap(pack.targetFingerprints, "judgePack.targetFingerprints", errors);
  validateTargetJudgmentEvidenceMap(pack.targetJudgmentEvidence, "judgePack.targetJudgmentEvidence", errors);
  validateJudgedFingerprintMap(pack.judgedFingerprints, "judgePack.judgedFingerprints", errors);
  validateTargetShotHashMap(pack.targetShotHashes, "judgePack.targetShotHashes", errors);
  validateAttachmentHashMap(pack.attachmentHashes, "judgePack.attachmentHashes", errors);
  const targets = new Set(pack.targets || []);
  if (isObject(pack.targetFingerprints)) {
    for (const targetId of Object.keys(pack.targetFingerprints)) {
      if (!targets.has(targetId)) push(errors, `judgePack.targetFingerprints.${targetId}`, "must reference a pack target");
    }
    for (const targetId of targets) {
      if (!(targetId in pack.targetFingerprints)) push(errors, "judgePack.targetFingerprints", `must include selected target ${targetId}`);
    }
  }
  if (isObject(pack.targetShotHashes)) {
    for (const targetId of Object.keys(pack.targetShotHashes)) {
      if (!targets.has(targetId)) push(errors, `judgePack.targetShotHashes.${targetId}`, "must reference a pack target");
    }
    for (const targetId of targets) {
      if (!(targetId in pack.targetShotHashes)) push(errors, "judgePack.targetShotHashes", `must include selected target ${targetId}`);
    }
  }
  if (pack.targetJudgmentEvidence !== undefined && isObject(pack.targetJudgmentEvidence)) {
    for (const targetId of Object.keys(pack.targetJudgmentEvidence)) {
      if (!targets.has(targetId)) push(errors, `judgePack.targetJudgmentEvidence.${targetId}`, "must reference a pack target");
    }
    for (const targetId of targets) {
      if (!(targetId in pack.targetJudgmentEvidence)) {
        push(errors, "judgePack.targetJudgmentEvidence", `must include selected target ${targetId}`);
      }
    }
  }
  if (!Array.isArray(pack.skippedTargets)) {
    push(errors, "judgePack.skippedTargets", "must be an array");
  } else {
    const skipped = new Set();
    pack.skippedTargets.forEach((target, index) => {
      const path = `judgePack.skippedTargets[${index}]`;
      if (!requiredObject(target, path, errors)) return;
      noUnexpected(target, new Set(["targetId", "reason"]), path, errors);
      for (const key of ["targetId", "reason"]) if (!(key in target)) push(errors, `${path}.${key}`, "is required");
      if (!isSafeTargetId(target.targetId)) push(errors, `${path}.targetId`, "must be a safe target id");
      if (targets.has(target.targetId)) push(errors, `${path}.targetId`, "must not also be selected for this pack");
      if (skipped.has(target.targetId)) push(errors, `${path}.targetId`, "must be unique");
      skipped.add(target.targetId);
      nonEmptyString(target.reason, `${path}.reason`, errors);
    });
  }
  if (pack.reselectedTargets !== undefined) {
    if (!Array.isArray(pack.reselectedTargets)) {
      push(errors, "judgePack.reselectedTargets", "must be an array");
    } else {
      const reselected = new Set();
      pack.reselectedTargets.forEach((target, index) => {
        const path = `judgePack.reselectedTargets[${index}]`;
        if (!requiredObject(target, path, errors)) return;
        noUnexpected(target, new Set(["targetId", "reason"]), path, errors);
        for (const key of ["targetId", "reason"]) if (!(key in target)) push(errors, `${path}.${key}`, "is required");
        if (!isSafeTargetId(target.targetId) || !targets.has(target.targetId)) {
          push(errors, `${path}.targetId`, "must be a selected pack target");
        }
        if (reselected.has(target.targetId)) push(errors, `${path}.targetId`, "must be unique");
        reselected.add(target.targetId);
        if (!["evidence-changed", "rubric-changed"].includes(target.reason)) {
          push(errors, `${path}.reason`, "must be evidence-changed or rubric-changed");
        }
      });
    }
  }
  if (!Array.isArray(pack.batches)) {
    push(errors, "judgePack.batches", "must be an array");
  } else {
    const ids = new Set();
    const coveredTargets = new Set();
    pack.batches.forEach((batch, index) => {
      const path = `judgePack.batches[${index}]`;
      if (!requiredObject(batch, path, errors)) return;
      noUnexpected(batch, new Set(["id", "groupId", "anchorId", "targetIds", "checklistPhases", "imageList", "imageListDigest", "prompt", "promptDigest"]), path, errors);
      for (const key of ["id", "groupId", "anchorId", "targetIds", "checklistPhases", "imageList", "imageListDigest", "prompt", "promptDigest"]) if (!(key in batch)) push(errors, `${path}.${key}`, "is required");
      nonEmptyString(batch.id, `${path}.id`, errors);
      if (ids.has(batch.id)) push(errors, `${path}.id`, "must be unique");
      ids.add(batch.id);
      if (batch.groupId !== null && (typeof batch.groupId !== "string" || !batch.groupId.trim())) push(errors, `${path}.groupId`, "must be a non-empty string or null");
      if (batch.anchorId !== null && !isSafeTargetId(batch.anchorId)) push(errors, `${path}.anchorId`, "must be a safe target id or null");
      if ((batch.groupId === null) !== (batch.anchorId === null)) push(errors, path, "must use both groupId and anchorId for comparison batches, or neither for standalone batches");
      if (!Array.isArray(batch.targetIds) || batch.targetIds.length === 0 || batch.targetIds.some((targetId) => !targets.has(targetId)) || new Set(batch.targetIds || []).size !== batch.targetIds?.length) {
        push(errors, `${path}.targetIds`, "must be a unique non-empty subset of pack targets");
      } else {
        batch.targetIds.forEach((targetId) => coveredTargets.add(targetId));
      }
      if (!Array.isArray(batch.checklistPhases) || batch.checklistPhases.length !== CHECKLIST_PHASES.length || batch.checklistPhases.some((phase, phaseIndex) => phase !== CHECKLIST_PHASES[phaseIndex])) {
        push(errors, `${path}.checklistPhases`, "must list the canonical checklist phases in order");
      }
      for (const key of ["imageList", "prompt"]) nonEmptyString(batch[key], `${path}.${key}`, errors);
      if (typeof batch.imageListDigest !== "string" || !SHA256_RE.test(batch.imageListDigest)) {
        push(errors, `${path}.imageListDigest`, "must be a sha256: digest");
      }
      if (typeof batch.promptDigest !== "string" || !SHA256_RE.test(batch.promptDigest)) {
        push(errors, `${path}.promptDigest`, "must be a sha256: digest");
      }
    });
    if (targets.size > 0 && (pack.batches.length === 0 || coveredTargets.size !== targets.size || [...targets].some((targetId) => !coveredTargets.has(targetId)))) {
      push(errors, "judgePack.batches", "must cover every pack target when pack targets are non-empty");
    }
  }
  if (!Array.isArray(pack.contexts) || pack.contexts.some((context) => !isObject(context) || !targets.has(context.targetId) || typeof context.path !== "string" || !context.path)) {
    push(errors, "judgePack.contexts", "must list a context path for each pack target");
  } else if (new Set(pack.contexts.map((context) => context.targetId)).size !== pack.contexts.length || pack.contexts.length !== targets.size) {
    push(errors, "judgePack.contexts", "must list each pack target exactly once");
  }
  nonEmptyString(pack.cropRequests, "judgePack.cropRequests", errors);
  if (!Array.isArray(pack.exemplars)) {
    push(errors, "judgePack.exemplars", "must be an array");
  } else {
    const ids = new Set();
    pack.exemplars.forEach((exemplar, index) => {
      const path = `judgePack.exemplars[${index}]`;
      if (!requiredObject(exemplar, path, errors)) return;
      noUnexpected(exemplar, new Set(["id", "path", "screenshot", "rubricVersion", "curator", "expectedFindings", "severity"]), path, errors);
      nonEmptyString(exemplar.id, `${path}.id`, errors);
      if (ids.has(exemplar.id)) push(errors, `${path}.id`, "must be unique");
      ids.add(exemplar.id);
      nonEmptyString(exemplar.path, `${path}.path`, errors);
      const result = validateExemplar({
        screenshot: exemplar.screenshot,
        rubricVersion: exemplar.rubricVersion,
        curator: exemplar.curator,
        expectedFindings: exemplar.expectedFindings,
        severity: exemplar.severity,
      });
      errors.push(...result.errors.map((error) => error.replace(/^exemplar/, path)));
      if (exemplar.screenshot?.status === "available") {
        const attachment = exemplar.screenshot.attachment;
        if (typeof attachment !== "string" || !attachment) {
          push(errors, `${path}.screenshot.attachment`, "is required for an available packed exemplar");
        } else if (pack.attachmentHashes?.[attachment] !== exemplar.screenshot.sha256) {
          push(errors, `${path}.screenshot.attachment`, "must be bound in attachmentHashes to the exemplar digest");
        }
      }
    });
  }
  if (!Array.isArray(pack.artifacts) || pack.artifacts.length === 0 || pack.artifacts.some((path) => typeof path !== "string" || !path) || new Set(pack.artifacts || []).size !== pack.artifacts?.length) {
    push(errors, "judgePack.artifacts", "must be a unique non-empty array of paths");
  }
  return validationResult(errors);
}

function validateHeader(header, path, errors) {
  if (!requiredObject(header, path, errors)) return;
  const allowed = new Set(["kind", "version", "runId", "project", "configHash", "commitHash", "patchHash", "targets", "targetShotHashes", "intentSource", "rubricVersion", "model", "createdAt"]);
  const required = new Set(["kind", "version", "runId", "project", "configHash", "commitHash", "patchHash", "targets", "intentSource", "rubricVersion", "model", "createdAt"]);
  noUnexpected(header, allowed, path, errors);
  for (const key of required) {
    if (!(key in header)) push(errors, `${path}.${key}`, "is required");
  }
  if (header.kind !== "record-header") push(errors, `${path}.kind`, "must be record-header");
  if (header.version !== 1) push(errors, `${path}.version`, "must be 1");
  uuid(header.runId, `${path}.runId`, errors);
  for (const key of ["project", "intentSource", "rubricVersion"]) nonEmptyString(header[key], `${path}.${key}`, errors);
  if (!isSafePathSegment(header.project)) {
    push(errors, `${path}.project`, "must be a safe path segment (letters, numbers, underscores, and hyphens only)");
  }
  if (typeof header.configHash !== "string" || !SHA256_RE.test(header.configHash)) push(errors, `${path}.configHash`, "must be a sha256: digest");
  for (const key of ["commitHash", "patchHash"]) {
    const value = header[key];
    if (value !== null && typeof value !== "string") push(errors, `${path}.${key}`, "must be a string or null");
  }
  if (typeof header.commitHash === "string" && !COMMIT_RE.test(header.commitHash)) push(errors, `${path}.commitHash`, "must be a git hash");
  if (typeof header.patchHash === "string" && !SHA256_RE.test(header.patchHash)) push(errors, `${path}.patchHash`, "must be a sha256: digest");
  if (!Array.isArray(header.targets) || header.targets.length === 0 || header.targets.some((id) => typeof id !== "string" || !id.trim())) {
    push(errors, `${path}.targets`, "must be a non-empty array of target ids");
  } else if (new Set(header.targets).size !== header.targets.length) {
    push(errors, `${path}.targets`, "must not contain duplicates");
  }
  if (header.targetShotHashes !== undefined) {
    if (!isObject(header.targetShotHashes)) {
      push(errors, `${path}.targetShotHashes`, "must be an object keyed by target id");
    } else {
      for (const [targetId, assets] of Object.entries(header.targetShotHashes)) {
        if (!isSafeTargetId(targetId)) {
          push(errors, `${path}.targetShotHashes.${targetId}`, "must use a safe target id");
        }
        if (!isObject(assets) || Object.keys(assets).length === 0) {
          push(errors, `${path}.targetShotHashes.${targetId}`, "must be a non-empty object of shot hashes");
          continue;
        }
        for (const [asset, hash] of Object.entries(assets)) {
          nonEmptyString(asset, `${path}.targetShotHashes.${targetId}.${asset}`, errors);
          if (typeof hash !== "string" || !SHA256_RE.test(hash)) {
            push(errors, `${path}.targetShotHashes.${targetId}.${asset}`, "must be a sha256: digest");
          }
        }
      }
    }
  }
  if (!requiredObject(header.model, `${path}.model`, errors)) return;
  noUnexpected(header.model, new Set(["provider", "name", "version"]), `${path}.model`, errors);
  nonEmptyString(header.model.provider, `${path}.model.provider`, errors);
  nonEmptyString(header.model.name, `${path}.model.name`, errors);
  if (header.model.version !== undefined) nonEmptyString(header.model.version, `${path}.model.version`, errors);
  isoDate(header.createdAt, `${path}.createdAt`, errors);
}

function validateReviewEvent(event) {
  const errors = [];
  if (!requiredObject(event, "event", errors)) return validationResult(errors);
  if (event.kind === "record-header") {
    validateHeader(event, "event", errors);
  } else if (event.kind === "initial") {
    noUnexpected(event, new Set(["kind", "version", "eventId", "at", "finding"]), "event", errors);
    for (const key of ["kind", "version", "eventId", "at", "finding"]) if (!(key in event)) push(errors, `event.${key}`, "is required");
    if (event.version !== 1) push(errors, "event.version", "must be 1");
    uuid(event.eventId, "event.eventId", errors);
    isoDate(event.at, "event.at", errors);
    validateCandidate(event.finding, "event.finding", errors);
  } else if (event.kind === "verification") {
    noUnexpected(event, new Set(["kind", "version", "eventId", "at", "findingId", "verifierVerdict", "evidence"]), "event", errors);
    for (const key of ["kind", "version", "eventId", "at", "findingId", "verifierVerdict", "evidence"]) if (!(key in event)) push(errors, `event.${key}`, "is required");
    if (event.version !== 1) push(errors, "event.version", "must be 1");
    uuid(event.eventId, "event.eventId", errors);
    isoDate(event.at, "event.at", errors);
    uuid(event.findingId, "event.findingId", errors);
    if (!VERIFIER_VERDICTS.has(event.verifierVerdict)) push(errors, "event.verifierVerdict", "is invalid");
    nonEmptyString(event.evidence, "event.evidence", errors);
  } else if (event.kind === "disposition") {
    noUnexpected(event, new Set(["kind", "version", "eventId", "at", "finding"]), "event", errors);
    for (const key of ["kind", "version", "eventId", "at", "finding"]) if (!(key in event)) push(errors, `event.${key}`, "is required");
    if (event.version !== 1) push(errors, "event.version", "must be 1");
    uuid(event.eventId, "event.eventId", errors);
    isoDate(event.at, "event.at", errors);
    errors.push(...validateFinding(event.finding).errors.map((error) => error.replace(/^finding/, "event.finding")));
  } else if (event.kind === "seal") {
    noUnexpected(event, new Set(["kind", "version", "eventId", "at", "findingCount", "findingIds"]), "event", errors);
    for (const key of ["kind", "version", "eventId", "at", "findingCount"]) if (!(key in event)) push(errors, `event.${key}`, "is required");
    if (event.version !== 1) push(errors, "event.version", "must be 1");
    uuid(event.eventId, "event.eventId", errors);
    isoDate(event.at, "event.at", errors);
    if (!Number.isInteger(event.findingCount) || event.findingCount < 0) {
      push(errors, "event.findingCount", "must be a non-negative integer");
    }
    if (event.findingIds !== undefined) {
      if (!Array.isArray(event.findingIds)) {
        push(errors, "event.findingIds", "must be an array of finding ids");
      } else {
        for (const [index, id] of event.findingIds.entries()) uuid(id, `event.findingIds[${index}]`, errors);
        if (new Set(event.findingIds).size !== event.findingIds.length) {
          push(errors, "event.findingIds", "must not contain duplicates");
        }
        if (Number.isInteger(event.findingCount) && event.findingIds.length !== event.findingCount) {
          push(errors, "event.findingIds", "must contain exactly findingCount ids");
        }
      }
    }
  } else {
    push(errors, "event.kind", "must be record-header, initial, verification, disposition, or seal");
  }
  return validationResult(errors);
}

function stableCandidateFields(finding) {
  return {
    id: finding.id,
    ruleId: finding.ruleId,
    targetId: finding.targetId,
    assetId: finding.assetId,
    region: finding.region,
    cropId: finding.cropId,
    cropDigest: finding.cropDigest,
    evidence: finding.evidence,
    priority: finding.priority,
    confidence: finding.confidence,
    initialVerdict: finding.initialVerdict,
    scope: finding.scope,
  };
}

function recordCompleteness(events) {
  const initial = new Map();
  const verified = new Set();
  const disposed = new Set();
  const seals = [];
  for (const event of events) {
    if (event.kind === "initial") initial.set(event.finding.id, true);
    if (event.kind === "verification") verified.add(event.findingId);
    if (event.kind === "disposition") disposed.add(event.finding?.id);
    if (event.kind === "seal") seals.push(event);
  }
  const pending = [...initial.keys()].filter((id) => !verified.has(id) || !disposed.has(id));
  const seal = seals.length === 1 ? seals[0] : null;
  const observedFindingIds = [...initial.keys()];
  const countMatches = !!seal && seal.findingCount === observedFindingIds.length;
  const declaredIdsMatch = !!seal && (
    seal.findingIds === undefined ||
    (seal.findingIds.length === observedFindingIds.length &&
      seal.findingIds.every((id) => initial.has(id)))
  );
  const sealed = events[events.length - 1]?.kind === "seal" && countMatches && declaredIdsMatch;
  const hasHeader = events[0]?.kind === "record-header";
  const status = !hasHeader
    ? "invalid"
    : !seal
      ? "unsealed"
      : !sealed
        ? "invalid"
        : pending.length > 0
          ? "incomplete"
          : "complete";
  return {
    hasHeader,
    initials: initial.size,
    verifications: verified.size,
    dispositions: disposed.size,
    pendingFindingIds: pending,
    seal: seal
      ? { findingCount: seal.findingCount, findingIds: seal.findingIds ?? null }
      : null,
    sealed,
    status,
    complete: status === "complete",
  };
}

/** Validate a self-contained append batch; sequence checks require the stored log. */
function validateReviewEventBatch(events) {
  const errors = [];
  if (!Array.isArray(events) || events.length === 0) return validationResult(["events: must be a non-empty array"]);
  if (events[0]?.kind !== "record-header") push(errors, "events[0]", "must be the record-header");
  const eventIds = new Set();
  events.forEach((event, index) => {
    const path = `events[${index}]`;
    const one = validateReviewEvent(event);
    errors.push(...one.errors.map((error) => error.replace(/^event/, path)));
    if (index > 0 && event?.kind === "record-header") push(errors, path, "record-header may appear only once, first");
    if (event?.kind === "seal" && index !== events.length - 1) push(errors, path, "seal must be the final event");
    if (event?.eventId) {
      if (eventIds.has(event.eventId)) push(errors, `${path}.eventId`, "must be unique");
      eventIds.add(event.eventId);
    }
  });
  return validationResult(errors);
}

function validateReviewEvents(events, { targetIds, capturedTargetIds, capturedTargetOutcomes, capturedTargetShotHashes } = {}) {
  const batch = validateReviewEventBatch(events);
  const errors = [...batch.errors];
  if (!Array.isArray(events) || events.length === 0) return validationResult(errors);
  const header = events[0];
  const headerTargets = new Set(header?.targets || []);
  const configuredTargets = targetIds === undefined ? null : new Set(targetIds);
  const capturedTargets = capturedTargetIds === undefined ? null : new Set(capturedTargetIds);
  if (configuredTargets) {
    for (const id of header?.targets || []) {
      if (!configuredTargets.has(id)) {
        push(errors, "events[0].targets", `references target ${id} not present in the selected project config`);
      }
    }
  }
  if (capturedTargets) {
    for (const id of header?.targets || []) {
      if (!capturedTargets.has(id)) {
        push(errors, "events[0].targets", `references target ${id} not present in the capture run`);
      }
    }
  }
  if (capturedTargetOutcomes !== undefined) {
    for (const id of header?.targets || []) {
      if (capturedTargetOutcomes?.[id] !== "captured") {
        const outcome = capturedTargetOutcomes?.[id] ?? "missing";
        push(errors, "events[0].targets", `references target ${id} that was not successfully captured (outcome: ${outcome})`);
      }
    }
  }
  if (capturedTargetShotHashes !== undefined) {
    for (const id of header?.targets || []) {
      if (!isObject(capturedTargetShotHashes?.[id]) || Object.keys(capturedTargetShotHashes[id]).length === 0) {
        push(errors, "events[0].targets", `references target ${id} with no hashed PNGs in the capture run`);
      }
    }
  }
  if (header?.targetShotHashes !== undefined) {
    for (const [targetId, assets] of Object.entries(header.targetShotHashes || {})) {
      if (!headerTargets.has(targetId)) {
        push(errors, `events[0].targetShotHashes.${targetId}`, "must reference a target listed in the record header");
      }
      if (capturedTargets && !capturedTargets.has(targetId)) {
        push(errors, `events[0].targetShotHashes.${targetId}`, "references target not present in the capture run");
      }
      if (capturedTargetShotHashes !== undefined) {
        const capturedAssets = capturedTargetShotHashes?.[targetId];
        for (const [asset, hash] of Object.entries(assets || {})) {
          if (!capturedAssets || capturedAssets[asset] !== hash) {
            push(errors, `events[0].targetShotHashes.${targetId}.${asset}`, "must match the captured shot hash");
          }
        }
      }
    }
  }
  const candidates = new Map();
  const verified = new Map();
  const disposed = new Set();
  const seals = [];
  events.forEach((event, index) => {
    const path = `events[${index}]`;
    if (event?.kind === "initial") {
      const id = event.finding?.id;
      if (candidates.has(id)) push(errors, `${path}.finding.id`, "already has an initial event");
      if (!headerTargets.has(event.finding?.targetId)) {
        push(errors, `${path}.finding.targetId`, "must be listed in the record header targets");
      }
      candidates.set(id, event.finding);
    }
    if (event?.kind === "verification") {
      const candidate = candidates.get(event.findingId);
      if (!candidate) push(errors, `${path}.findingId`, "must follow its initial event");
      else if (verified.has(event.findingId)) push(errors, `${path}.findingId`, "already has a verification event");
      else if (candidate.initialVerdict === "not-judged" && event.verifierVerdict !== "not-judged") {
        push(errors, `${path}.verifierVerdict`, "must remain not-judged after an initial not-judged verdict");
      }
      verified.set(event.findingId, event);
    }
    if (event?.kind === "disposition") {
      const id = event.finding?.id;
      const candidate = candidates.get(id);
      const verification = verified.get(id);
      if (!candidate) push(errors, `${path}.finding.id`, "must follow its initial event");
      else if (!verification) push(errors, `${path}.finding.id`, "must follow its verification event");
      else {
        if (!isDeepStrictEqual(stableCandidateFields(candidate), stableCandidateFields(event.finding))) {
          push(errors, `${path}.finding`, "must preserve the initial finding fields");
        }
        if (verification.verifierVerdict !== event.finding.verifierVerdict) {
          push(errors, `${path}.finding.verifierVerdict`, "must match the verification event");
        }
      }
      if (disposed.has(id)) push(errors, `${path}.finding.id`, "already has a disposition event");
      disposed.add(id);
    }
    if (event?.kind === "seal") seals.push({ event, path });
  });
  if (seals.length === 1) {
    const { event, path } = seals[0];
    const observedIds = [...candidates.keys()];
    if (event.findingCount !== observedIds.length) {
      push(errors, `${path}.findingCount`, `must match the ${observedIds.length} observed initial finding(s)`);
    }
    if (event.findingIds !== undefined) {
      const declaredIds = new Set(event.findingIds);
      const matches = declaredIds.size === observedIds.length && observedIds.every((id) => declaredIds.has(id));
      if (!matches) push(errors, `${path}.findingIds`, "must exactly match the observed initial finding ids");
    }
  }
  return validationResult(errors);
}

function legacyCropDigestEventIds(events) {
  return (events || [])
    .filter((event) => ["initial", "disposition"].includes(event?.kind) && event.finding?.cropId !== undefined && event.finding?.cropDigest === undefined)
    .map((event) => event.eventId)
    .filter((eventId) => typeof eventId === "string");
}

/**
 * review-event.v1 predates canonical POSIX shot-hash keys, so its published
 * read contract remains permissive for stored Windows headers. New appends
 * are a narrower writer policy and may not introduce backslash keys.
 */
function validateAppendPosixShotHashPolicy(inputEvents) {
  const errors = [];
  const header = inputEvents?.[0];
  for (const [targetId, assets] of Object.entries(header?.targetShotHashes || {})) {
    if (!isObject(assets)) continue;
    for (const asset of Object.keys(assets)) {
      if (asset.includes("\\")) {
        errors.push(`append policy: events[0].targetShotHashes.${targetId}.${asset} must use forward-slash POSIX path separators`);
      }
    }
  }
  return validationResult(errors);
}

/**
 * cropDigest was optional in the published finding.v2/review-event.v1
 * schemas. Keep stored logs schema-valid, but refuse to introduce a
 * digest-less crop in a new append. The one allowed exception is a
 * disposition completing an already-stored legacy initial finding with the
 * same digest-less crop binding; requiring a digest there would strand it.
 */
function validateAppendCropDigestPolicy(inputEvents, existingEvents = []) {
  const errors = [];
  const legacyInitials = new Map(
    (existingEvents || [])
      .filter((event) => event?.kind === "initial" && event.finding?.cropId !== undefined && event.finding?.cropDigest === undefined)
      .map((event) => [event.finding.id, event.finding]),
  );
  for (const [index, event] of (inputEvents || []).entries()) {
    if (!event || !["initial", "disposition"].includes(event.kind)) continue;
    const finding = event.finding;
    if (finding?.cropId === undefined || finding.cropDigest !== undefined) continue;
    const completesLegacyInitial = event.kind === "disposition" && legacyInitials.has(finding.id);
    if (!completesLegacyInitial) {
      const identifier = typeof event.eventId === "string" ? event.eventId : `events[${index}]`;
      errors.push(`append policy: crop-backed ${event.kind} event ${identifier} must include cropDigest`);
    }
  }
  return validationResult(errors);
}

function validateReceipt(receipt) {
  const errors = [];
  if (!requiredObject(receipt, "receipt", errors)) return validationResult(errors);
  const allowed = new Set(["id", "project", "stateProfile", "account", "appBuild", "device", "sessionId", "preparedAt", "expiresAt", "outcome", "producer"]);
  noUnexpected(receipt, allowed, "receipt", errors);
  for (const key of allowed) if (!(key in receipt)) push(errors, `receipt.${key}`, "is required");
  uuid(receipt.id, "receipt.id", errors);
  for (const key of ["project", "stateProfile", "account", "appBuild", "sessionId"]) nonEmptyString(receipt[key], `receipt.${key}`, errors);
  if (requiredObject(receipt.device, "receipt.device", errors)) {
    noUnexpected(receipt.device, new Set(["name", "udid", "runtime"]), "receipt.device", errors);
    nonEmptyString(receipt.device.name, "receipt.device.name", errors);
    for (const key of ["udid", "runtime"]) if (receipt.device[key] !== undefined) nonEmptyString(receipt.device[key], `receipt.device.${key}`, errors);
  }
  isoDate(receipt.preparedAt, "receipt.preparedAt", errors);
  isoDate(receipt.expiresAt, "receipt.expiresAt", errors);
  if (typeof receipt.preparedAt === "string" && typeof receipt.expiresAt === "string" && Date.parse(receipt.expiresAt) <= Date.parse(receipt.preparedAt)) {
    push(errors, "receipt.expiresAt", "must be after preparedAt");
  }
  if (!["prepared", "failed"].includes(receipt.outcome)) push(errors, "receipt.outcome", "must be prepared or failed");
  if (requiredObject(receipt.producer, "receipt.producer", errors)) {
    noUnexpected(receipt.producer, new Set(["name", "version"]), "receipt.producer", errors);
    nonEmptyString(receipt.producer.name, "receipt.producer.name", errors);
    nonEmptyString(receipt.producer.version, "receipt.producer.version", errors);
  }
  return validationResult(errors);
}

function validateReceiptForTarget(receipt, { project, stateProfile, now = Date.now() }) {
  const base = validateReceipt(receipt);
  const errors = [...base.errors];
  if (receipt?.outcome !== "prepared") push(errors, "receipt.outcome", "must be prepared to be consumed");
  if (receipt?.project !== project) push(errors, "receipt.project", `must match project ${project}`);
  if (receipt?.stateProfile !== stateProfile) push(errors, "receipt.stateProfile", `must match stateProfile ${stateProfile}`);
  if (typeof receipt?.expiresAt === "string" && Date.parse(receipt.expiresAt) <= now) push(errors, "receipt.expiresAt", "is expired");
  return validationResult(errors);
}

function validateNormalizedRect(rect, path, errors) {
  if (!requiredObject(rect, path, errors)) return;
  noUnexpected(rect, new Set(["x", "y", "w", "h", "normalized"]), path, errors);
  for (const key of ["x", "y", "w", "h", "normalized"]) {
    if (!(key in rect)) push(errors, `${path}.${key}`, "is required");
  }
  for (const key of ["x", "y", "w", "h"]) {
    if (typeof rect[key] !== "number" || !Number.isFinite(rect[key])) {
      push(errors, `${path}.${key}`, "must be a finite number");
    }
  }
  if (rect.normalized !== true) push(errors, `${path}.normalized`, "must be true");
  if (typeof rect.x === "number" && (rect.x < 0 || rect.x > 1)) push(errors, `${path}.x`, "must be within 0..1");
  if (typeof rect.y === "number" && (rect.y < 0 || rect.y > 1)) push(errors, `${path}.y`, "must be within 0..1");
  if (typeof rect.w === "number" && (rect.w <= 0 || rect.w > 1)) push(errors, `${path}.w`, "must be within (0, 1]");
  if (typeof rect.h === "number" && (rect.h <= 0 || rect.h > 1)) push(errors, `${path}.h`, "must be within (0, 1]");
  if (typeof rect.x === "number" && typeof rect.w === "number" && rect.x + rect.w > 1) {
    push(errors, path, "must stay within the asset horizontally (x + w <= 1)");
  }
  if (typeof rect.y === "number" && typeof rect.h === "number" && rect.y + rect.h > 1) {
    push(errors, path, "must stay within the asset vertically (y + h <= 1)");
  }
}

function validateCropRequests(cropRequests, path = "cropRequests") {
  const errors = [];
  if (!Array.isArray(cropRequests)) {
    push(errors, path, "must be an array of crop requests");
    return validationResult(errors);
  }
  const identities = new Set();
  cropRequests.forEach((request, index) => {
    const requestPath = `${path}[${index}]`;
    if (!requiredObject(request, requestPath, errors)) return;
    noUnexpected(request, new Set(["assetId", "rect", "axSelector", "purpose"]), requestPath, errors);
    for (const key of ["assetId", "purpose"]) if (!(key in request)) push(errors, `${requestPath}.${key}`, "is required");
    nonEmptyString(request.assetId, `${requestPath}.assetId`, errors);
    nonEmptyString(request.purpose, `${requestPath}.purpose`, errors);
    const hasRect = request.rect !== undefined;
    const hasSelector = request.axSelector !== undefined;
    if (hasRect === hasSelector) push(errors, requestPath, "must have exactly one of rect or axSelector");
    if (hasRect) validateNormalizedRect(request.rect, `${requestPath}.rect`, errors);
    if (hasSelector) nonEmptyString(request.axSelector, `${requestPath}.axSelector`, errors);
    const identity = `${request.assetId}\u0000${request.purpose}`;
    if (identities.has(identity)) push(errors, requestPath, "must not duplicate assetId/purpose (the crop identity)");
    identities.add(identity);
  });
  return validationResult(errors);
}

function validateScrollProbe(scrollProbe, path, errors) {
  if (!requiredObject(scrollProbe, path, errors)) return;
  noUnexpected(
    scrollProbe,
    new Set(["containerSelector", "footerSelector", "maxSwipes", "swipePercent", "settleMs", "thresholds"]),
    path,
    errors,
  );
  for (const key of ["containerSelector", "footerSelector"]) {
    if (scrollProbe[key] !== undefined) nonEmptyString(scrollProbe[key], `${path}.${key}`, errors);
  }
  if (scrollProbe.maxSwipes !== undefined && (!Number.isInteger(scrollProbe.maxSwipes) || scrollProbe.maxSwipes < 1)) {
    push(errors, `${path}.maxSwipes`, "must be a positive integer");
  }
  if (scrollProbe.swipePercent !== undefined && (typeof scrollProbe.swipePercent !== "number" || !Number.isFinite(scrollProbe.swipePercent) || scrollProbe.swipePercent <= 0 || scrollProbe.swipePercent >= 1)) {
    push(errors, `${path}.swipePercent`, "must be a finite number within (0, 1)");
  }
  if (scrollProbe.settleMs !== undefined && (!Number.isInteger(scrollProbe.settleMs) || scrollProbe.settleMs < 0)) {
    push(errors, `${path}.settleMs`, "must be a non-negative integer");
  }
  if (scrollProbe.thresholds !== undefined) {
    if (requiredObject(scrollProbe.thresholds, `${path}.thresholds`, errors)) {
      noUnexpected(scrollProbe.thresholds, new Set(["sliverExtentViewportRatio"]), `${path}.thresholds`, errors);
      const ratio = scrollProbe.thresholds.sliverExtentViewportRatio;
      if (ratio !== undefined && (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0)) {
        push(errors, `${path}.thresholds.sliverExtentViewportRatio`, "must be a non-negative finite number");
      }
    }
  }
}

function validateConfig(config) {
  const errors = [];
  if (!requiredObject(config, "config", errors)) return validationResult(errors);
  const version = config.configVersion ?? 1;
  if (version !== 1 && version !== 2) push(errors, "config.configVersion", "must be 1 or 2 (or be absent for v1)");
  for (const key of ["name", "root", "baseUrl"]) nonEmptyString(config[key], `config.${key}`, errors);
  if (!isSafePathSegment(config.name)) {
    push(errors, "config.name", "must be a safe path segment (letters, numbers, underscores, and hyphens only)");
  }
  if (!Array.isArray(config.routes)) {
    push(errors, "config.routes", "must be an array");
    return validationResult(errors);
  }
  const targetIds = new Set();
  for (const [index, target] of config.routes.entries()) {
    const path = `config.routes[${index}]`;
    if (!requiredObject(target, path, errors)) continue;
    nonEmptyString(target.id, `${path}.id`, errors);
    if (!isSafeTargetId(target.id)) {
      push(errors, `${path}.id`, "must be a safe path segment (letters, numbers, underscores, and hyphens only)");
    }
    if (typeof target.route !== "string") push(errors, `${path}.route`, "must be a string");
    if (targetIds.has(target.id)) push(errors, `${path}.id`, "must be unique");
    targetIds.add(target.id);
    if (target.waitFor !== undefined) nonEmptyString(target.waitFor, `${path}.waitFor`, errors);
    for (const key of ["stateProfile", "flow", "_note"]) if (target[key] !== undefined) nonEmptyString(target[key], `${path}.${key}`, errors);
    if (target.params !== undefined) {
      if (!isObject(target.params)) {
        push(errors, `${path}.params`, "must be an object");
      } else {
        for (const [key, value] of Object.entries(target.params)) {
          if (!["string", "number", "boolean"].includes(typeof value) && value !== null) {
            push(errors, `${path}.params.${key}`, "must be a string, number, boolean, or null");
          }
        }
      }
    }
    for (const key of ["sourceFiles", "captureVariants"]) {
      if (target[key] === undefined) continue;
      if (!Array.isArray(target[key]) || target[key].length === 0 || target[key].some((value) => typeof value !== "string" || !value.trim())) {
        push(errors, `${path}.${key}`, "must be a non-empty array of strings");
      } else if (new Set(target[key]).size !== target[key].length) {
        push(errors, `${path}.${key}`, "must not contain duplicates");
      }
    }
    if (target.scrollProbe !== undefined) validateScrollProbe(target.scrollProbe, `${path}.scrollProbe`, errors);
  }
  if (config.groups !== undefined) {
    if (!isObject(config.groups)) {
      push(errors, "config.groups", "must be an object of named target arrays");
    } else {
      for (const [name, ids] of Object.entries(config.groups)) {
        if (targetIds.has(name)) {
          push(errors, `config.groups.${name}`, "must not share a name with a target id");
        }
        if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string" || !id.trim())) {
          push(errors, `config.groups.${name}`, "must be a non-empty array of target ids");
        } else {
          if (new Set(ids).size !== ids.length) push(errors, `config.groups.${name}`, "must not contain duplicates");
          for (const id of ids) if (!targetIds.has(id)) push(errors, `config.groups.${name}`, `references unknown target ${id}`);
        }
      }
    }
  }
  if (config.reviewGroups !== undefined) {
    if (!Array.isArray(config.reviewGroups)) push(errors, "config.reviewGroups", "must be an array");
    else {
      const reviewIds = new Set();
      config.reviewGroups.forEach((group, index) => {
        const path = `config.reviewGroups[${index}]`;
        if (!requiredObject(group, path, errors)) return;
        noUnexpected(group, new Set(["id", "targetIds", "anchorId", "purpose"]), path, errors);
        for (const key of ["id", "targetIds", "anchorId", "purpose"]) if (!(key in group)) push(errors, `${path}.${key}`, "is required");
        nonEmptyString(group.id, `${path}.id`, errors);
        if (reviewIds.has(group.id)) push(errors, `${path}.id`, "must be unique");
        reviewIds.add(group.id);
        nonEmptyString(group.anchorId, `${path}.anchorId`, errors);
        nonEmptyString(group.purpose, `${path}.purpose`, errors);
        if (!Array.isArray(group.targetIds) || group.targetIds.length < 2) push(errors, `${path}.targetIds`, "must list at least two targets");
        else {
          if (new Set(group.targetIds).size !== group.targetIds.length) push(errors, `${path}.targetIds`, "must not contain duplicates");
          for (const id of group.targetIds) if (!targetIds.has(id)) push(errors, `${path}.targetIds`, `references unknown target ${id}`);
          if (!group.targetIds.includes(group.anchorId)) push(errors, `${path}.anchorId`, "must be one of targetIds");
        }
      });
    }
  }
  if (config.library !== undefined) {
    if (requiredObject(config.library, "config.library", errors)) {
      noUnexpected(config.library, new Set(["keepRuns", "maxBytes"]), "config.library", errors);
      for (const key of ["keepRuns", "maxBytes"]) {
        if (config.library[key] !== undefined && (!Number.isInteger(config.library[key]) || config.library[key] <= 0)) {
          push(errors, `config.library.${key}`, "must be a positive integer");
        }
      }
    }
  }
  if (config.cropRequests !== undefined) errors.push(...validateCropRequests(config.cropRequests, "config.cropRequests").errors);
  if (config.judgeContext !== undefined) {
    if (requiredObject(config.judgeContext, "config.judgeContext", errors)) {
      noUnexpected(config.judgeContext, new Set(["maxBytes"]), "config.judgeContext", errors);
      if (config.judgeContext.maxBytes !== undefined && (!Number.isInteger(config.judgeContext.maxBytes) || config.judgeContext.maxBytes < 256)) {
        push(errors, "config.judgeContext.maxBytes", "must be an integer of at least 256");
      }
    }
  }
  if (config.judge !== undefined) {
    if (requiredObject(config.judge, "config.judge", errors)) {
      noUnexpected(config.judge, new Set(["provider", "model", "reasoningEffort", "apiKeyEnv", "maxRetries", "maxFindingsPerBatch", "maxImagesPerBatch", "maxFindingsPerRun", "timeoutMs"]), "config.judge", errors);
      if (config.judge.provider !== undefined && config.judge.provider !== "openai") {
        push(errors, "config.judge.provider", "must be openai");
      }
      if (config.judge.reasoningEffort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh"].includes(config.judge.reasoningEffort)) {
        push(errors, "config.judge.reasoningEffort", "must be one of none, minimal, low, medium, high, xhigh");
      }
      if (config.judge.model !== undefined) nonEmptyString(config.judge.model, "config.judge.model", errors);
      if (config.judge.apiKeyEnv !== undefined && (typeof config.judge.apiKeyEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(config.judge.apiKeyEnv))) {
        push(errors, "config.judge.apiKeyEnv", "must be an uppercase environment-variable name");
      }
      if (config.judge.maxRetries !== undefined && (!Number.isInteger(config.judge.maxRetries) || config.judge.maxRetries < 0 || config.judge.maxRetries > 5)) {
        push(errors, "config.judge.maxRetries", "must be an integer within 0..5");
      }
      if (config.judge.maxImagesPerBatch !== undefined && (
        !Number.isInteger(config.judge.maxImagesPerBatch) ||
        config.judge.maxImagesPerBatch < 2 ||
        config.judge.maxImagesPerBatch > 8
      )) {
        push(errors, "config.judge.maxImagesPerBatch", "must be an integer within 2..8");
      }
      if (config.judge.maxFindingsPerBatch !== undefined && (
        !Number.isInteger(config.judge.maxFindingsPerBatch) ||
        config.judge.maxFindingsPerBatch < 1 ||
        config.judge.maxFindingsPerBatch > 12
      )) {
        push(errors, "config.judge.maxFindingsPerBatch", "must be an integer within 1..12");
      }
      if (config.judge.maxFindingsPerRun !== undefined && (!Number.isInteger(config.judge.maxFindingsPerRun) || config.judge.maxFindingsPerRun < 1)) {
        push(errors, "config.judge.maxFindingsPerRun", "must be a positive integer");
      }
      if (config.judge.timeoutMs !== undefined && (!Number.isInteger(config.judge.timeoutMs) || config.judge.timeoutMs <= 0)) {
        push(errors, "config.judge.timeoutMs", "must be a positive integer");
      }
    }
  }
  if (config.scan !== undefined) {
    if (requiredObject(config.scan, "config.scan", errors)) {
      noUnexpected(
        config.scan,
        new Set(["ruleset", "include", "tokensDir", "componentsDoc", "barrels", "shellPolicy", "ignoreRules"]),
        "config.scan",
        errors,
      );
      if (config.scan.ruleset !== undefined && !["web-css", "rn-stylesheet"].includes(config.scan.ruleset)) {
        push(errors, "config.scan.ruleset", "must be web-css or rn-stylesheet");
      }
      for (const key of ["tokensDir", "componentsDoc"]) {
        if (config.scan[key] !== undefined) nonEmptyString(config.scan[key], `config.scan.${key}`, errors);
      }
      for (const key of ["include", "barrels", "ignoreRules"]) {
        if (config.scan[key] === undefined) continue;
        const values = config.scan[key];
        if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || !value.trim())) {
          push(errors, `config.scan.${key}`, "must be a non-empty array of strings");
        } else if (new Set(values).size !== values.length) {
          push(errors, `config.scan.${key}`, "must not contain duplicates");
        }
      }
      const ruleset = config.scan.ruleset ?? "web-css";
      const knownRuleIds = SCAN_RULE_IDS[ruleset];
      // An invalid ruleset is already reported above; there is no id list to check against.
      if (knownRuleIds && Array.isArray(config.scan.ignoreRules)) {
        for (const id of config.scan.ignoreRules) {
          if (typeof id === "string" && id.trim() && !knownRuleIds.includes(id)) {
            push(
              errors,
              "config.scan.ignoreRules",
              `unknown rule id ${JSON.stringify(id)} for ruleset ${ruleset} (known: ${knownRuleIds.join(", ")})`,
            );
          }
        }
      }
      if (config.scan.shellPolicy !== undefined) {
        if (!Array.isArray(config.scan.shellPolicy)) {
          push(errors, "config.scan.shellPolicy", "must be an array of policy rules");
        } else {
          config.scan.shellPolicy.forEach((rule, index) => {
            const path = `config.scan.shellPolicy[${index}]`;
            if (!requiredObject(rule, path, errors)) return;
            noUnexpected(rule, new Set(["routeClass", "match", "require", "exceptions"]), path, errors);
            for (const key of ["routeClass", "match", "require", "exceptions"]) {
              if (!(key in rule)) push(errors, `${path}.${key}`, "is required");
            }
            nonEmptyString(rule.routeClass, `${path}.routeClass`, errors);
            for (const key of ["match", "require"]) {
              const values = rule[key];
              if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || !value.trim())) {
                push(errors, `${path}.${key}`, "must be a non-empty array of strings");
              } else if (new Set(values).size !== values.length) {
                push(errors, `${path}.${key}`, "must not contain duplicates");
              }
            }
            if (!Array.isArray(rule.exceptions) || rule.exceptions.some((value) => typeof value !== "string" || !value.trim())) {
              push(errors, `${path}.exceptions`, "must be an array of strings");
            } else if (new Set(rule.exceptions).size !== rule.exceptions.length) {
              push(errors, `${path}.exceptions`, "must not contain duplicates");
            }
          });
        }
      }
    }
  }
  if (config.capture !== undefined) {
    if (requiredObject(config.capture, "config.capture", errors)) {
      if (config.capture.mode !== undefined && !["playwright", "rn-sim"].includes(config.capture.mode)) {
        push(errors, "config.capture.mode", "must be playwright or rn-sim");
      }
      for (const key of WEB_CAPTURE_TIMEOUT_KEYS) {
        if (config.capture[key] === undefined) continue;
        if (!isValidTimeoutMs(config.capture[key])) {
          push(errors, `config.capture.${key}`, `must be a positive integer of milliseconds no greater than ${MAX_TIMEOUT_MS}`);
        }
        // The rn-sim driver has no page navigation and bounds each waitFor
        // with the target's own timeoutMs, so these keys would do nothing there.
        if (config.capture.mode === "rn-sim") {
          push(errors, `config.capture.${key}`, "applies only to capture.mode playwright (rn-sim targets set their own timeoutMs)");
        }
      }
      const session = config.capture.session;
      if (session !== undefined) {
        if (!requiredObject(session, "config.capture.session", errors)) return validationResult(errors);
        noUnexpected(session, new Set(["bootstrapHint", "readiness", "timeoutMs", "launchArgs", "resetBetweenTargets"]), "config.capture.session", errors);
        for (const key of ["bootstrapHint", "readiness", "timeoutMs"]) if (!(key in session)) push(errors, `config.capture.session.${key}`, "is required");
        nonEmptyString(session.bootstrapHint, "config.capture.session.bootstrapHint", errors);
        nonEmptyString(session.readiness, "config.capture.session.readiness", errors);
        if (!Number.isInteger(session.timeoutMs) || session.timeoutMs <= 0) push(errors, "config.capture.session.timeoutMs", "must be a positive integer");
        if (session.launchArgs !== undefined) {
          if (!requiredObject(session.launchArgs, "config.capture.session.launchArgs", errors)) return validationResult(errors);
          // These become `-key value` simctl launch arguments, so a key that
          // needs quoting would silently change the argv the app receives.
          for (const [key, value] of Object.entries(session.launchArgs)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) push(errors, `config.capture.session.launchArgs.${key}`, "must be a bare launch-argument name matching /^[A-Za-z_][A-Za-z0-9_]*$/");
            if (typeof value !== "string") push(errors, `config.capture.session.launchArgs.${key}`, "must be a string");
          }
        }
        if (session.resetBetweenTargets !== undefined && typeof session.resetBetweenTargets !== "boolean") {
          push(errors, "config.capture.session.resetBetweenTargets", "must be a boolean");
        }
      }
      if (config.capture.scrollProbe !== undefined) {
        validateScrollProbe(config.capture.scrollProbe, "config.capture.scrollProbe", errors);
      }
    }
  }
  return validationResult(errors);
}

function normalizeConfig(config) {
  const validation = validateConfig(config);
  if (!validation.valid) throw new Error(`invalid config:\n${validation.errors.map((error) => `  - ${error}`).join("\n")}`);
  // v1 and v2 deliberately share route names and shapes. Moving to v2 only
  // makes the version explicit; `waitFor` remains the target readiness field.
  return { ...JSON.parse(JSON.stringify(config)), configVersion: 2 };
}

module.exports = {
  CHECKLIST_PHASES,
  recordCompleteness,
  normalizeConfig,
  schemas,
  validateConfig,
  validateAppendPosixShotHashPolicy,
  validateAppendCropDigestPolicy,
  validateExemplar,
  validateFinding,
  validateJudgeResponse,
  validateJudgmentState,
  validateJudgePack,
  legacyCropDigestEventIds,
  validateReceipt,
  validateReceiptForTarget,
  validateCropRequests,
  validateReviewEvent,
  validateReviewEventBatch,
  validateReviewEvents,
};
