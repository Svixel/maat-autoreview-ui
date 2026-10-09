"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const { basename, dirname, join, relative, resolve, sep } = require("node:path");

const { encodePng, decodePng } = require("../scripts/png.cjs");
const { assertPackAssetHashesMatchCapture, buildJudgePack, loadExemplars, renderInitialPrompt, writeJsonAtomic } = require("../scripts/judge-pack.cjs");
const { buildApiEngineRequest, buildCodexEngineInvocation, buildJudgeEnvironment, codexEngineAdapter, findExecutable, JudgeExecutorError, resolveJudgeModelSelection, runJudge } = require("../scripts/judge-runner.cjs");
const { acquireJudgeLock, judgeLockPath, releaseJudgeLock } = require("../scripts/judge-lock.cjs");
const {
  acquireLibraryLock,
  assetIdentity,
  latestAssetPath,
  persistReviewCrops,
  readJudgmentState,
  releaseLibraryLock,
  sealJudgmentState,
} = require("../scripts/library.cjs");
const { assetIdFor, produceCrops } = require("../scripts/evidence.cjs");
const { appendReviewRecord } = require("../scripts/review-record.cjs");
const { finalizeCaptureRun, loadCompletedCaptureRun } = require("../scripts/ui-review");
const { CHECKLIST_PHASES, validateExemplar, validateJudgePack, validateJudgeResponse, validateJudgmentState } = require("../schemas/validator.cjs");

const UI_JUDGE = join(__dirname, "..", "scripts", "ui-judge");
const UI_REVIEW = join(__dirname, "..", "scripts", "ui-review");

const HASH = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

const OPENAI_STRICT_WIRE_KEYWORDS = new Set([
  "$defs", "$ref", "additionalProperties", "anyOf", "const", "enum",
  "exclusiveMaximum", "exclusiveMinimum", "format", "items", "maximum",
  "maxItems", "minimum", "minItems", "multipleOf", "pattern", "properties",
  "required", "type",
]);

function assertOnlyOpenAiStrictWireKeywords(schema, path = "$") {
  assert.ok(schema && typeof schema === "object" && !Array.isArray(schema), `${path} must be a schema object`);
  for (const [keyword, value] of Object.entries(schema)) {
    assert.equal(OPENAI_STRICT_WIRE_KEYWORDS.has(keyword), true, `${path} contains unsupported keyword ${keyword}`);
    if (keyword === "properties" || keyword === "$defs") {
      for (const [name, child] of Object.entries(value)) {
        assertOnlyOpenAiStrictWireKeywords(child, `${path}.${keyword}.${name}`);
      }
    } else if (keyword === "items") {
      assertOnlyOpenAiStrictWireKeywords(value, `${path}.items`);
    } else if (keyword === "anyOf") {
      value.forEach((child, index) => assertOnlyOpenAiStrictWireKeywords(child, `${path}.anyOf[${index}]`));
    }
  }
}

function png(width = 20, height = 10, fill = 0x77) {
  return encodePng({ width, height, channels: 4, data: Buffer.alloc(width * height * 4, fill) });
}

function fixture({
  count = 6,
  project = "fixture",
  root = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-project-")),
  assetsByTarget = {},
} = {}) {
  const runDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-run-"));
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  const shotsDir = join(runDir, "shots");
  mkdirSync(shotsDir);
  const ids = ["anchor", "peer", "third", ...Array.from({ length: Math.max(0, count - 3) }, (_, index) => `screen-${index + 1}`)];
  const cfg = {
    configVersion: 2,
    name: project,
    root,
    baseUrl: "http://127.0.0.1:9",
    intentDoc: "skill:projects/intent/.gitkeep",
    capture: { mode: "rn-sim", appearance: ["dark"] },
    auth: { mode: "none" },
    reviewGroups: [{
      id: "siblings",
      targetIds: ["anchor", "peer", "third"],
      anchorId: "anchor",
      purpose: "Compare sibling screens against anchor.",
    }, ...(count >= 12 ? [{
      id: "second-siblings",
      targetIds: ids.slice(3),
      anchorId: "screen-1",
      purpose: "Compare the second sibling family against screen-1.",
    }] : [])],
    routes: ids.map((id) => ({ id, route: id, sourceFiles: [`app/${id}.tsx`] })),
  };
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  const targetShotHashes = {};
  const targetOutcomes = {};
  const manifestTargets = [];
  const contexts = {};
  const fingerprints = {};
  for (const [index, id] of ids.entries()) {
    const shots = [];
    targetShotHashes[id] = {};
    const assetCount = Math.max(1, assetsByTarget[id] || 1);
    for (let assetIndex = 0; assetIndex < assetCount; assetIndex += 1) {
      const filename = `${id}.dark.full-${assetIndex + 1}.png`;
      const path = join(shotsDir, filename);
      const contents = png(20 + index + assetIndex, 10 + ((index + assetIndex) % 2), 0x60 + index + assetIndex);
      writeFileSync(path, contents);
      targetShotHashes[id][filename] = HASH(contents);
      shots.push({ path, viewport: `fixture-dark-${assetIndex + 1}`, kind: "full" });
    }
    targetOutcomes[id] = "captured";
    manifestTargets.push({ id, outcome: "captured", errors: [], shots, interactions: [] });
    contexts[id] = {
      version: "judge-context.v1",
      targetId: id,
      capBytes: 8192,
      shellPolicy: [],
      inventoryMatches: [],
      scrollProbes: {},
      intentExcerpts: [],
      omitted: [],
    };
    fingerprints[id] = { fingerprint: `sha256:${String(index + 1).repeat(64).slice(0, 64)}` };
  }
  const run = {
    runId: randomUUID(),
    project,
    targetIds: ids,
    targetOutcomes,
    targetShotHashes,
    targetFingerprints: fingerprints,
    captureComplete: true,
    captureFailed: false,
    commit: "abcdef1",
    patchHash: `sha256:${"b".repeat(64)}`,
  };
  writeFileSync(join(runDir, "run.json"), JSON.stringify(run, null, 2));
  writeFileSync(join(shotsDir, "manifest.json"), JSON.stringify({ targets: manifestTargets }, null, 2));
  writeFileSync(join(runDir, "bundle.json"), JSON.stringify({ project, judgeContext: contexts }, null, 2));
  return { cfg, configPath, contexts, ids, root, run, runDir, stateDir };
}

function buildPack(subject, options = {}) {
  return buildJudgePack({ cfg: subject.cfg, runDir: subject.runDir, run: subject.run, stateDir: subject.stateDir, ...options });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function verificationCrops(subject) {
  return readJson(join(subject.runDir, "shots", "manifest.json")).targets
    .flatMap((target) => target.shots || [])
    .filter((shot) => typeof shot.cropId === "string" && shot.cropId.startsWith("verify-"));
}

function modelFindings(count, image) {
  return Array.from({ length: count }, () => validEngineFinding({
    id: randomUUID(),
    targetId: image.targetId,
    assetId: image.assetId,
  }));
}

function regularFilesUnder(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...regularFilesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function judgedFingerprints(pack, disposition = "clean") {
  return Object.fromEntries(Object.entries(pack.targetFingerprints).map(([targetId, fingerprint]) => [targetId, {
    fingerprint,
    ...pack.targetJudgmentEvidence[targetId],
    disposition,
  }]));
}

function limitCaptureTo(subject, targetIds) {
  const selected = new Set(targetIds);
  subject.run.targetIds = subject.run.targetIds.filter((targetId) => selected.has(targetId));
  subject.run.targetOutcomes = Object.fromEntries(
    Object.entries(subject.run.targetOutcomes).filter(([targetId]) => selected.has(targetId)),
  );
  subject.run.targetShotHashes = Object.fromEntries(
    Object.entries(subject.run.targetShotHashes).filter(([targetId]) => selected.has(targetId)),
  );
  subject.run.targetFingerprints = Object.fromEntries(
    Object.entries(subject.run.targetFingerprints).filter(([targetId]) => selected.has(targetId)),
  );
  const manifestPath = join(subject.runDir, "shots", "manifest.json");
  const manifest = readJson(manifestPath);
  manifest.targets = manifest.targets.filter((target) => selected.has(target.id));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const bundlePath = join(subject.runDir, "bundle.json");
  const bundle = readJson(bundlePath);
  bundle.judgeContext = Object.fromEntries(
    Object.entries(bundle.judgeContext).filter(([targetId]) => selected.has(targetId)),
  );
  writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
  writeFileSync(join(subject.runDir, "run.json"), JSON.stringify(subject.run, null, 2));
}

function retainAnchorLatest(subject) {
  const captureManifest = readJson(join(subject.runDir, "shots", "manifest.json"));
  const peer = captureManifest.targets.find((target) => target.id === "peer");
  const peerRoute = subject.cfg.routes.find((target) => target.id === "peer");
  const identity = {
    ...assetIdentity(peerRoute, peer.shots[0], captureManifest, subject.cfg),
    targetId: "anchor",
  };
  const path = latestAssetPath(subject.cfg.name, identity, subject.stateDir);
  mkdirSync(dirname(path), { recursive: true });
  const runId = randomUUID();
  const bytes = png();
  const assetPath = "shots/anchor-retained.png";
  const immutablePath = join(subject.stateDir, subject.cfg.name, "runs", runId, assetPath);
  mkdirSync(dirname(immutablePath), { recursive: true });
  writeFileSync(immutablePath, bytes);
  writeFileSync(path, bytes);
  const manifestPath = join(subject.stateDir, subject.cfg.name, "manifest.jsonl");
  writeFileSync(manifestPath, `${JSON.stringify({ recordType: "asset", outcome: "captured", runId, assetPath, ...identity })}\n`);
  return { identity, path, runId, assetPath, bytes };
}

function publishRetainedAnchor(subject, identity, bytes, label) {
  const runId = randomUUID();
  const assetPath = `shots/anchor-${label}.png`;
  const immutablePath = join(subject.stateDir, subject.cfg.name, "runs", runId, assetPath);
  const path = latestAssetPath(subject.cfg.name, identity, subject.stateDir);
  mkdirSync(dirname(immutablePath), { recursive: true });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(immutablePath, bytes);
  writeFileSync(path, bytes);
  const manifestPath = join(subject.stateDir, subject.cfg.name, "manifest.jsonl");
  const existing = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
  writeFileSync(manifestPath, `${existing}${JSON.stringify({ recordType: "asset", outcome: "captured", runId, assetPath, ...identity })}\n`);
  return { identity, path, runId, assetPath, bytes };
}

function retainAnchorVariants(subject) {
  const captureManifest = readJson(join(subject.runDir, "shots", "manifest.json"));
  const peer = captureManifest.targets.find((target) => target.id === "peer");
  const peerRoute = subject.cfg.routes.find((target) => target.id === "peer");
  const baseIdentity = {
    ...assetIdentity(peerRoute, peer.shots[0], captureManifest, subject.cfg),
    targetId: "anchor",
  };
  return [
    publishRetainedAnchor(subject, baseIdentity, png(20, 10, 0x51), "base"),
    publishRetainedAnchor(subject, { ...baseIdentity, variant: "alternate" }, png(22, 11, 0x52), "alternate"),
  ];
}

function retainImmutableExemplar(subject, id = "immutable-exemplar") {
  const runId = randomUUID();
  const libraryPath = `runs/${runId}/shots/${id}.png`;
  const bytes = png(23, 11, 0x4a);
  const sourcePath = join(subject.stateDir, subject.cfg.name, libraryPath);
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, bytes);
  const exemplar = {
    id,
    path: `projects/exemplars/${subject.cfg.name}/${id}.json`,
    screenshot: { status: "available", libraryPath, sha256: HASH(bytes) },
    rubricVersion: "rubric.v1",
    curator: "fixture curator",
    expectedFindings: ["The immutable fixture exemplar has a pinned visual precedent."],
    severity: "P2",
  };
  Object.defineProperty(exemplar, "bytes", { value: bytes });
  return exemplar;
}

function recordHeaderFor(subject) {
  return {
    kind: "record-header",
    version: 1,
    runId: subject.run.runId,
    project: subject.cfg.name,
    configHash: `sha256:${"a".repeat(64)}`,
    commitHash: subject.run.commit,
    patchHash: subject.run.patchHash,
    targets: subject.ids,
    targetShotHashes: subject.run.targetShotHashes,
    intentSource: subject.cfg.intentDoc,
    rubricVersion: "rubric.v1",
    model: { provider: "fake", name: "fixture" },
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

function cropBackedRecordEvents(subject, crop, { assetId = crop.sourceAssetId, region = crop.rect } = {}) {
  const findingId = randomUUID();
  const finalFinding = {
    ...validEngineFinding({ id: findingId, targetId: crop.sourceAssetId.split("/", 1)[0], assetId }),
    region,
    cropId: crop.cropId,
    cropDigest: HASH(readFileSync(crop.path)),
    verifierVerdict: "confirmed",
    disposition: "accepted",
  };
  const { verifierVerdict, disposition, ...candidate } = finalFinding;
  return [
    recordHeaderFor(subject),
    { kind: "initial", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", finding: candidate },
    { kind: "verification", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:02.000Z", findingId, verifierVerdict, evidence: "The crop verifies this fixture finding." },
    { kind: "disposition", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:03.000Z", finding: finalFinding },
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:04.000Z", findingCount: 1, findingIds: [findingId] },
  ];
}

function cropReviewFinalization(subject, built, events) {
  const pack = built.pack ?? built;
  return {
    version: 1,
    packId: pack.packId,
    targets: events[0].targets.map((targetId) => {
      const dispositions = events
        .filter((event) => event.kind === "disposition" && event.finding.targetId === targetId)
        .map((event) => event.finding.disposition);
      const disposition = dispositions.includes("not-judged")
        ? "not-judged"
        : dispositions.includes("accepted")
          ? "accepted"
          : dispositions.length
            ? "rejected"
            : "clean";
      return {
        targetId,
        fingerprint: pack.targetFingerprints[targetId],
        ...pack.targetJudgmentEvidence[targetId],
        runId: subject.run.runId,
        disposition,
      };
    }),
  };
}

function cropForRecord(subject, region = { x: 0.1, y: 0.2, w: 0.4, h: 0.3, normalized: true }) {
  const manifestPath = join(subject.runDir, "shots", "manifest.json");
  const captureManifest = readJson(manifestPath);
  const source = captureManifest.targets[0].shots[0];
  const sourceTarget = captureManifest.targets[0].id;
  const configuredTarget = subject.cfg.routes.find((target) => target.id === sourceTarget);
  const sourceAssetId = assetIdFor(configuredTarget, source, captureManifest, subject.cfg);
  const crop = produceCrops({
    captureManifest,
    cfg: subject.cfg,
    shotsDir: join(subject.runDir, "shots"),
    cropRequests: [{ assetId: sourceAssetId, rect: region, purpose: `record-${randomUUID()}` }],
  }).produced[0];
  writeFileSync(manifestPath, JSON.stringify(captureManifest, null, 2));
  subject.run = finalizeCaptureRun(join(subject.runDir, "run.json"), subject.run, captureManifest, join(subject.runDir, "shots"));
  return crop;
}

function finalizedVerificationCrop(subject, findingId = randomUUID(), region = { x: 0.1, y: 0.2, w: 0.4, h: 0.3, normalized: true }) {
  const manifestPath = join(subject.runDir, "shots", "manifest.json");
  const captureManifest = readJson(manifestPath);
  const source = captureManifest.targets[0].shots[0];
  const sourceTarget = captureManifest.targets[0].id;
  const configuredTarget = subject.cfg.routes.find((target) => target.id === sourceTarget);
  const sourceAssetId = assetIdFor(configuredTarget, source, captureManifest, subject.cfg);
  const crop = produceCrops({
    captureManifest,
    cfg: subject.cfg,
    shotsDir: join(subject.runDir, "shots"),
    cropRequests: [{ assetId: sourceAssetId, rect: region, purpose: `verify-${findingId}` }],
  }).produced[0];
  writeFileSync(manifestPath, JSON.stringify(captureManifest, null, 2));
  subject.run = finalizeCaptureRun(join(subject.runDir, "run.json"), subject.run, captureManifest, join(subject.runDir, "shots"));
  return crop;
}

function recordCropEvents(subject, events) {
  const eventsPath = join(subject.root, `record-${randomUUID()}.json`);
  writeFileSync(eventsPath, JSON.stringify(events, null, 2));
  return spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--record", eventsPath, "--run", subject.runDir, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
  );
}

function leaveCommittedCropJournal(subject) {
  const crop = finalizedVerificationCrop(subject);
  const pack = buildPack(subject);
  const events = cropBackedRecordEvents(subject, crop);
  const lease = acquireLibraryLock(subject.cfg, subject.stateDir);
  try {
    assert.throws(
      () => appendReviewRecord(events, {
        projectRoot: subject.cfg.root,
        stateDir: subject.stateDir,
        targetIds: subject.cfg.routes.map((route) => route.id),
        capturedTargetIds: subject.run.targetIds,
        capturedTargetOutcomes: subject.run.targetOutcomes,
        capturedTargetShotHashes: subject.run.targetShotHashes,
        beforeCommit(context) {
          persistReviewCrops({
            cfg: subject.cfg,
            libraryLease: lease,
            runDir: subject.runDir,
            run: subject.run,
            events,
            reviewPath: context.path,
            combinedEvents: context.combinedEvents,
            finalization: cropReviewFinalization(subject, pack, context.combinedEvents),
          });
        },
        afterCommit() {
          throw new Error("fixture crash after committed review");
        },
      }),
      /fixture crash after committed review/,
    );
  } finally {
    releaseLibraryLock(lease);
  }
  return { crop, events, pack };
}

function validEngineFinding({ id, targetId, assetId }) {
  return {
    id,
    ruleId: "consistency/spacing",
    targetId,
    assetId,
    region: { x: 0.1, y: 0.2, w: 0.4, h: 0.3, normalized: true },
    evidence: "The visible card spacing differs from the anchor.",
    priority: "P2",
    confidence: 0.8,
    initialVerdict: "finding",
    verifierVerdict: "not-judged",
    disposition: "not-judged",
    scope: "in-scope",
  };
}

function initialEngineResponse(call, findings = [], { notJudged = [] } = {}) {
  const notJudgedPairs = new Set(notJudged.map(({ targetId, phase }) => `${targetId}\u0000${phase}`));
  const findingPairs = new Set(
    findings
      .filter((finding) => typeof finding?.ruleId === "string")
      .map((finding) => `${finding.targetId}\u0000${finding.ruleId.split("/", 1)[0]}`),
  );
  const coverage = call.batch.targetIds.flatMap((targetId) => CHECKLIST_PHASES.map((phase) => ({
    targetId,
    phase,
    result: notJudgedPairs.has(`${targetId}\u0000${phase}`)
      ? "not-judged"
      : findingPairs.has(`${targetId}\u0000${phase}`)
        ? "findings"
        : "clean",
  })));
  assert.equal(validateJudgeResponse({ findings, coverage }, { targetIds: call.batch.targetIds, phases: call.batch.checklistPhases }).valid, true);
  return JSON.stringify({ findings, coverage });
}

function cropVerificationEngine(firstImage, findingId) {
  let emittedInitial = false;
  return (call) => {
    if (call.phase === "verification") {
      return JSON.stringify({ verifierVerdict: "confirmed", evidence: "The fake verification crop confirms the finding." });
    }
    if (emittedInitial) return initialEngineResponse(call);
    emittedInitial = true;
    return initialEngineResponse(call, [validEngineFinding({
      id: findingId,
      targetId: firstImage.targetId,
      assetId: firstImage.assetId,
    })]);
  };
}

function replaceCapturedShot(subject, targetId = "peer") {
  const asset = Object.keys(subject.run.targetShotHashes[targetId])[0];
  const contents = png(41, 23, 0xa3);
  writeFileSync(join(subject.runDir, "shots", asset), contents);
  subject.run.targetShotHashes[targetId][asset] = HASH(contents);
  // Keep the source/config fingerprint untouched: this simulates a same-code
  // recapture whose capture-manifest path and run digest were replaced.
  writeFileSync(join(subject.runDir, "run.json"), JSON.stringify(subject.run, null, 2));
  return asset;
}

test("judge pack keeps comparison groups separate, re-anchors split groups, and reuses contexts verbatim", () => {
  const subject = fixture({ count: 12 });
  const result = buildPack(subject);
  assert.equal(validateJudgePack(result.pack).valid, true);
  assert.equal(result.pack.runId, subject.run.runId);
  assert.deepEqual(result.pack.targetShotHashes, subject.run.targetShotHashes);
  assert.equal(result.pack.batches.length, 3);
  const groupByTarget = new Map(subject.cfg.reviewGroups.flatMap((group) => group.targetIds.map((targetId) => [targetId, group])));
  for (const batch of result.pack.batches) {
    const list = readJson(join(subject.runDir, batch.imageList));
    const finalPrompt = renderInitialPrompt(readFileSync(join(subject.runDir, batch.prompt), "utf8"), {
      screenAttachmentCount: list.images.length,
      exemplars: result.pack.exemplars,
    });
    assert.equal(batch.promptDigest, HASH(Buffer.from(finalPrompt, "utf8")));
    assert.ok(list.images.length >= 6 && list.images.length <= 8);
    assert.equal(list.groupId, batch.groupId);
    assert.equal(list.images[0].targetId, list.anchorId);
    const groups = new Set(list.images.map((image) => groupByTarget.get(image.targetId)?.id));
    assert.deepEqual([...groups], [batch.groupId], `batch ${batch.id} must not mix comparison groups`);
  }
  for (const targetId of result.pack.targets) {
    const evidence = result.pack.targetJudgmentEvidence[targetId];
    const expectedPromptDigests = Object.fromEntries(
      result.pack.batches
        .filter((batch) => batch.targetIds.includes(targetId))
        .map((batch) => [batch.id, batch.promptDigest]),
    );
    assert.deepEqual(evidence.promptDigests, expectedPromptDigests);
    assert.match(evidence.baseEvidenceDigest, /^sha256:[a-f0-9]{64}$/);
  }
  const missingPromptDigest = structuredClone(result.pack);
  delete missingPromptDigest.batches[0].promptDigest;
  assert.equal(validateJudgePack(missingPromptDigest).valid, false);
  const splitGroup = result.pack.batches.filter((batch) => batch.groupId === "second-siblings");
  assert.equal(splitGroup.length, 2, "the nine-image second group must split at the cap");
  for (const batch of splitGroup) {
    const list = readJson(join(subject.runDir, batch.imageList));
    assert.equal(list.images[0].targetId, "screen-1");
    assert.equal(list.images[0].anchor, true);
  }
  const first = readJson(join(subject.runDir, result.pack.batches[0].imageList));
  assert.equal(first.images[0].targetId, "anchor");
  const resized = decodePng(readFileSync(join(subject.runDir, first.images[0].image)));
  assert.equal(Math.max(resized.width, resized.height), 1568);
  assert.deepEqual(readJson(join(subject.runDir, result.pack.contexts.find((context) => context.targetId === "peer").path)), subject.contexts.peer);
  const prompt = readFileSync(join(subject.runDir, result.pack.batches[0].prompt), "utf8");
  assert.match(prompt, /Visual polish/);
  assert.match(prompt, /"targetId": "peer"/);
  assert.match(prompt, /first image is\s+the named comparison anchor/i);
  const standaloneSubject = fixture({ count: 6 });
  const standalonePack = buildPack(standaloneSubject).pack;
  const standalone = standalonePack.batches.find((batch) => batch.anchorId === null);
  const standalonePrompt = readFileSync(join(standaloneSubject.runDir, standalone.prompt), "utf8");
  assert.match(standalonePrompt, /No comparison anchor\s+is provided; judge each screen on its own/i);
  assert.doesNotMatch(standalonePrompt, /first image is\s+the named comparison anchor/i);
  assert.doesNotMatch(standalonePrompt, /match the comparison anchor/i);
  assert.equal(readJson(join(subject.runDir, result.pack.cropRequests)).length, 0);
});

test("judge pack reads capture images from honest nested shot directories", () => {
  const subject = fixture({ count: 6 });
  const shotsDir = join(subject.runDir, "shots");
  const manifestPath = join(shotsDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const shot = manifest.targets.find((target) => target.id === "anchor").shots[0];
  const oldPath = shot.path;
  const oldAsset = relative(shotsDir, oldPath).split(sep).join("/");
  const nestedDir = join(shotsDir, "honest", "nested");
  const nestedPath = join(nestedDir, basename(oldPath));
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(nestedPath, readFileSync(oldPath));
  rmSync(oldPath);
  shot.path = nestedPath;
  delete subject.run.targetShotHashes.anchor[oldAsset];
  subject.run.targetShotHashes.anchor[`honest/nested/${basename(oldPath)}`] = HASH(readFileSync(nestedPath));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  writeFileSync(join(subject.runDir, "run.json"), JSON.stringify(subject.run, null, 2));

  assert.equal(validateJudgePack(buildPack(subject).pack).valid, true);
});

test("judge pack refuses a matching-hash capture image below a symlinked shots ancestor", () => {
  const subject = fixture({ count: 6 });
  const shotsDir = join(subject.runDir, "shots");
  const manifestPath = join(shotsDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const shot = manifest.targets.find((target) => target.id === "anchor").shots[0];
  const oldAsset = relative(shotsDir, shot.path).split(sep).join("/");
  const outside = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-external-shot-"));
  const externalPath = join(outside, "secret.png");
  const externalBytes = png(31, 17, 0x5a);
  writeFileSync(externalPath, externalBytes);
  const link = join(shotsDir, "link");
  symlinkSync(outside, link);
  const linkedPath = join(link, "secret.png");
  shot.path = linkedPath;
  delete subject.run.targetShotHashes.anchor[oldAsset];
  subject.run.targetShotHashes.anchor["link/secret.png"] = HASH(externalBytes);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  writeFileSync(join(subject.runDir, "run.json"), JSON.stringify(subject.run, null, 2));

  assert.throws(
    () => buildPack(subject),
    (error) => error.message.includes(linkedPath) && /symlink component/i.test(error.message),
  );
});

test("ui-review --judge-pack emits the documented run-bound manifest without a capture", () => {
  const subject = fixture({ count: 6 });
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--judge-pack", "--run", subject.runDir, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.runId, subject.run.runId);
  assert.equal(readJson(report.judgePack.path).version, "judgepack.v1");
});

test("judge-pack reloads the completed capture after taking the judge lock instead of using a stale caller snapshot", () => {
  const subject = fixture({ count: 6 });
  const staleRun = structuredClone(subject.run);
  const crop = cropForRecord(subject);
  const cropAsset = relative(join(subject.runDir, "shots"), crop.path).split(sep).join("/");
  assert.equal(staleRun.targetShotHashes.anchor[cropAsset], undefined);

  const built = buildJudgePack({
    cfg: subject.cfg,
    runDir: subject.runDir,
    run: staleRun,
    stateDir: subject.stateDir,
  });
  assert.equal(built.pack.targetShotHashes.anchor[cropAsset], HASH(readFileSync(crop.path)));
  assert.equal(built.pack.attachmentHashes[`shots/${cropAsset}`], HASH(readFileSync(crop.path)));
  assert.equal(validateJudgePack(built.pack).valid, true);
});

test("judge-pack loading canonicalizes legacy Windows shot-hash keys before base and crop lookups", () => {
  const subject = fixture({ count: 6 });
  const shotsDir = join(subject.runDir, "shots");
  const manifestPath = join(shotsDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const anchor = manifest.targets.find((target) => target.id === "anchor");
  const source = anchor.shots[0].path;
  const nestedDir = join(shotsDir, "legacy-windows");
  mkdirSync(nestedDir);
  const nestedPath = join(nestedDir, basename(source));
  const bytes = readFileSync(source);
  writeFileSync(nestedPath, bytes);
  anchor.shots[0].path = nestedPath;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const canonicalKey = `legacy-windows/${basename(source)}`;
  const crop = cropForRecord(subject);
  const canonicalCropKey = relative(shotsDir, crop.path).split(sep).join("/");
  subject.run.targetShotHashes = Object.fromEntries(
    Object.entries(subject.run.targetShotHashes).map(([targetId, assets]) => [
      targetId,
      Object.fromEntries(Object.entries(assets).map(([asset, digest]) => [asset.replace(/\//g, "\\"), digest])),
    ]),
  );
  writeFileSync(join(subject.runDir, "run.json"), JSON.stringify(subject.run, null, 2));

  const loaded = loadCompletedCaptureRun(subject.runDir, subject.cfg);
  assert.equal(loaded.run.targetShotHashes.anchor[canonicalKey], HASH(bytes));
  assert.equal(loaded.run.targetShotHashes.anchor[canonicalCropKey], HASH(readFileSync(crop.path)));
  const result = buildJudgePack({
    cfg: subject.cfg,
    runDir: subject.runDir,
    run: loaded.run,
    stateDir: subject.stateDir,
  });
  assert.equal(result.pack.targetShotHashes.anchor[canonicalKey], HASH(bytes));
  assert.equal(result.pack.targetShotHashes.anchor[canonicalCropKey], HASH(readFileSync(crop.path)));
  assert.equal(result.pack.attachmentHashes[`shots/${canonicalCropKey}`], HASH(readFileSync(crop.path)));
  assert.equal(Object.keys(result.pack.targetShotHashes.anchor).some((asset) => asset.includes("\\")), false);
  assert.equal(validateJudgePack(result.pack).valid, true);
});

test("ui-review --judge-pack --targets limits fingerprint selection to the named target", () => {
  const subject = fixture({ count: 3 });
  retainAnchorLatest(subject);
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--judge-pack", "--run", subject.runDir, "--targets", "peer", "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.judgePack.targets, ["peer"]);
  const pack = readJson(report.judgePack.path);
  assert.deepEqual(pack.targets, ["peer"]);
  assert.deepEqual(pack.batches.flatMap((batch) => batch.targetIds), ["peer"]);
});

test("ui-review --judge-pack --targets ignores an unrelated anchorless comparison group", () => {
  const subject = fixture({ count: 4 });
  limitCaptureTo(subject, ["peer", "screen-1"]);
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--judge-pack", "--run", subject.runDir, "--targets", "screen-1", "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const pack = readJson(JSON.parse(result.stdout).judgePack.path);
  assert.deepEqual(pack.targets, ["screen-1"]);
  assert.ok(pack.batches.every((batch) => batch.groupId === null));
});

test("ui-review --judge-pack --targets still requires the selected comparison member's anchor", () => {
  const subject = fixture({ count: 4 });
  limitCaptureTo(subject, ["peer", "screen-1"]);
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--judge-pack", "--run", subject.runDir, "--targets", "peer", "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
  );
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /anchor.*(?:capture anchor|include it in --targets)/i);
});

test("ui-review --judge-pack rejects unsupported scope options instead of ignoring them", () => {
  const subject = fixture({ count: 3 });
  const base = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--judge-pack", "--run", subject.runDir, "--base", "HEAD"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
  );
  assert.equal(base.status, 2, base.stdout);
  assert.match(base.stderr, /--judge-pack does not support --base/);

  const confidence = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--judge-pack", "--run", subject.runDir, "--min-confidence", "0.8"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
  );
  assert.equal(confidence.status, 2, confidence.stdout);
  assert.match(confidence.stderr, /--judge-pack does not support non-default --min-confidence/);
});

test("judge lock refuses symlinked and in-project run paths before creating judge state", () => {
  const subject = fixture({ count: 3 });
  const links = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-lock-link-"));
  const linkedRun = join(links, "linked-run");
  symlinkSync(subject.runDir, linkedRun, "dir");

  assert.throws(
    () => acquireJudgeLock(linkedRun, {
      waitMs: 0,
      createJudgeDir: true,
      projectRoot: subject.cfg.root,
    }),
    /non-symlink directory/,
  );
  assert.equal(existsSync(join(subject.runDir, "judge")), false, "symlink refusal must happen before judge/ creation");

  const inProjectRun = join(subject.root, "capture-run");
  mkdirSync(inProjectRun);
  assert.throws(
    () => acquireJudgeLock(inProjectRun, {
      waitMs: 0,
      createJudgeDir: true,
      projectRoot: subject.cfg.root,
    }),
    /inside project root and is rejected/,
  );
  assert.deepEqual(readdirSync(inProjectRun), [], "boundary refusal must not create judge/ or a lock");
});

test("judge-pack serializes manifest replacement and reclaims a stale per-run judge lock", () => {
  const subject = fixture({ count: 6 });
  const held = acquireJudgeLock(subject.runDir, {
    waitMs: 0,
    createJudgeDir: true,
    projectRoot: subject.cfg.root,
  });
  let manifestReplacements = 0;
  try {
    assert.throws(
      () => buildPack(subject, {
        judgeLockWaitMs: 0,
        writeRootManifest(path, value) {
          manifestReplacements += 1;
          writeJsonAtomic(path, value);
        },
      }),
      /another judge operation is running/,
    );
    assert.equal(manifestReplacements, 0, "a contender must be refused before root-manifest replacement");
  } finally {
    releaseJudgeLock(held);
  }

  const built = buildPack(subject, {
    judgeLockWaitMs: 0,
    writeRootManifest(path, value) {
      manifestReplacements += 1;
      writeJsonAtomic(path, value);
    },
  });
  assert.equal(manifestReplacements, 1);
  assert.equal(readJson(built.path).packId, built.pack.packId);

  const deadWriter = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(deadWriter.status, 0);
  const lockPath = judgeLockPath(subject.runDir);
  writeFileSync(lockPath, `${JSON.stringify({ pid: deadWriter.pid, createdAt: Date.now() })}\n`, { mode: 0o600 });
  const rebuilt = buildPack(subject, { judgeLockWaitMs: 0 });
  assert.notEqual(rebuilt.pack.packId, built.pack.packId);
  assert.equal(existsSync(lockPath), false, "the reclaimed operation lock must be released after the rebuild");
});

test("Codex executable lookup honors Windows PATHEXT and PATH delimiters while preserving POSIX lookup", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-path-"));
  const missing = join(root, "missing");
  const bin = join(root, "bin");
  const scratchDir = join(root, "scratch");
  const sourceCodexHome = join(root, "source-codex-home");
  mkdirSync(bin);
  mkdirSync(scratchDir);
  mkdirSync(sourceCodexHome);
  const windowsCodex = join(bin, "codex.cmd");
  writeFileSync(windowsCodex, "@echo off\n");
  writeFileSync(join(sourceCodexHome, "auth.json"), JSON.stringify({ fixture: "FAKE-CRED-A" }), { mode: 0o600 });
  try {
    assert.equal(
      findExecutable("codex", `${missing};${bin}`, { platform: "win32", pathExtValue: ".EXE;.CMD;.BAT" }),
      resolve(windowsCodex),
    );
    const invocation = buildCodexEngineInvocation({
      images: [],
      scratchDir,
      environment: {
        PATH: `${missing};${bin}`,
        PATHEXT: ".EXE;.CMD;.BAT",
        HOME: root,
        CODEX_HOME: sourceCodexHome,
        AUTOREVIEW_UI_ALLOW_UNCONFINED_JUDGE: "1",
      },
      platform: "win32",
    });
    assert.equal(invocation.command, realpathSync(windowsCodex));
    assert.equal(invocation.env.PATH.split(";")[0], dirname(realpathSync(windowsCodex)));
    assert.equal(invocation.env.PATH.includes(":"), false);

    const posixCodex = join(bin, "codex");
    writeFileSync(posixCodex, "#!/bin/sh\n");
    assert.equal(findExecutable("codex", `${missing}:${bin}`, { platform: "linux" }), resolve(posixCodex));
    const posixEnvironment = buildJudgeEnvironment({
      scratchDir,
      codexPath: posixCodex,
      codexHome: join(scratchDir, "codex-home"),
      needsNode: false,
      platform: "linux",
    });
    assert.equal(posixEnvironment.PATH.split(":")[0], bin);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex judge adapter uses a scrubbed environment and deny-default macOS profile with the fake engine", () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-judge-scratch-"));
  const sourceCodexHome = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-codex-home-"));
  try {
    const image = join(tmpdir(), "fixture-image.png");
    writeFileSync(join(sourceCodexHome, "auth.json"), "fake auth fixture\n", { mode: 0o600 });
    const parentEnvironment = {
      PATH: "/host/bin:/usr/bin",
      HOME: "/host/home",
      CODEX_HOME: sourceCodexHome,
      LANG: "en_US.UTF-8",
      AUTOREVIEW_UI_ALLOW_UNCONFINED_JUDGE: "1",
      FAKE_SENSITIVE_VAR_A: "must-not-reach-the-judge",
      FAKE_SENSITIVE_VAR_C: "must-not-reach-the-judge",
      FAKE_SENSITIVE_VAR_B: "must-not-reach-the-judge",
    };
    const invocation = buildCodexEngineInvocation({
      images: [image],
      scratchDir,
      environment: parentEnvironment,
      platform: "darwin",
      codexPath: "/runtime/bin/codex",
      sandboxExecutable: "/usr/bin/sandbox-exec",
    });
    assert.equal(invocation.command, "/usr/bin/sandbox-exec");
    assert.equal(invocation.cwd, resolve(scratchDir));
    assert.deepEqual(invocation.args.slice(0, 3), ["-f", invocation.profilePath, "/runtime/bin/codex"]);
    assert.deepEqual(invocation.codexArgs.slice(0, 7), ["exec", "--sandbox", "read-only", "-C", resolve(scratchDir), "--ignore-user-config", "--ignore-rules"]);
    assert.deepEqual(invocation.codexArgs.slice(7, 11), ["--disable", "plugins", "--disable", "skill_search"]);
    assert.ok(invocation.codexArgs.includes("--ephemeral"));
    assert.ok(invocation.codexArgs.includes("tools.web_search=false"));
    assert.ok(invocation.codexArgs.includes("mcp_servers={}"));
    assert.equal(invocation.codexArgs[invocation.codexArgs.indexOf("-i") + 1], resolve(image));
    for (const leaked of ["-p", "--profile", "--approve-for-me", "--add-dir", "--dangerously-bypass-approvals-and-sandbox"]) {
      assert.equal(invocation.codexArgs.includes(leaked), false, `judge argv must not inherit ${leaked}`);
    }
    assert.deepEqual(Object.keys(invocation.env).sort(), ["CODEX_HOME", "HOME", "LANG", "PATH", "TMPDIR"]);
    assert.equal(invocation.env.HOME, resolve(scratchDir));
    assert.equal(invocation.env.CODEX_HOME, join(resolve(scratchDir), "codex-home"));
    assert.notEqual(invocation.env.CODEX_HOME, sourceCodexHome, "the real CODEX_HOME must never reach the judge");
    assert.deepEqual(readdirSync(invocation.env.CODEX_HOME), ["auth.json"], "the isolated home must contain only the copied auth fixture");
    assert.equal(readFileSync(join(invocation.env.CODEX_HOME, "auth.json"), "utf8"), "fake auth fixture\n");
    assert.equal(statSync(join(invocation.env.CODEX_HOME, "auth.json")).mode & 0o777, 0o600);
    assert.equal(invocation.env.TMPDIR, resolve(scratchDir));
    assert.equal(invocation.env.LANG, "en_US.UTF-8");
    assert.match(invocation.env.PATH, /^\/runtime\/bin:/);
    assert.equal(invocation.env.PATH.includes("/host/bin"), false, "the inherited PATH must be trimmed");
    const profile = readFileSync(invocation.profilePath, "utf8");
    assert.match(profile, /^\(version 1\)\n\(deny default\)/);
    assert.ok(profile.includes(`(allow file-read* (subpath ${JSON.stringify(resolve(image))}))`));
    assert.ok(profile.includes(`(allow file-read* (subpath ${JSON.stringify(resolve(scratchDir))}))`));
    assert.ok(profile.includes(`(allow process-exec (subpath ${JSON.stringify("/runtime/bin/codex")}))`));
    assert.equal(profile.includes("(allow process*)"), false, "the profile must not leave arbitrary shell execution available");
    assert.equal(profile.includes("/host/home"), false, "the real HOME must never be readable by the judge");
    assert.equal(profile.includes(sourceCodexHome), false, "the real CODEX_HOME must never be readable by the judge");

    let received;
    const result = codexEngineAdapter({ images: [image], prompt: "fixture prompt" }, {
      environment: parentEnvironment,
      platform: "darwin",
      codexPath: "/runtime/bin/codex",
      spawn(command, args, options) {
        received = { command, args, options };
        return { status: 0, stdout: "fixture result", stderr: "" };
      },
    });
    assert.equal(result, "fixture result");
    assert.equal(received.command, "/usr/bin/sandbox-exec");
    assert.equal(received.options.env.FAKE_SENSITIVE_VAR_A, undefined);
    assert.equal(received.options.env.FAKE_SENSITIVE_VAR_C, undefined);
    assert.equal(received.options.env.FAKE_SENSITIVE_VAR_B, undefined);
    assert.equal(received.options.env.HOME, received.options.cwd);
    assert.equal(received.options.env.TMPDIR, received.options.cwd);

    assert.throws(
      () => buildCodexEngineInvocation({
        images: [image],
        scratchDir,
        environment: { ...parentEnvironment, AUTOREVIEW_UI_ALLOW_UNCONFINED_JUDGE: undefined },
        platform: "linux",
        codexPath: "/runtime/bin/codex",
      }),
      (error) => error instanceof JudgeExecutorError && /AUTOREVIEW_UI_ALLOW_UNCONFINED_JUDGE=1/.test(error.message),
      "non-macOS must refuse before an engine process can start",
    );
    const unconfined = buildCodexEngineInvocation({
      images: [image],
      scratchDir,
      environment: { ...parentEnvironment, AUTOREVIEW_UI_ALLOW_UNCONFINED_JUDGE: "1" },
      platform: "linux",
      codexPath: "/runtime/bin/codex",
    });
    assert.equal(unconfined.command, "/runtime/bin/codex");
    assert.equal(unconfined.env.FAKE_SENSITIVE_VAR_A, undefined);
    assert.equal(unconfined.env.AUTOREVIEW_UI_ALLOW_UNCONFINED_JUDGE, undefined, "the dangerous override must not reach Codex");
    assert.match(unconfined.warning, /explicit AUTOREVIEW_UI_ALLOW_UNCONFINED_JUDGE=1 override/);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
    rmSync(sourceCodexHome, { recursive: true, force: true });
  }
});

test("Codex CLI opt-in refusal degrades to needs-agent without recording events", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  let spawned = false;
  await assert.rejects(
    () => runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine: ({ images, prompt }) => codexEngineAdapter({ images, prompt }, {
        environment: { PATH: "/runtime/bin:/usr/bin", HOME: "/host/home", CODEX_HOME: "/host/codex", FAKE_SENSITIVE_VAR_A: "hidden" },
        platform: "linux",
        codexPath: "/runtime/bin/codex",
        spawn() {
          spawned = true;
          return { status: 0, stdout: JSON.stringify({ findings: [] }), stderr: "" };
        },
      }),
    }),
    (error) => error instanceof JudgeExecutorError && /disabled by default|explicit.*opt-in/.test(error.message),
  );
  assert.equal(spawned, false);
  const updated = readJson(pack.path);
  const outcome = updated.artifacts.find((path) => path.endsWith("executor-outcome.json"));
  assert.equal(readJson(join(subject.runDir, outcome)).outcome, "needs-agent");
  assert.equal(readJson(join(subject.runDir, outcome)).phase, "engine");
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
});

test("API wire schemas recursively contain only documented strict Structured Outputs keywords", () => {
  const api = {
    model: "gpt-5.6",
    apiKey: "FAKE-CRED-A",
    url: "https://api.openai.invalid/v1/responses",
    maxFindingsPerBatch: 3,
  };
  for (const phase of ["initial", "verification"]) {
    const request = buildApiEngineRequest({ images: [], prompt: "fixture prompt", phase }, { api });
    const schema = JSON.parse(request.body).text.format.schema;
    assertOnlyOpenAiStrictWireKeywords(schema);
    assert.equal(JSON.stringify(schema).includes("minLength"), false);
    assert.equal(JSON.stringify(schema).includes("uniqueItems"), false);
    assert.equal(JSON.stringify(schema).includes("allOf"), false);
  }
});

test("default API adapter keeps credentials out of body/process fields and seals through a fake transport without scratch auth", async () => {
  const subject = fixture({ count: 6 });
  subject.cfg.judge = {
    provider: "openai",
    model: "gpt-5.6",
    apiKeyEnv: "FAKE_SENSITIVE_VAR_JUDGE_API_KEY",
    maxRetries: 0,
    maxFindingsPerBatch: 3,
    maxFindingsPerRun: 9,
  };
  writeFileSync(subject.configPath, JSON.stringify(subject.cfg, null, 2));
  const pack = buildPack(subject);
  const sourceCodexHome = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-unused-codex-home-"));
  writeFileSync(join(sourceCodexHome, "auth.json"), JSON.stringify({ fixtureMaterial: "FAKE-CRED-U" }), { mode: 0o600 });
  const environment = {
    CODEX_HOME: sourceCodexHome,
    FAKE_SENSITIVE_VAR_JUDGE_API_KEY: "FAKE-CRED-A",
    FAKE_SENSITIVE_VAR_PARENT_ONLY: "must-not-enter-the-request",
  };
  const stateBefore = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  const requests = [];
  try {
    const result = await runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      environment,
      transport(request, { call }) {
        requests.push(request);
        assert.equal(request.args, undefined);
        assert.equal(request.argv, undefined);
        assert.equal(request.env, undefined);
        assert.equal(request.cwd, undefined);
        assert.equal(request.headers.authorization, "Bearer FAKE-CRED-A");
        assert.equal(request.body.includes("FAKE-CRED-A"), false);
        assert.equal(request.body.includes("must-not-enter-the-request"), false);
        const body = JSON.parse(request.body);
        assert.equal(body.tools, undefined, "the direct API judge must expose no callable tools");
        assert.equal(body.text.format.type, "json_schema");
        assert.equal(body.text.format.strict, true);
        assert.equal(body.text.format.schema.properties.findings.maxItems, 3, "the configured batch cap must bind the API response schema");
        assert.equal(body.input[0].content.filter((item) => item.type === "input_image").length, call.images.length);
        const promptText = body.input[0].content.find((item) => item.type === "input_text").text;
        assert.equal(promptText, call.prompt);
        assert.equal(HASH(Buffer.from(promptText, "utf8")), call.promptDigest, "the digest must describe the exact bytes sent to the fake transport");
        assert.equal(call.promptDigest, call.batch.promptDigest);
        const response = initialEngineResponse(call);
        return {
          status: 200,
          ok: true,
          body: JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: response }] }] }),
        };
      },
    });
    assert.equal(result.outcome, "recorded");
  } finally {
    if (stateBefore === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = stateBefore;
  }
  assert.equal(requests.length, pack.pack.batches.length);
  assert.deepEqual(readdirSync(sourceCodexHome), ["auth.json"], "the API path must not create an isolated scratch CODEX_HOME");
  assert.equal(existsSync(join(subject.runDir, "codex-home", "auth.json")), false);
});

test("missing API key without CLI opt-in refuses with both actionable options", async () => {
  const subject = fixture({ count: 6 });
  subject.cfg.judge = { apiKeyEnv: "FAKE_SENSITIVE_VAR_JUDGE_API_KEY", maxRetries: 0 };
  writeFileSync(subject.configPath, JSON.stringify(subject.cfg, null, 2));
  const pack = buildPack(subject);
  await assert.rejects(
    () => runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      environment: { FAKE_SENSITIVE_VAR_UNRELATED: "not-a-key" },
    }),
    (error) => error instanceof JudgeExecutorError &&
      /AUTOREVIEW_UI_JUDGE_API_KEY/.test(error.message) &&
      /--engine codex/.test(error.message) &&
      /AUTOREVIEW_UI_ALLOW_UNCONFINED_JUDGE=1/.test(error.message),
  );
  const updated = readJson(pack.path);
  const outcome = updated.artifacts.find((path) => path.endsWith("executor-outcome.json"));
  assert.equal(readJson(join(subject.runDir, outcome)).outcome, "needs-agent");
});

test("opted-in Codex sandbox rejects and does not persist schema-valid output containing copied credential material", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const sourceCodexHome = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-scan-codex-home-"));
  const planted = "FAKE_CREDENTIAL_MATERIAL_PLANTED_IN_EVIDENCE";
  writeFileSync(join(sourceCodexHome, "auth.json"), JSON.stringify({ fixtureMaterial: planted }), { mode: 0o600 });
  let invocation;
  await assert.rejects(
    () => runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      environment: {
        PATH: "/usr/bin",
        HOME: subject.root,
        CODEX_HOME: sourceCodexHome,
        AUTOREVIEW_UI_ALLOW_UNCONFINED_JUDGE: "1",
      },
      engine(call, options) {
        const response = JSON.parse(initialEngineResponse(call));
        response.coverage[0].result = "not-judged";
        response.findings.push(validEngineFinding({
          id: "12121212-1212-4212-8212-121212121212",
          targetId: response.coverage[0].targetId,
          assetId: readJson(join(subject.runDir, call.batch.imageList)).images.find((image) => !image.referenceOnly).assetId,
        }));
        response.findings[0].ruleId = `${response.coverage[0].phase}/credential-echo`;
        response.findings[0].evidence = planted;
        response.findings[0].verifierVerdict = "not-judged";
        response.findings[0].disposition = "not-judged";
        response.coverage[0].result = "findings";
        return codexEngineAdapter(call, {
          environment: options.environment,
          platform: "darwin",
          codexPath: "/runtime/bin/codex",
          spawn(command, args, spawnOptions) {
            invocation = { command, args, spawnOptions };
            return { status: 0, stdout: JSON.stringify(response), stderr: "" };
          },
        });
      },
    }),
    (error) => error instanceof JudgeExecutorError && /batch batch-01/.test(error.message) && /auth\.json/.test(error.message) && !error.message.includes(planted),
  );
  assert.equal(invocation.command, "/usr/bin/sandbox-exec");
  assert.equal(existsSync(invocation.spawnOptions.env.CODEX_HOME), false, "CLI scratch, including copied auth.json, must be removed after scanning");
  const updated = readJson(pack.path);
  const outcome = updated.artifacts.find((path) => path.endsWith("executor-outcome.json"));
  const evidence = readJson(join(subject.runDir, outcome));
  assert.equal(evidence.outcome, "needs-agent");
  assert.equal(evidence.reason.includes(planted), false);
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
});

test("API transport exhausts configured retries into needs-agent without a review record", async () => {
  const subject = fixture({ count: 6 });
  subject.cfg.judge = { apiKeyEnv: "FAKE_SENSITIVE_VAR_JUDGE_API_KEY", maxRetries: 2 };
  writeFileSync(subject.configPath, JSON.stringify(subject.cfg, null, 2));
  const pack = buildPack(subject);
  let calls = 0;
  await assert.rejects(
    () => runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      environment: { FAKE_SENSITIVE_VAR_JUDGE_API_KEY: "FAKE-CRED-R" },
      transport() {
        calls += 1;
        return { status: 503, ok: false, body: "fixture unavailable" };
      },
    }),
    (error) => error instanceof JudgeExecutorError && /HTTP 503/.test(error.message),
  );
  assert.equal(calls, 3);
  const outcome = readJson(pack.path).artifacts.find((path) => path.endsWith("executor-outcome.json"));
  assert.equal(readJson(join(subject.runDir, outcome)).outcome, "needs-agent");
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
});

test("ui-judge rejects a batch above the default findings cap before creating crops or review events", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const warnings = [];
  const originalError = console.error;
  console.error = (message) => warnings.push(String(message));
  try {
    await assert.rejects(
      () => runJudge({
        packPath: pack.path,
        configPath: subject.configPath,
        engine(call) {
          const image = readJson(join(subject.runDir, call.batch.imageList)).images.find((entry) => !entry.referenceOnly);
          const response = JSON.parse(initialEngineResponse(call, modelFindings(12, image)));
          response.findings.push(validEngineFinding({ id: randomUUID(), targetId: image.targetId, assetId: image.assetId }));
          return JSON.stringify(response);
        },
      }),
      (error) => error instanceof JudgeExecutorError &&
        /returned 13 findings/.test(error.message) &&
        /maxFindingsPerBatch=12/.test(error.message) &&
        /contract/.test(error.message),
    );
  } finally {
    console.error = originalError;
  }
  assert.ok(warnings.some((warning) => /WARNING: batch .* returned 13 findings/.test(warning)));
  assert.equal(verificationCrops(subject).length, 0);
  assert.equal(regularFilesUnder(subject.runDir).some((path) => path.endsWith("record-events.json")), false);
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
  const outcome = readJson(pack.path).artifacts.find((path) => path.endsWith("executor-outcome.json"));
  assert.equal(readJson(join(subject.runDir, outcome)).outcome, "needs-agent");
});

test("ui-judge processes a batch exactly at the default 12-finding cap", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  let emitted = false;
  let verificationCalls = 0;
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  try {
    const result = await runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine(call) {
        if (call.phase === "verification") {
          verificationCalls += 1;
          return JSON.stringify({ verifierVerdict: "confirmed", evidence: "The fake crop confirms this capped fixture finding." });
        }
        if (emitted) return initialEngineResponse(call);
        emitted = true;
        const image = readJson(join(subject.runDir, call.batch.imageList)).images.find((entry) => !entry.referenceOnly);
        return initialEngineResponse(call, modelFindings(12, image));
      },
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(result.outcome, "recorded");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  assert.equal(verificationCalls, 12);
  assert.equal(verificationCrops(subject).length, 12);
  const events = readFileSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json"), "utf8")
    .trim().split("\n").map(JSON.parse);
  assert.equal(events.find((event) => event.kind === "seal").findingCount, 12);
});

test("judge.maxImagesPerBatch bounds screen images per batch and pads only up to that bound", () => {
  const subject = fixture({ count: 6 });
  subject.cfg.judge = { maxImagesPerBatch: 4 };
  writeFileSync(subject.configPath, JSON.stringify(subject.cfg, null, 2));
  const pack = buildPack(subject).pack;
  for (const batch of pack.batches) {
    const images = readJson(join(subject.runDir, batch.imageList)).images;
    assert.ok(images.length <= 4, `batch ${batch.id} exceeds the configured image bound (${images.length})`);
  }
  const allTargets = new Set(pack.batches.flatMap((batch) => batch.targetIds));
  for (const targetId of subject.ids) assert.ok(allTargets.has(targetId), `target ${targetId} lost coverage`);
  assert.ok(pack.batches.length >= 2, "six screens under a bound of four must split into at least two batches");
});

test("judge.maxImagesPerBatch outside 2..8 is rejected at pack build", () => {
  const subject = fixture({ count: 3 });
  subject.cfg.judge = { maxImagesPerBatch: 1 };
  writeFileSync(subject.configPath, JSON.stringify(subject.cfg, null, 2));
  assert.throws(() => buildPack(subject), /maxImagesPerBatch/);
});

test("ui-judge respects a lower configured per-batch findings cap", async () => {
  const subject = fixture({ count: 6 });
  subject.cfg.judge = { maxFindingsPerBatch: 1, maxFindingsPerRun: 48 };
  writeFileSync(subject.configPath, JSON.stringify(subject.cfg, null, 2));
  const pack = buildPack(subject);
  const warnings = [];
  const originalError = console.error;
  console.error = (message) => warnings.push(String(message));
  try {
    await assert.rejects(
      () => runJudge({
        packPath: pack.path,
        configPath: subject.configPath,
        engine(call) {
          const image = readJson(join(subject.runDir, call.batch.imageList)).images.find((entry) => !entry.referenceOnly);
          return initialEngineResponse(call, modelFindings(2, image));
        },
      }),
      (error) => error instanceof JudgeExecutorError && /returned 2 findings/.test(error.message) && /maxFindingsPerBatch=1/.test(error.message),
    );
  } finally {
    console.error = originalError;
  }
  assert.ok(warnings.some((warning) => /returned 2 findings/.test(warning)));
  assert.equal(verificationCrops(subject).length, 0);
});

test("ui-judge exhausts the run findings budget gracefully: judged batches record, later targets seal not-judged and re-select", async () => {
  const subject = fixture({ count: 12 });
  subject.cfg.judge = { maxFindingsPerBatch: 2, maxFindingsPerRun: 3 };
  writeFileSync(subject.configPath, JSON.stringify(subject.cfg, null, 2));
  const pack = buildPack(subject);
  assert.ok(pack.pack.batches.length >= 3, "the fixture must have at least one batch after the budget trips");
  let initialCalls = 0;
  const warnings = [];
  const originalError = console.error;
  console.error = (message) => warnings.push(String(message));
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  try {
    const result = await runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine(call) {
        if (call.phase === "verification") {
          return JSON.stringify({ verifierVerdict: "confirmed", evidence: "The fake verification crop confirms the finding." });
        }
        initialCalls += 1;
        const image = readJson(join(subject.runDir, call.batch.imageList)).images.find((entry) => !entry.referenceOnly);
        return initialEngineResponse(call, modelFindings(2, image));
      },
    });
    assert.equal(result.outcome, "recorded", "crossing the run budget must record the judged work, not void the run");
  } finally {
    console.error = originalError;
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  // Batch two trips the budget (2 + 2 > 3); batch three must never reach the engine.
  assert.equal(initialCalls, 2);
  assert.ok(warnings.some((warning) => /past judge.maxFindingsPerRun=3/.test(warning) && /sealing the remaining targets as not-judged/.test(warning)));
  // Only batch one's two accepted findings are verified; the tripping batch's findings are discarded.
  assert.equal(verificationCrops(subject).length, 2);
  const events = readFileSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json"), "utf8")
    .trim().split("\n").map(JSON.parse);
  const dispositions = events.filter((event) => event.kind === "disposition").map((event) => event.finding);
  assert.equal(dispositions.filter((finding) => finding.disposition === "accepted").length, 2);
  const notJudged = dispositions.filter((finding) => finding.disposition === "not-judged");
  assert.deepEqual(notJudged.map((finding) => finding.targetId).sort(), subject.ids.slice(3).sort());
  for (const finding of notJudged) {
    assert.match(finding.evidence, /judge\.maxFindingsPerRun=3 was exhausted at batch-02/);
  }
  assert.equal(events.find((event) => event.kind === "seal").findingCount, 11);
  // Sealed not-judged targets carry unresolved evidence: the next pack build
  // re-selects exactly them, so a follow-up run finishes under a fresh budget.
  const rebuilt = buildPack(subject).pack;
  assert.deepEqual(rebuilt.targets, subject.ids.slice(3));
});

test("judge pack reuses a retained exact-match anchor as reference-only with its run provenance", () => {
  const subject = fixture({ count: 3 });
  limitCaptureTo(subject, ["peer"]);
  const retained = retainAnchorLatest(subject);
  const pack = buildPack(subject).pack;
  assert.deepEqual(pack.targets, ["peer"]);
  const images = readJson(join(subject.runDir, pack.batches[0].imageList)).images;
  assert.equal(images[0].targetId, "anchor");
  assert.equal(images[0].referenceOnly, true);
  assert.deepEqual(images[0].librarySource, {
    view: "runs",
    runId: retained.runId,
    identity: retained.identity,
    assetPath: `runs/${retained.runId}/${retained.assetPath}`,
    sha256: HASH(retained.bytes),
  });
  assert.match(images[0].image, /^judge\/builds\//);
});

test("completed-run loading rejects a manifest-only anchor before retained fallback", () => {
  const subject = fixture({ count: 3 });
  const manifestPath = join(subject.runDir, "shots", "manifest.json");
  const manifestOnlyAnchor = structuredClone(readJson(manifestPath).targets.find((target) => target.id === "anchor"));
  limitCaptureTo(subject, ["peer"]);
  const retained = retainAnchorLatest(subject);
  const narrowedManifest = readJson(manifestPath);
  narrowedManifest.targets.push(manifestOnlyAnchor);
  writeFileSync(manifestPath, JSON.stringify(narrowedManifest, null, 2));

  assert.throws(
    () => buildPack(subject),
    (error) => /capture manifest targets do not exactly match resolved targets/.test(error.message) && /extra targets: anchor/.test(error.message),
  );

  narrowedManifest.targets = narrowedManifest.targets.filter((target) => target.id !== "anchor");
  writeFileSync(manifestPath, JSON.stringify(narrowedManifest, null, 2));
  const pack = buildPack(subject).pack;
  const images = readJson(join(subject.runDir, pack.batches[0].imageList)).images;
  assert.equal(images[0].referenceOnly, true);
  assert.equal(images[0].librarySource.runId, retained.runId);
});

test("judge pack snapshots a retained anchor under the library lease before latest can change", () => {
  const subject = fixture({ count: 3 });
  limitCaptureTo(subject, ["peer"]);
  const retained = retainAnchorLatest(subject);
  const replacement = png(20, 10, 0x24);
  const result = buildPack(subject, {
    afterSourceResolution() {
      writeFileSync(retained.path, replacement);
    },
  }).pack;
  const image = readJson(join(subject.runDir, result.batches[0].imageList)).images[0];
  assert.equal(readFileSync(retained.path).equals(replacement), true, "the simulated later publication must replace latest/");
  assert.equal(image.librarySource.runId, retained.runId);
  assert.equal(image.librarySource.sha256, HASH(retained.bytes));
  assert.equal(image.librarySource.assetPath, `runs/${retained.runId}/${retained.assetPath}`);
  const packed = decodePng(readFileSync(join(subject.runDir, image.image)));
  assert.equal(packed.data[0], 0x77, "the pack must use the pre-swap immutable snapshot, not latest/");
});

test("retained anchor evidence includes every identity and reselects a sibling only when one changes", () => {
  const subject = fixture({ count: 3 });
  limitCaptureTo(subject, ["peer"]);
  const retained = retainAnchorVariants(subject);
  const first = buildPack(subject);
  const sealedPrevious = join(subject.root, "sealed-retained-anchor-pack.json");
  writeFileSync(sealedPrevious, JSON.stringify({
    ...first.pack,
    judgedFingerprints: judgedFingerprints(first.pack),
  }, null, 2));

  const unchanged = buildPack(subject, { previousPackPath: sealedPrevious }).pack;
  assert.deepEqual(unchanged.targets, []);
  assert.deepEqual(unchanged.skippedTargets, [{
    targetId: "peer",
    reason: "fingerprint and judgment evidence match the durable sealed judgment",
  }]);

  const changedBytes = png(22, 11, 0x6f);
  publishRetainedAnchor(subject, retained[1].identity, changedBytes, "alternate-replacement");
  const changed = buildPack(subject, { previousPackPath: sealedPrevious }).pack;
  assert.deepEqual(changed.targets, ["peer"]);
  assert.deepEqual(changed.reselectedTargets, [{ targetId: "peer", reason: "evidence-changed" }]);
  assert.notEqual(
    changed.targetJudgmentEvidence.peer.baseEvidenceDigest,
    first.pack.targetJudgmentEvidence.peer.baseEvidenceDigest,
    "the second retained anchor identity must participate in sibling evidence",
  );
});

test("judge pack names an omitted anchor and capture remedy when no retained latest asset exists", () => {
  const subject = fixture({ count: 3 });
  limitCaptureTo(subject, ["peer"]);
  assert.throws(
    () => buildPack(subject),
    /anchor.*(?:capture anchor|include it in --targets)/i,
  );
});

test("judgment cursor writes retain the prior file until the same-directory atomic rename", () => {
  const subject = fixture({ count: 3 });
  const first = {
    targetId: "peer",
    fingerprint: subject.run.targetFingerprints.peer.fingerprint,
    evidenceDigest: HASH("fixture evidence"),
    rubricDigest: HASH("fixture rubric"),
    runId: subject.run.runId,
    disposition: "clean",
  };
  const initial = sealJudgmentState(subject.cfg, { stateDir: subject.stateDir, targets: [first] });
  const before = readFileSync(initial.path, "utf8");
  assert.throws(
    () => sealJudgmentState(subject.cfg, {
      stateDir: subject.stateDir,
      targets: [{ ...first, disposition: "accepted" }],
      beforeRename({ path, temporary }) {
        assert.equal(path, initial.path);
        assert.match(basename(temporary), /^\.latest\.json\..+\.tmp$/);
        assert.equal(readFileSync(path, "utf8"), before, "the public cursor cannot be truncate-overwritten before rename");
        throw new Error("fixture rename interruption");
      },
    }),
    /fixture rename interruption/,
  );
  assert.equal(readFileSync(initial.path, "utf8"), before);
});

test("malformed judgment cursor reports a clear corrupt-state path", () => {
  const subject = fixture({ count: 3 });
  const path = join(subject.stateDir, subject.cfg.name, "judgments", "latest.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{\"version\":");
  assert.throws(
    () => readJudgmentState(subject.cfg, { stateDir: subject.stateDir }),
    (error) => /judgment state is corrupt/.test(error.message) && error.message.includes(path),
  );
});

test("ui-review --previous-pack validates the override and uses it for delta selection", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-project-"));
  const initial = fixture({ count: 6, root });
  const previous = buildPack(initial);
  const sealed = { ...previous.pack, judgedFingerprints: judgedFingerprints(previous.pack) };
  writeFileSync(previous.path, JSON.stringify(sealed, null, 2));
  const recapture = fixture({ count: 6, root, project: initial.cfg.name });
  recapture.run.targetFingerprints.peer = { fingerprint: `sha256:${"e".repeat(64)}` };
  writeFileSync(join(recapture.runDir, "run.json"), JSON.stringify(recapture.run, null, 2));
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", recapture.configPath, "--judge-pack", "--run", recapture.runDir, "--previous-pack", previous.path, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: recapture.stateDir } },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.judgePack.targets, ["peer"]);
  const wrongProject = { ...sealed, project: "other-project" };
  const wrongProjectPath = join(root, "wrong-project.json");
  writeFileSync(wrongProjectPath, JSON.stringify(wrongProject, null, 2));
  assert.throws(
    () => buildPack(recapture, { previousPackPath: wrongProjectPath }),
    /previous manifest project other-project does not match fixture/,
  );
  const invalid = { ...sealed, version: "invalid" };
  const invalidPath = join(root, "invalid.json");
  writeFileSync(invalidPath, JSON.stringify(invalid, null, 2));
  assert.throws(() => buildPack(recapture, { previousPackPath: invalidPath }), /previous manifest is invalid/);
});

test("legacy raw previous-pack fingerprints are non-suppressing without a disposition", () => {
  const subject = fixture({ count: 3 });
  const previous = buildPack(subject);
  const legacy = { ...previous.pack, judgedFingerprints: { ...previous.pack.targetFingerprints } };
  writeFileSync(previous.path, JSON.stringify(legacy, null, 2));
  const delta = buildPack(subject, { previousPackPath: previous.path });
  assert.deepEqual(delta.pack.targets, subject.ids);
});

test("a same-fingerprint recapture with changed base pixels is reselected for evidence-changed", () => {
  const subject = fixture({ count: 3 });
  const baseline = buildPack(subject);
  sealJudgmentState(subject.cfg, {
    stateDir: subject.stateDir,
    targets: baseline.pack.targets.map((targetId) => ({
      targetId,
      fingerprint: baseline.pack.targetFingerprints[targetId],
      ...baseline.pack.targetJudgmentEvidence[targetId],
      runId: subject.run.runId,
      disposition: "clean",
    })),
  });

  replaceCapturedShot(subject, "peer");
  const delta = buildPack(subject).pack;
  assert.deepEqual(delta.targets, ["peer"]);
  assert.deepEqual(delta.reselectedTargets, [{ targetId: "peer", reason: "evidence-changed" }]);
});

test("changing only an ordinary capture-time crop reselects its target for evidence-changed", () => {
  const subject = fixture({ count: 3 });
  const crop = cropForRecord(subject);
  const cropAsset = relative(join(subject.runDir, "shots"), crop.path).split(sep).join("/");
  const baseline = buildPack(subject);
  sealJudgmentState(subject.cfg, {
    stateDir: subject.stateDir,
    targets: baseline.pack.targets.map((targetId) => ({
      targetId,
      fingerprint: baseline.pack.targetFingerprints[targetId],
      ...baseline.pack.targetJudgmentEvidence[targetId],
      runId: subject.run.runId,
      disposition: "clean",
    })),
  });

  const changedBytes = png(8, 4, 0xd1);
  writeFileSync(crop.path, changedBytes);
  subject.run.targetShotHashes.anchor[cropAsset] = HASH(changedBytes);
  writeFileSync(join(subject.runDir, "run.json"), JSON.stringify(subject.run, null, 2));

  const delta = buildPack(subject).pack;
  assert.ok(delta.targets.includes("anchor"));
  assert.ok(delta.reselectedTargets.some(({ targetId, reason }) => targetId === "anchor" && reason === "evidence-changed"));
});

test("changing only an executor verification crop does not change stable judgment evidence", () => {
  const subject = fixture({ count: 3 });
  const crop = finalizedVerificationCrop(subject);
  const cropAsset = relative(join(subject.runDir, "shots"), crop.path).split(sep).join("/");
  const baseline = buildPack(subject);
  sealJudgmentState(subject.cfg, {
    stateDir: subject.stateDir,
    targets: baseline.pack.targets.map((targetId) => ({
      targetId,
      fingerprint: baseline.pack.targetFingerprints[targetId],
      ...baseline.pack.targetJudgmentEvidence[targetId],
      runId: subject.run.runId,
      disposition: "clean",
    })),
  });

  const changedBytes = png(8, 4, 0xd2);
  writeFileSync(crop.path, changedBytes);
  subject.run.targetShotHashes.anchor[cropAsset] = HASH(changedBytes);
  writeFileSync(join(subject.runDir, "run.json"), JSON.stringify(subject.run, null, 2));

  const delta = buildPack(subject).pack;
  assert.deepEqual(delta.targets, []);
  assert.deepEqual(delta.reselectedTargets, []);
});

test("changing only a comparison anchor's bytes reselects its unchanged siblings for evidence-changed", () => {
  const subject = fixture({ count: 3 });
  const baseline = buildPack(subject);
  sealJudgmentState(subject.cfg, {
    stateDir: subject.stateDir,
    targets: baseline.pack.targets.map((targetId) => ({
      targetId,
      fingerprint: baseline.pack.targetFingerprints[targetId],
      ...baseline.pack.targetJudgmentEvidence[targetId],
      runId: subject.run.runId,
      disposition: "clean",
    })),
  });

  replaceCapturedShot(subject, "anchor");
  const delta = buildPack(subject).pack;
  assert.deepEqual(delta.targets, ["anchor", "peer", "third"]);
  assert.ok(
    delta.reselectedTargets.some(({ targetId, reason }) => targetId === "peer" && reason === "evidence-changed"),
    "the sibling digest must include the resolved anchor bytes",
  );
  assert.ok(
    delta.reselectedTargets.some(({ targetId, reason }) => targetId === "third" && reason === "evidence-changed"),
    "every comparison-group member must bind the anchor",
  );
});

test("changing a non-first comparison anchor asset reselects siblings while unchanged anchor evidence stays skipped", () => {
  const subject = fixture({ count: 3, assetsByTarget: { anchor: 2 } });
  const baseline = buildPack(subject);
  sealJudgmentState(subject.cfg, {
    stateDir: subject.stateDir,
    targets: baseline.pack.targets.map((targetId) => ({
      targetId,
      fingerprint: baseline.pack.targetFingerprints[targetId],
      ...baseline.pack.targetJudgmentEvidence[targetId],
      runId: subject.run.runId,
      disposition: "clean",
    })),
  });

  const unchanged = buildPack(subject).pack;
  assert.deepEqual(unchanged.targets, []);
  assert.deepEqual(unchanged.reselectedTargets, []);

  const nonFirstAsset = Object.keys(subject.run.targetShotHashes.anchor).sort()[1];
  const changedBytes = png(43, 25, 0xa4);
  writeFileSync(join(subject.runDir, "shots", nonFirstAsset), changedBytes);
  subject.run.targetShotHashes.anchor[nonFirstAsset] = HASH(changedBytes);
  writeFileSync(join(subject.runDir, "run.json"), JSON.stringify(subject.run, null, 2));

  const changed = buildPack(subject).pack;
  assert.deepEqual(changed.targets, ["anchor", "peer", "third"]);
  for (const targetId of ["peer", "third"]) {
    assert.ok(
      changed.reselectedTargets.some((target) => target.targetId === targetId && target.reason === "evidence-changed"),
      `${targetId} must bind every sorted anchor asset, not only the first`,
    );
  }
});

test("a changed canonical checklist template reselects same-fingerprint targets for rubric-changed", () => {
  const subject = fixture({ count: 3 });
  const baseline = buildPack(subject);
  const prior = { ...baseline.pack, judgedFingerprints: judgedFingerprints(baseline.pack) };
  writeFileSync(baseline.path, JSON.stringify(prior, null, 2));
  const templatePath = join(__dirname, "..", "reference", "judge-checklist.md");
  const template = readFileSync(templatePath, "utf8");
  try {
    writeFileSync(templatePath, `${template}\n<!-- fake rubric regression -->\n`);
    const delta = buildPack(subject, { previousPackPath: baseline.path }).pack;
    assert.deepEqual(delta.targets, subject.ids);
    assert.deepEqual(delta.reselectedTargets, subject.ids.map((targetId) => ({ targetId, reason: "rubric-changed" })));
    for (const targetId of subject.ids) {
      assert.notEqual(delta.targetJudgmentEvidence[targetId].evidenceDigest, baseline.pack.targetJudgmentEvidence[targetId].evidenceDigest);
    }
  } finally {
    writeFileSync(templatePath, template);
  }
});

test("a changed verification template reselects same-fingerprint targets for rubric-changed", () => {
  const subject = fixture({ count: 3 });
  const baseline = buildPack(subject);
  const prior = { ...baseline.pack, judgedFingerprints: judgedFingerprints(baseline.pack) };
  writeFileSync(baseline.path, JSON.stringify(prior, null, 2));
  const templatePath = join(__dirname, "..", "reference", "judge-verification.md");
  const template = readFileSync(templatePath, "utf8");
  try {
    writeFileSync(templatePath, `${template}\n<!-- fake verification-rubric regression -->\n`);
    const delta = buildPack(subject, { previousPackPath: baseline.path }).pack;
    assert.deepEqual(delta.targets, subject.ids);
    assert.deepEqual(delta.reselectedTargets, subject.ids.map((targetId) => ({ targetId, reason: "rubric-changed" })));
  } finally {
    writeFileSync(templatePath, template);
  }
});

test("unchanged anchor and sibling evidence still skip every completed target", () => {
  const subject = fixture({ count: 3 });
  const baseline = buildPack(subject);
  const prior = { ...baseline.pack, judgedFingerprints: judgedFingerprints(baseline.pack) };
  writeFileSync(baseline.path, JSON.stringify(prior, null, 2));

  const delta = buildPack(subject, { previousPackPath: baseline.path }).pack;
  assert.deepEqual(delta.targets, []);
  assert.deepEqual(delta.reselectedTargets, []);
  assert.deepEqual(delta.skippedTargets.map(({ targetId }) => targetId), subject.ids);
  // Skipped targets are exactly the judgments a pack relies on, so all of
  // them — and only them — ride along in judgedFingerprints.
  assert.deepEqual(Object.keys(delta.judgedFingerprints).sort(), [...subject.ids].sort());
});

test("a rebuilt pack carries judgedFingerprints only for skipped targets, never for reselected ones", () => {
  // Live regression (2026-08-12): a pack that copied sealed judgments for
  // targets it reselected made the runner's consistency check read the pack
  // as corrupt ("fingerprints or judgment evidence changed") and demand a
  // rebuild that reproduced the identical pack — an unbreakable loop.
  const subject = fixture({ count: 3 });
  const baseline = buildPack(subject);
  const prior = { ...baseline.pack, judgedFingerprints: judgedFingerprints(baseline.pack) };
  writeFileSync(baseline.path, JSON.stringify(prior, null, 2));
  const templatePath = join(__dirname, "..", "reference", "judge-checklist.md");
  const template = readFileSync(templatePath, "utf8");
  try {
    writeFileSync(templatePath, `${template}\n<!-- fake rubric regression for judgedFingerprints carry rule -->\n`);
    const delta = buildPack(subject, { previousPackPath: baseline.path }).pack;
    assert.deepEqual(delta.reselectedTargets.map(({ targetId }) => targetId), subject.ids);
    assert.deepEqual(delta.judgedFingerprints, {}, "reselected targets must not carry their stale sealed judgments");
  } finally {
    writeFileSync(templatePath, template);
  }
});

test("digest-less durable judgments reselect once and then carry judgment evidence", () => {
  const subject = fixture({ count: 3 });
  const statePath = join(subject.stateDir, subject.cfg.name, "judgments", "latest.json");
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({
    version: "judgment-state.v1",
    project: subject.cfg.name,
    sequence: 1,
    targets: Object.fromEntries(subject.ids.map((targetId) => [targetId, {
      fingerprint: subject.run.targetFingerprints[targetId].fingerprint,
      runId: subject.run.runId,
      judgedAt: 1,
      disposition: "clean",
    }])),
  }, null, 2));

  const first = buildPack(subject).pack;
  assert.deepEqual(first.targets, subject.ids);
  sealJudgmentState(subject.cfg, {
    stateDir: subject.stateDir,
    targets: first.targets.map((targetId) => ({
      targetId,
      fingerprint: first.targetFingerprints[targetId],
      ...first.targetJudgmentEvidence[targetId],
      runId: subject.run.runId,
      disposition: "clean",
    })),
  });
  const second = buildPack(subject).pack;
  assert.deepEqual(second.targets, []);
  assert.ok(Object.values(readJudgmentState(subject.cfg, { stateDir: subject.stateDir }).targets).every((target) => target.evidenceDigest));
});

test("a reference-heavy unchanged anchor leaves every split batch with a selected target", () => {
  const subject = fixture({ count: 3, assetsByTarget: { anchor: 9 } });
  const baseline = buildPack(subject);
  const prior = {
    ...baseline.pack,
    judgedFingerprints: {
      anchor: { fingerprint: baseline.pack.targetFingerprints.anchor, ...baseline.pack.targetJudgmentEvidence.anchor, disposition: "clean" },
      third: { fingerprint: baseline.pack.targetFingerprints.third, ...baseline.pack.targetJudgmentEvidence.third, disposition: "clean" },
    },
  };
  writeFileSync(baseline.path, JSON.stringify(prior, null, 2));

  const delta = buildPack(subject, { previousPackPath: baseline.path });
  assert.equal(validateJudgePack(delta.pack).valid, true);
  assert.deepEqual(delta.pack.targets, ["peer"]);
  assert.ok(delta.pack.batches.length >= 1);
  for (const batch of delta.pack.batches) {
    assert.deepEqual(batch.targetIds, ["peer"], "a batch must never contain only reference images");
    const list = readJson(join(subject.runDir, batch.imageList));
    assert.deepEqual(list.targetIds, ["peer"]);
    assert.equal(list.images[0].targetId, "anchor");
    assert.equal(list.images[0].referenceOnly, true);
    assert.equal(
      list.images.filter((image) => image.targetId === "anchor" && !image.repeatedForContext).length,
      1,
      "only the designated anchor image may be used as unchanged reference context",
    );
  }
});

test("sealed durable judgment state re-judges only a changed target after recapture and reuses the library lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-project-"));
  const first = fixture({ count: 6, root });
  const second = fixture({ count: 6, root, project: first.cfg.name });
  second.stateDir = first.stateDir;
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = first.stateDir;
  try {
    const firstPack = buildPack(first);
    const result = await runJudge({
      packPath: firstPack.path,
      configPath: first.configPath,
      engine: (call) => initialEngineResponse(call),
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(result.outcome, "recorded");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  const statePath = join(first.stateDir, "fixture", "judgments", "latest.json");
  const state = readJson(statePath);
  assert.equal(validateJudgmentState(state).valid, true);
  assert.equal(state.sequence, 1);
  assert.deepEqual(Object.keys(state.targets).sort(), first.ids.slice().sort());
  assert.ok(Object.values(state.targets).every((target) => target.judgedAt === 1 && target.disposition === "clean"));
  second.run.targetFingerprints.peer = { fingerprint: `sha256:${"f".repeat(64)}` };
  writeFileSync(join(second.runDir, "run.json"), JSON.stringify(second.run, null, 2));
  const delta = buildPack(second);
  assert.deepEqual(delta.pack.targets, ["peer"]);
  assert.deepEqual(delta.pack.skippedTargets.map((target) => target.targetId).sort(), second.ids.filter((id) => id !== "peer").sort());
  assert.match(delta.pack.skippedTargets[0].reason, /durable sealed judgment/);
  const list = readJson(join(second.runDir, delta.pack.batches[0].imageList));
  assert.equal(list.images[0].targetId, "anchor", "a changed sibling is re-anchored without re-judging its anchor");
  assert.equal(existsSync(join(first.stateDir, "fixture", "judgments", "latest.json.lock")), false);
  assert.equal(existsSync(join(first.stateDir, ".library.lock")), false);
  assert.equal(existsSync(join(first.stateDir, "fixture", ".library.lock")), false, "judgment state must reuse the project library lock rather than add another lock file");
});

test("manual record reuses its library lease for a retained comparison anchor and advances the cursor", () => {
  const subject = fixture({ count: 3 });
  limitCaptureTo(subject, ["peer"]);
  retainAnchorLatest(subject);
  const events = [
    { ...recordHeaderFor(subject), targets: subject.run.targetIds, targetShotHashes: subject.run.targetShotHashes },
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", findingCount: 0, findingIds: [] },
  ];
  const eventsPath = join(subject.root, "manual-retained-anchor.json");
  writeFileSync(eventsPath, JSON.stringify(events, null, 2));
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--record", eventsPath, "--run", subject.runDir, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).review.complete, true);
  const state = readJson(join(subject.stateDir, subject.cfg.name, "judgments", "latest.json"));
  assert.equal(state.sequence, 1);
  assert.equal(state.targets.peer.runId, subject.run.runId);
  assert.equal(state.targets.peer.disposition, "clean");
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, ".library.lock")), false);
});

test("manual record preflights anchor evidence before sealing and permits a corrected retry", () => {
  const subject = fixture({ count: 3 });
  limitCaptureTo(subject, ["peer"]);
  const crop = cropForRecord(subject);
  const events = cropBackedRecordEvents(subject, crop);
  events[0] = { ...events[0], targets: subject.run.targetIds, targetShotHashes: subject.run.targetShotHashes };
  const eventsPath = join(subject.root, "manual-anchorless.json");
  writeFileSync(eventsPath, JSON.stringify(events, null, 2));
  const env = { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir };
  const durableRun = join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId);
  const reviewPath = join(durableRun, "review.json");
  const cropRoot = join(durableRun, "review-crops");
  const cropJournal = join(subject.stateDir, subject.cfg.name, "review-crops.journal.json");
  const cursorPath = join(subject.stateDir, subject.cfg.name, "judgments", "latest.json");

  const failed = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--record", eventsPath, "--run", subject.runDir, "--json"],
    { encoding: "utf8", env },
  );
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /review group siblings needs anchor anchor/);
  assert.equal(existsSync(reviewPath), false, "evidence failure must happen before the review log commit");
  assert.equal(existsSync(cropRoot), false, "evidence failure must happen before crop staging or publication");
  assert.equal(existsSync(cropJournal), false, "evidence failure must not leave a crop publication journal");
  assert.equal(
    existsSync(durableRun) && readdirSync(durableRun).some((entry) => entry.startsWith(".review-crops-staging-")),
    false,
    "evidence failure must not leave private crop staging",
  );
  assert.equal(existsSync(cursorPath), false, "evidence failure must not advance the judgment cursor");

  retainAnchorLatest(subject);
  const retried = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--record", eventsPath, "--run", subject.runDir, "--json"],
    { encoding: "utf8", env },
  );
  assert.equal(retried.status, 0, retried.stderr || retried.stdout);
  assert.equal(JSON.parse(retried.stdout).review.complete, true);
  assert.equal(existsSync(reviewPath), true);
  assert.equal(regularFilesUnder(cropRoot).length, 1, "the corrected retry must publish the sealed crop once");
  assert.equal(readJson(cursorPath).targets.peer.runId, subject.run.runId);
});

test("not-judged targets are reselected from durable state and a sealed --previous-pack", () => {
  const initial = fixture({ count: 3 });
  limitCaptureTo(initial, ["anchor", "peer"]);
  const initialPack = buildPack(initial);
  const images = readJson(join(initial.runDir, initialPack.pack.batches[0].imageList)).images;
  const peer = images.find((image) => image.targetId === "peer");
  const accepted = { ...validEngineFinding({ id: "55555555-5555-4555-8555-555555555555", targetId: peer.targetId, assetId: peer.assetId }), verifierVerdict: "confirmed", disposition: "accepted" };
  const notJudged = validEngineFinding({ id: "66666666-6666-4666-8666-666666666666", targetId: peer.targetId, assetId: peer.assetId });
  const asInitial = ({ verifierVerdict, disposition, ...finding }) => finding;
  const events = [
    { ...recordHeaderFor(initial), targets: initial.run.targetIds, targetShotHashes: initial.run.targetShotHashes },
    { kind: "initial", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", finding: asInitial(accepted) },
    { kind: "initial", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:02.000Z", finding: asInitial(notJudged) },
    { kind: "verification", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:03.000Z", findingId: accepted.id, verifierVerdict: "confirmed", evidence: "The crop confirms the visible issue." },
    { kind: "verification", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:04.000Z", findingId: notJudged.id, verifierVerdict: "not-judged", evidence: "The crop does not establish a verdict." },
    { kind: "disposition", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:05.000Z", finding: accepted },
    { kind: "disposition", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:06.000Z", finding: notJudged },
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:07.000Z", findingCount: 2, findingIds: [accepted.id, notJudged.id] },
  ];
  const eventsPath = join(initial.root, "not-judged-events.json");
  writeFileSync(eventsPath, JSON.stringify(events, null, 2));
  const recorded = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", initial.configPath, "--record", eventsPath, "--run", initial.runDir, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: initial.stateDir } },
  );
  assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout);
  assert.deepEqual(readJson(initialPack.path).judgedFingerprints, {
    anchor: { fingerprint: initial.run.targetFingerprints.anchor.fingerprint, ...initialPack.pack.targetJudgmentEvidence.anchor, disposition: "clean" },
    peer: { fingerprint: initial.run.targetFingerprints.peer.fingerprint, ...initialPack.pack.targetJudgmentEvidence.peer, disposition: "not-judged" },
  });

  const durable = fixture({ count: 3, root: initial.root, project: initial.cfg.name });
  durable.stateDir = initial.stateDir;
  limitCaptureTo(durable, ["anchor", "peer"]);
  const durableDelta = buildPack(durable).pack;
  assert.deepEqual(durableDelta.targets, ["peer"]);

  const fallback = fixture({ count: 3, root: initial.root, project: initial.cfg.name });
  limitCaptureTo(fallback, ["anchor", "peer"]);
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", fallback.configPath, "--judge-pack", "--run", fallback.runDir, "--previous-pack", initialPack.path, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: fallback.stateDir } },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).judgePack.targets, ["peer"]);
});

test("judge packs reject uncovered batches before ui-judge can invoke an engine", async () => {
  const subject = fixture({ count: 6 });
  const built = buildPack(subject);
  const omitted = structuredClone(built.pack);
  omitted.batches = omitted.batches.filter((batch) => batch.anchorId !== null);
  const omittedValidation = validateJudgePack(omitted);
  assert.equal(omittedValidation.valid, false);
  assert.ok(omittedValidation.errors.some((error) => /batches: must cover every pack target/.test(error)));

  const empty = structuredClone(built.pack);
  empty.batches = [];
  const emptyValidation = validateJudgePack(empty);
  assert.equal(emptyValidation.valid, false);
  assert.ok(emptyValidation.errors.some((error) => /batches: must cover every pack target/.test(error)));
  writeFileSync(built.path, JSON.stringify(empty, null, 2));
  let engineCalls = 0;
  await assert.rejects(
    () => runJudge({
      packPath: built.path,
      configPath: subject.configPath,
      engine(call) {
        engineCalls += 1;
        return initialEngineResponse(call);
      },
    }),
    (error) => error instanceof JudgeExecutorError && /must cover every pack target/.test(error.message),
  );
  assert.equal(engineCalls, 0);
});

test("ui-judge rejects an image list missing a selected target's non-reference imagery before the engine", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const batch = pack.pack.batches[0];
  const listPath = join(subject.runDir, batch.imageList);
  const list = readJson(listPath);
  const missingTarget = batch.targetIds.find((targetId) => targetId !== batch.anchorId);
  list.images.find((image) => image.targetId === missingTarget && !image.referenceOnly).referenceOnly = true;
  writeFileSync(listPath, JSON.stringify(list, null, 2));
  const remappedPack = readJson(pack.path);
  remappedPack.batches.find((entry) => entry.id === batch.id).imageListDigest = HASH(readFileSync(listPath));
  writeFileSync(pack.path, JSON.stringify(remappedPack, null, 2));
  let engineCalls = 0;
  await assert.rejects(
    () => runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine() {
        engineCalls += 1;
        return "unreachable";
      },
    }),
    (error) => error instanceof JudgeExecutorError && /targetIds must exactly match.*non-reference/i.test(error.message),
  );
  assert.equal(engineCalls, 0);
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
});

test("ui-judge rejects an image list with an extra unknown target before the engine", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const batch = pack.pack.batches[0];
  const listPath = join(subject.runDir, batch.imageList);
  const list = readJson(listPath);
  list.images.find((image) => !image.referenceOnly).targetId = "unknown-target";
  writeFileSync(listPath, JSON.stringify(list, null, 2));
  const remappedPack = readJson(pack.path);
  remappedPack.batches.find((entry) => entry.id === batch.id).imageListDigest = HASH(readFileSync(listPath));
  writeFileSync(pack.path, JSON.stringify(remappedPack, null, 2));
  let engineCalls = 0;
  await assert.rejects(
    () => runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine() {
        engineCalls += 1;
        return "unreachable";
      },
    }),
    (error) => error instanceof JudgeExecutorError && /targetIds must exactly match.*non-reference/i.test(error.message),
  );
  assert.equal(engineCalls, 0);
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
});

test("the example project's five triaged exemplar entries are schema-valid and become few-shot pack metadata", () => {
  const exemplars = loadExemplars("example");
  assert.equal(exemplars.length, 5);
  for (const exemplar of exemplars) {
    const { id, path, ...record } = exemplar;
    assert.equal(validateExemplar(record).valid, true, id);
    assert.match(path, /^projects\/exemplars\/example\//);
    assert.match(exemplar.screenshot.status, /^(available|unavailable)$/);
    if (exemplar.screenshot.status === "available") {
      assert.match(exemplar.screenshot.libraryPath, /^runs\/[0-9a-f-]{36}\/.+\.png$/);
      assert.match(exemplar.screenshot.sha256, /^sha256:[a-f0-9]{64}$/);
    }
    assert.match(exemplar.curator, /2026-08-11/);
  }
  const subject = fixture({ count: 6, project: "example" });
  const pack = buildPack(subject).pack;
  assert.equal(pack.exemplars.length, 5);
  assert.ok(pack.exemplars.every((exemplar) => exemplar.screenshot.status === "unavailable"), "a fixture without the retained example library must not guess an exemplar image");
  assert.match(readFileSync(join(subject.runDir, pack.batches[0].prompt), "utf8"), /screen-shell/);
});

test("judge pack snapshots an exemplar from its run-qualified digest and ignores later latest republication", () => {
  const subject = fixture({ count: 6 });
  const exemplar = retainImmutableExemplar(subject);
  const pack = buildPack(subject, { exemplarDefinitions: [exemplar] }).pack;
  const packed = pack.exemplars[0];
  assert.equal(packed.screenshot.status, "available");
  assert.equal(packed.screenshot.libraryPath, exemplar.screenshot.libraryPath);
  assert.equal(packed.screenshot.sha256, exemplar.screenshot.sha256);
  assert.equal(pack.attachmentHashes[packed.screenshot.attachment], exemplar.screenshot.sha256);
  const packedPath = join(subject.runDir, packed.screenshot.attachment);
  assert.equal(readFileSync(packedPath).equals(exemplar.bytes), true);

  const republishedLatest = latestAssetPath(subject.cfg.name, {
    targetId: "immutable-exemplar",
    appearance: "dark",
    variant: "full",
    interaction: null,
    crop: null,
  }, subject.stateDir);
  mkdirSync(dirname(republishedLatest), { recursive: true });
  writeFileSync(republishedLatest, png(23, 11, 0x99));
  assert.equal(readFileSync(packedPath).equals(exemplar.bytes), true, "an already-built pack must retain its immutable exemplar bytes");
});

test("ui-judge refuses a mutated exemplar attachment before the fake engine runs", async () => {
  const subject = fixture({ count: 6 });
  const exemplar = retainImmutableExemplar(subject);
  const pack = buildPack(subject, { exemplarDefinitions: [exemplar] });
  const attachment = pack.pack.exemplars[0].screenshot.attachment;
  writeFileSync(join(subject.runDir, attachment), png(23, 11, 0x9a));
  let engineCalls = 0;
  await assert.rejects(
    () => runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine() {
        engineCalls += 1;
        return "unreachable";
      },
    }),
    (error) => error instanceof JudgeExecutorError && /exemplar.*digest/i.test(error.message),
  );
  assert.equal(engineCalls, 0);
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
});

test("ui-judge still refuses an unsealed pack when the verification template no longer matches its rubric", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const templatePath = join(__dirname, "..", "reference", "judge-verification.md");
  const template = readFileSync(templatePath, "utf8");
  let engineCalls = 0;
  try {
    writeFileSync(templatePath, `${template}\n<!-- fake executor mismatch -->\n`);
    await assert.rejects(
      () => runJudge({
        packPath: pack.path,
        configPath: subject.configPath,
        engine() {
          engineCalls += 1;
          return "unreachable";
        },
      }),
      (error) => error instanceof JudgeExecutorError && /rubric digest.*verification template bytes/i.test(error.message),
    );
  } finally {
    writeFileSync(templatePath, template);
  }
  assert.equal(engineCalls, 0);
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
  assert.equal(readJson(pack.path).artifacts.some((path) => path.endsWith("executor-outcome.json")), false);
});

test("ui-judge reconciles a sealed judgment before checking changed current rubric bytes", async () => {
  const subject = fixture({ count: 6 });
  const built = buildPack(subject);
  const templatePath = join(__dirname, "..", "reference", "judge-checklist.md");
  const template = readFileSync(templatePath, "utf8");
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  let rerunEngineCalls = 0;
  try {
    const first = await runJudge({
      packPath: built.path,
      configPath: subject.configPath,
      engine: (call) => initialEngineResponse(call),
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(first.outcome, "recorded");

    const sealedPack = readJson(built.path);
    const outcomeArtifact = sealedPack.artifacts.find((path) => path.endsWith("executor-outcome.json"));
    assert.ok(outcomeArtifact);
    rmSync(join(subject.runDir, outcomeArtifact));
    rmSync(join(subject.stateDir, subject.cfg.name, "judgments", "latest.json"));
    writeFileSync(built.path, JSON.stringify({ ...sealedPack, judgedFingerprints: {} }, null, 2));
    writeFileSync(templatePath, `${template}\n<!-- fake sealed-rerun rubric change -->\n`);

    const rerun = await runJudge({
      packPath: built.path,
      configPath: subject.configPath,
      engine() {
        rerunEngineCalls += 1;
        throw new Error("a sealed idempotent rerun must not launch an engine");
      },
      model: { provider: "fake", name: "fixture" },
    });

    assert.equal(rerun.outcome, "recorded");
    assert.equal(rerun.reused, true);
    assert.match(rerun.note, /reconciled and recorded.*no engine calls/i);
    assert.equal(rerunEngineCalls, 0);
    assert.deepEqual(readJson(built.path).judgedFingerprints, sealedPack.judgedFingerprints);
    assert.equal(readJson(join(subject.runDir, outcomeArtifact)).outcome, "recorded");
  } finally {
    writeFileSync(templatePath, template);
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
});

test("ui-judge fake engine records initial, crop-backed verification, disposition, and seal through ui-review --record", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const firstImage = readJson(join(subject.runDir, pack.pack.batches[0].imageList)).images[0];
  const preVerificationEvidence = structuredClone(pack.pack.targetJudgmentEvidence);
  const calls = [];
  let emittedInitial = false;
  const engine = (call) => {
    calls.push(call.phase);
    if (call.phase === "initial") {
      if (emittedInitial) return initialEngineResponse(call);
      emittedInitial = true;
      return initialEngineResponse(call, [validEngineFinding({ id: "11111111-1111-4111-8111-111111111111", targetId: firstImage.targetId, assetId: firstImage.assetId })]);
    }
    return JSON.stringify({ verifierVerdict: "confirmed", evidence: "The verification crop visibly confirms the uneven spacing." });
  };
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = stateDir;
  try {
    const result = await runJudge({ packPath: pack.path, configPath: subject.configPath, engine, model: { provider: "fake", name: "fixture" } });
    assert.equal(result.outcome, "recorded");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  assert.deepEqual(calls, ["initial", "initial", "verification"]);
  const reviewPath = join(stateDir, "fixture", "runs", subject.run.runId, "review.json");
  const events = readFileSync(reviewPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.kind), ["record-header", "initial", "verification", "disposition", "seal"]);
  assert.equal(events[2].verifierVerdict, "confirmed");
  assert.equal(events[3].finding.disposition, "accepted");
  assert.match(events[3].finding.cropDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(events[2].evidence, /crop/);
  const sealedPack = readJson(pack.path);
  const affectedEvidence = sealedPack.targetJudgmentEvidence[firstImage.targetId];
  const verificationCropId = "verify-11111111-1111-4111-8111-111111111111";
  const verificationPromptId = `verification:${verificationCropId}`;
  assert.match(affectedEvidence.promptDigests[verificationPromptId], /^sha256:[a-f0-9]{64}$/);
  assert.ok(
    sealedPack.artifacts.some((path) => path.endsWith(`/verification/${verificationCropId}.md`)),
    "the prompt artifact path must use the crop identity",
  );
  assert.notEqual(
    affectedEvidence.evidenceDigest,
    preVerificationEvidence[firstImage.targetId].evidenceDigest,
    "the sealed evidence must change when a verifier prompt is created",
  );
  assert.equal(
    affectedEvidence.evidenceDigest,
    HASH(JSON.stringify(canonicalValue({
      baseEvidenceDigest: affectedEvidence.baseEvidenceDigest,
      promptDigests: affectedEvidence.promptDigests,
    }))),
    "the sealed digest must independently recompute from the base evidence and all executed prompts",
  );
  for (const targetId of sealedPack.targets.filter((targetId) => targetId !== firstImage.targetId)) {
    assert.deepEqual(sealedPack.targetJudgmentEvidence[targetId], preVerificationEvidence[targetId]);
  }
  assert.equal(sealedPack.judgedFingerprints[firstImage.targetId].evidenceDigest, affectedEvidence.evidenceDigest);
  const cursor = readJson(join(stateDir, subject.cfg.name, "judgments", "latest.json"));
  assert.equal(cursor.targets[firstImage.targetId].evidenceDigest, affectedEvidence.evidenceDigest);
  assert.equal(readJson(join(subject.runDir, pack.pack.cropRequests)).length, 1);
  const durableCropRoot = join(stateDir, subject.cfg.name, "runs", subject.run.runId, "review-crops");
  const [durableCrop] = regularFilesUnder(durableCropRoot);
  assert.equal(HASH(readFileSync(durableCrop)), events[3].finding.cropDigest);
  rmSync(subject.runDir, { recursive: true, force: true });
  assert.equal(existsSync(durableCrop), true, "sealed crop evidence must survive capture-directory removal");
  assert.equal(HASH(readFileSync(durableCrop)), events[3].finding.cropDigest);
});

test("ui-judge reconciles a sealed judgment when outcome publication was interrupted without another engine call", async () => {
  const subject = fixture({ count: 6 });
  const built = buildPack(subject);
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  let initialEngineCalls = 0;
  try {
    const first = await runJudge({
      packPath: built.path,
      configPath: subject.configPath,
      engine(call) {
        initialEngineCalls += 1;
        return initialEngineResponse(call);
      },
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(first.outcome, "recorded");
    assert.ok(initialEngineCalls > 0);

    const sealedPack = readJson(built.path);
    const outcomeArtifact = sealedPack.artifacts.find((path) => path.endsWith("executor-outcome.json"));
    assert.ok(outcomeArtifact);
    const executorOutcomePath = join(subject.runDir, outcomeArtifact);
    const executorOutcomeBytes = readFileSync(executorOutcomePath, "utf8");
    rmSync(executorOutcomePath);
    rmSync(join(subject.stateDir, subject.cfg.name, "judgments", "latest.json"));
    writeFileSync(built.path, JSON.stringify({ ...sealedPack, judgedFingerprints: {} }, null, 2));
    let rerunEngineCalls = 0;
    const second = await runJudge({
      packPath: built.path,
      configPath: subject.configPath,
      engine() {
        rerunEngineCalls += 1;
        throw new Error("the idempotent rerun must not launch an engine");
      },
      model: { provider: "fake", name: "fixture" },
    });

    assert.equal(second.outcome, "recorded");
    assert.equal(second.reused, true);
    assert.match(second.note, /reconciled and recorded.*no engine calls/i);
    assert.equal(rerunEngineCalls, 0);
    assert.equal(readJson(executorOutcomePath).outcome, "recorded");
    assert.notEqual(readFileSync(executorOutcomePath, "utf8"), executorOutcomeBytes);
    assert.deepEqual(readJson(built.path).judgedFingerprints, sealedPack.judgedFingerprints);
    assert.ok(Object.keys(readJson(join(subject.stateDir, subject.cfg.name, "judgments", "latest.json")).targets).length > 0);

    rmSync(executorOutcomePath);
    const cliEnvironment = { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir };
    delete cliEnvironment.AUTOREVIEW_UI_JUDGE_API_KEY;
    delete cliEnvironment.OPENAI_API_KEY;
    const cli = spawnSync(
      process.execPath,
      [UI_JUDGE, "--pack", built.path, "--config", subject.configPath],
      { encoding: "utf8", env: cliEnvironment },
    );
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.match(cli.stdout, /existing sealed judgment reconciled and recorded; no engine calls made/i);
    assert.equal(readJson(executorOutcomePath).outcome, "recorded");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
});

test("ui-judge replays its preserved record journal when the canonical seal was not published", async () => {
  const subject = fixture({ count: 6 });
  const built = buildPack(subject);
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  try {
    const first = await runJudge({
      packPath: built.path,
      configPath: subject.configPath,
      engine: (call) => initialEngineResponse(call),
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(first.outcome, "recorded");
    const sealedPack = readJson(built.path);
    const outcomeArtifact = sealedPack.artifacts.find((path) => path.endsWith("executor-outcome.json"));
    const recordArtifact = sealedPack.artifacts.find((path) => path.endsWith("record-events.json"));
    assert.ok(outcomeArtifact);
    assert.ok(recordArtifact);

    rmSync(join(subject.runDir, outcomeArtifact));
    rmSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json"));
    rmSync(join(subject.stateDir, subject.cfg.name, "judgments", "latest.json"));
    writeFileSync(built.path, JSON.stringify({ ...sealedPack, judgedFingerprints: {} }, null, 2));

    let engineCalls = 0;
    const recovered = await runJudge({
      packPath: built.path,
      configPath: subject.configPath,
      engine() {
        engineCalls += 1;
        throw new Error("the journal recovery must precede engine selection");
      },
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(recovered.outcome, "recorded");
    assert.equal(recovered.reused, true);
    assert.equal(engineCalls, 0);
    assert.equal(readJson(join(subject.runDir, outcomeArtifact)).outcome, "recorded");
    assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), true);
    assert.ok(Object.keys(readJson(built.path).judgedFingerprints).length > 0);
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
});

test("ui-judge does not treat a genuinely unsealed review as a completed engine result", async () => {
  const subject = fixture({ count: 6 });
  const built = buildPack(subject);
  const image = readJson(join(subject.runDir, built.pack.batches[0].imageList)).images.find((entry) => !entry.referenceOnly);
  const { verifierVerdict: _verifierVerdict, disposition: _disposition, ...candidate } = validEngineFinding({
    id: randomUUID(),
    targetId: image.targetId,
    assetId: image.assetId,
  });
  appendReviewRecord([
    recordHeaderFor(subject),
    { kind: "initial", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", finding: candidate },
  ], {
    projectRoot: subject.cfg.root,
    stateDir: subject.stateDir,
    targetIds: subject.cfg.routes.map((route) => route.id),
    capturedTargetIds: subject.run.targetIds,
    capturedTargetOutcomes: subject.run.targetOutcomes,
    capturedTargetShotHashes: subject.run.targetShotHashes,
  });

  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  let engineCalls = 0;
  try {
    await assert.rejects(
      () => runJudge({
        packPath: built.path,
        configPath: subject.configPath,
        engine() {
          engineCalls += 1;
          throw new Error("fixture engine proves the unsealed pack still runs");
        },
      }),
      /fixture engine proves the unsealed pack still runs/,
    );
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  assert.equal(engineCalls, 1);
});

test("ui-judge requires a rebuilt pack when an already-recorded pack's target set changes", async () => {
  const subject = fixture({ count: 6 });
  const built = buildPack(subject);
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  try {
    const first = await runJudge({
      packPath: built.path,
      configPath: subject.configPath,
      engine: (call) => initialEngineResponse(call),
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(first.outcome, "recorded");

    const changedPack = readJson(built.path);
    const removedTarget = changedPack.targets.at(-1);
    changedPack.targets = changedPack.targets.filter((targetId) => targetId !== removedTarget);
    delete changedPack.targetFingerprints[removedTarget];
    delete changedPack.targetJudgmentEvidence[removedTarget];
    delete changedPack.targetShotHashes[removedTarget];
    changedPack.contexts = changedPack.contexts.filter((context) => context.targetId !== removedTarget);
    changedPack.reselectedTargets = changedPack.reselectedTargets.filter((target) => target.targetId !== removedTarget);
    changedPack.batches = changedPack.batches
      .map((batch) => ({ ...batch, targetIds: batch.targetIds.filter((targetId) => targetId !== removedTarget) }))
      .filter((batch) => batch.targetIds.length > 0);
    assert.equal(validateJudgePack(changedPack).valid, true);
    writeFileSync(built.path, JSON.stringify(changedPack, null, 2));

    const outcomeArtifact = changedPack.artifacts.find((path) => path.endsWith("executor-outcome.json"));
    const executorOutcomePath = join(subject.runDir, outcomeArtifact);
    const executorOutcomeBytes = readFileSync(executorOutcomePath, "utf8");
    let engineCalls = 0;
    await assert.rejects(
      () => runJudge({
        packPath: built.path,
        configPath: subject.configPath,
        engine() {
          engineCalls += 1;
          return "unreachable";
        },
      }),
      (error) => error instanceof JudgeExecutorError &&
        error.phase === "pack" &&
        /does not match its completed recorded judgment/i.test(error.message) &&
        /ui-review --judge-pack --run/.test(error.message),
    );
    assert.equal(engineCalls, 0);
    assert.equal(readFileSync(executorOutcomePath, "utf8"), executorOutcomeBytes);
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
});

test("ui-judge recovers a finalized verification crop whose pack binding was interrupted", async () => {
  const subject = fixture({ count: 6 });
  const built = buildPack(subject);
  const firstImage = readJson(join(subject.runDir, built.pack.batches[0].imageList)).images[0];
  const findingId = "17171717-1717-4171-8171-171717171717";
  const journalPath = join(subject.runDir, "judge", "verification-crop.journal.json");
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  try {
    await assert.rejects(
      () => runJudge({
        packPath: built.path,
        configPath: subject.configPath,
        engine: cropVerificationEngine(firstImage, findingId),
        model: { provider: "fake", name: "fixture" },
        verificationCropCheckpoint({ phase }) {
          if (phase === "after-finalize") throw new Error("induced stop after verification crop finalize");
        },
      }),
      /induced stop after verification crop finalize/,
    );
    assert.equal(existsSync(journalPath), true);
    const journal = readJson(journalPath);
    const interruptedRun = readJson(join(subject.runDir, "run.json"));
    assert.equal(interruptedRun.targetShotHashes[journal.targetId][journal.attachment.slice("shots/".length)], journal.digest);
    assert.equal(readJson(built.path).attachmentHashes[journal.attachment], undefined);

    const result = await runJudge({
      packPath: built.path,
      configPath: subject.configPath,
      engine: cropVerificationEngine(firstImage, findingId),
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(result.outcome, "recorded");
    assert.equal(existsSync(journalPath), false);
    assert.equal(readJson(built.path).attachmentHashes[journal.attachment], journal.digest);
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
});

test("judge pack rebuild recovers a finalized verification-crop journal before replacing the manifest and ui-judge retries", async () => {
  const subject = fixture({ count: 6 });
  const interruptedPack = buildPack(subject);
  const firstImage = readJson(join(subject.runDir, interruptedPack.pack.batches[0].imageList)).images[0];
  const findingId = "19191919-1919-4191-8191-191919191919";
  const journalPath = join(subject.runDir, "judge", "verification-crop.journal.json");
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  try {
    await assert.rejects(
      () => runJudge({
        packPath: interruptedPack.path,
        configPath: subject.configPath,
        engine: cropVerificationEngine(firstImage, findingId),
        model: { provider: "fake", name: "fixture" },
        verificationCropCheckpoint({ phase }) {
          if (phase === "after-finalize") throw new Error("induced rebuild recovery stop");
        },
      }),
      /induced rebuild recovery stop/,
    );
    const journal = readJson(journalPath);
    assert.equal(readJson(interruptedPack.path).attachmentHashes[journal.attachment], undefined);

    const rebuilt = buildPack(subject);
    assert.notEqual(rebuilt.pack.packId, interruptedPack.pack.packId);
    assert.equal(existsSync(journalPath), false, "rebuild must resolve the old transaction before publishing its pack");
    assert.equal(rebuilt.pack.targetShotHashes[journal.targetId][journal.attachment.slice("shots/".length)], journal.digest);
    assert.equal(rebuilt.pack.attachmentHashes[journal.attachment], journal.digest);

    const rebuiltFirstImage = readJson(join(subject.runDir, rebuilt.pack.batches[0].imageList)).images[0];
    const result = await runJudge({
      packPath: rebuilt.path,
      configPath: subject.configPath,
      engine: cropVerificationEngine(rebuiltFirstImage, findingId),
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(result.outcome, "recorded");
    assert.equal(existsSync(journalPath), false);
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
});

test("judge pack rebuild refuses an unrecoverable verification-crop journal and names it", async () => {
  const subject = fixture({ count: 6 });
  const interruptedPack = buildPack(subject);
  const firstImage = readJson(join(subject.runDir, interruptedPack.pack.batches[0].imageList)).images[0];
  const findingId = "20202020-2020-4202-8202-202020202020";
  const journalPath = join(subject.runDir, "judge", "verification-crop.journal.json");
  const buildsPath = join(subject.runDir, "judge", "builds");
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  try {
    await assert.rejects(
      () => runJudge({
        packPath: interruptedPack.path,
        configPath: subject.configPath,
        engine: cropVerificationEngine(firstImage, findingId),
        model: { provider: "fake", name: "fixture" },
        verificationCropCheckpoint({ phase }) {
          if (phase === "after-finalize") throw new Error("induced unrecoverable journal stop");
        },
      }),
      /induced unrecoverable journal stop/,
    );
    const priorBuilds = readdirSync(buildsPath).sort();
    rmSync(interruptedPack.path);
    assert.throws(
      () => buildPack(subject),
      (error) => error.message.includes(journalPath) && /Restore the journal's referenced judge manifest and crop artifacts/.test(error.message),
    );
    assert.equal(existsSync(journalPath), true, "failed recovery must retain its journal for repair and retry");
    assert.deepEqual(readdirSync(buildsPath).sort(), priorBuilds, "refused rebuild must not create a replacement generation");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
});

test("ui-judge rolls back a pre-finalize verification crop orphan before retrying", async () => {
  const subject = fixture({ count: 6 });
  const built = buildPack(subject);
  const firstImage = readJson(join(subject.runDir, built.pack.batches[0].imageList)).images[0];
  const findingId = "18181818-1818-4181-8181-181818181818";
  const journalPath = join(subject.runDir, "judge", "verification-crop.journal.json");
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  try {
    await assert.rejects(
      () => runJudge({
        packPath: built.path,
        configPath: subject.configPath,
        engine: cropVerificationEngine(firstImage, findingId),
        model: { provider: "fake", name: "fixture" },
        verificationCropCheckpoint({ phase }) {
          if (phase === "before-finalize") throw new Error("induced stop before verification crop finalize");
        },
      }),
      /induced stop before verification crop finalize/,
    );
    const journal = readJson(journalPath);
    const orphanPath = join(subject.runDir, journal.paths.crop);
    assert.equal(existsSync(orphanPath), true);
    assert.equal(readJson(join(subject.runDir, "run.json")).targetShotHashes[journal.targetId][journal.attachment.slice("shots/".length)], undefined);

    let sawCleanRestage = false;
    const result = await runJudge({
      packPath: built.path,
      configPath: subject.configPath,
      engine: cropVerificationEngine(firstImage, findingId),
      model: { provider: "fake", name: "fixture" },
      verificationCropCheckpoint({ phase }) {
        if (phase === "journaled") {
          sawCleanRestage = true;
          assert.equal(existsSync(orphanPath), false, "recovery must remove the old final-path orphan before producing the retry");
        }
      },
    });
    assert.equal(result.outcome, "recorded");
    assert.equal(sawCleanRestage, true);
    assert.equal(existsSync(journalPath), false);
    assert.equal(existsSync(orphanPath), true, "the successful retry republishes the crop at its deterministic path");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
});

test("ui-judge hard-refuses a crop-request path below an in-run symlink before any write", async () => {
  const subject = fixture({ count: 6 });
  const built = buildPack(subject);
  const outside = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-outside-"));
  const originalCropRequests = built.pack.cropRequests;
  const buildDir = dirname(join(subject.runDir, originalCropRequests));
  const linkedDir = join(buildDir, "outside-link");
  const outsideCropRequests = join(outside, "crop-requests.json");
  writeFileSync(outsideCropRequests, "[]\n");
  symlinkSync(outside, linkedDir);

  const unsafeCropRequests = relative(subject.runDir, join(linkedDir, "crop-requests.json")).split(sep).join("/");
  const tampered = structuredClone(built.pack);
  tampered.cropRequests = unsafeCropRequests;
  tampered.artifacts = tampered.artifacts.map((path) => path === originalCropRequests ? unsafeCropRequests : path).sort();
  assert.equal(validateJudgePack(tampered).valid, true, "the tampered path remains schema-valid and must be rejected at the filesystem boundary");
  writeFileSync(built.path, JSON.stringify(tampered, null, 2));

  const snapshot = () => Object.fromEntries(
    regularFilesUnder(subject.runDir).map((path) => [relative(subject.runDir, path), HASH(readFileSync(path))]),
  );
  const beforeRun = snapshot();
  const outsideBefore = readFileSync(outsideCropRequests, "utf8");
  let engineCalls = 0;
  await assert.rejects(
    () => runJudge({
      packPath: built.path,
      configPath: subject.configPath,
      engine(call) {
        engineCalls += 1;
        return initialEngineResponse(call);
      },
      model: { provider: "fake", name: "fixture" },
    }),
    (error) => error instanceof JudgeExecutorError && error.hard === true &&
      error.message.includes(join(linkedDir, "crop-requests.json")) &&
      /outside the real capture run/.test(error.message),
  );
  assert.equal(engineCalls, 0, "unsafe pack paths must fail during preflight");
  assert.deepEqual(snapshot(), beforeRun, "the capture run must remain byte-for-byte unchanged");
  assert.equal(readFileSync(outsideCropRequests, "utf8"), outsideBefore);
  assert.deepEqual(readdirSync(outside).sort(), ["crop-requests.json"]);
});

test("ui-judge replaces a mismatched retry crop with a region-specific crop without touching the old evidence", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const firstImage = readJson(join(subject.runDir, pack.pack.batches[0].imageList)).images.find((image) => !image.referenceOnly);
  const findingId = "13131313-1313-4131-8131-131313131313";
  const oldRegion = { x: 0.1, y: 0.2, w: 0.4, h: 0.3, normalized: true };
  const changedRegion = { x: 0.3, y: 0.2, w: 0.4, h: 0.3, normalized: true };
  const manifestPath = join(subject.runDir, "shots", "manifest.json");
  const captureManifest = readJson(manifestPath);
  const old = produceCrops({
    captureManifest,
    cfg: subject.cfg,
    shotsDir: join(subject.runDir, "shots"),
    cropRequests: [{ assetId: firstImage.assetId, rect: oldRegion, purpose: `verify-${findingId}` }],
  }).produced[0];
  writeFileSync(manifestPath, JSON.stringify(captureManifest, null, 2));
  subject.run = finalizeCaptureRun(
    join(subject.runDir, "run.json"),
    subject.run,
    captureManifest,
    join(subject.runDir, "shots"),
  );
  const oldRelativePath = relative(subject.runDir, old.path).split(sep).join("/");
  const retryPack = readJson(pack.path);
  retryPack.attachmentHashes[oldRelativePath] = HASH(readFileSync(old.path));
  writeFileSync(pack.path, JSON.stringify(retryPack, null, 2));
  const oldBytes = readFileSync(old.path);
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = stateDir;
  let verificationPath = null;
  try {
    const result = await runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine(call) {
        if (call.phase === "verification") {
          assert.equal(HASH(Buffer.from(call.prompt, "utf8")), call.promptDigest);
          assert.equal(HASH(readFileSync(call.promptPath)), call.promptDigest);
          verificationPath = call.images[0];
          return JSON.stringify({ verifierVerdict: "confirmed", evidence: "The shifted crop confirms the issue." });
        }
        const image = readJson(join(subject.runDir, call.batch.imageList)).images.find((entry) => !entry.referenceOnly);
        return initialEngineResponse(call, image.assetId === firstImage.assetId ? [{
          ...validEngineFinding({ id: findingId, targetId: firstImage.targetId, assetId: firstImage.assetId }),
          region: changedRegion,
        }] : []);
      },
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(result.outcome, "recorded");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  const crops = readJson(manifestPath).targets
    .find((target) => target.id === firstImage.targetId)
    .shots
    .filter((shot) => shot.sourceAssetId === firstImage.assetId && shot.cropId.startsWith(`verify-${findingId}`));
  assert.equal(crops.length, 2);
  const retainedOld = crops.find((crop) => crop.cropId === `verify-${findingId}`);
  const replacement = crops.find((crop) => crop.cropId !== `verify-${findingId}`);
  assert.deepEqual(retainedOld.rect, oldRegion);
  assert.deepEqual(replacement.rect, changedRegion);
  assert.equal(readFileSync(retainedOld.path).equals(oldBytes), true, "the original crop remains untouched");
  assert.equal(verificationPath, replacement.path, "verification must receive the crop for the changed region");
  const events = readFileSync(join(stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json"), "utf8").trim().split("\n").map(JSON.parse);
  const disposition = events.find((event) => event.kind === "disposition");
  assert.equal(disposition.finding.cropId, replacement.cropId);
});

test("ui-judge versions a same-UUID retry on source-asset change and reuses identical replacement evidence", async () => {
  const subject = fixture({ count: 6, assetsByTarget: { anchor: 2 } });
  const initialManifestPath = join(subject.runDir, "shots", "manifest.json");
  const initialManifest = readJson(initialManifestPath);
  initialManifest.targets.find((target) => target.id === "anchor").shots[1].variant = "alternate";
  writeFileSync(initialManifestPath, JSON.stringify(initialManifest, null, 2));
  const built = buildPack(subject);
  const images = built.pack.batches
    .flatMap((batch) => readJson(join(subject.runDir, batch.imageList)).images)
    .filter((image) => image.targetId === "anchor" && !image.referenceOnly);
  const [oldImage, replacementImage] = [...new Map(images.map((image) => [image.assetId, image])).values()];
  assert.ok(oldImage && replacementImage);
  assert.notEqual(oldImage.assetId, replacementImage.assetId);
  const findingId = "15151515-1515-4151-8151-151515151515";
  const region = { x: 0.1, y: 0.2, w: 0.4, h: 0.3, normalized: true };
  const manifestPath = join(subject.runDir, "shots", "manifest.json");
  const captureManifest = readJson(manifestPath);
  const oldCrop = produceCrops({
    captureManifest,
    cfg: subject.cfg,
    shotsDir: join(subject.runDir, "shots"),
    cropRequests: [{ assetId: oldImage.assetId, rect: region, purpose: `verify-${findingId}` }],
  }).produced[0];
  writeFileSync(manifestPath, JSON.stringify(captureManifest, null, 2));
  subject.run = finalizeCaptureRun(
    join(subject.runDir, "run.json"),
    subject.run,
    captureManifest,
    join(subject.runDir, "shots"),
  );
  const oldRelativePath = relative(subject.runDir, oldCrop.path).split(sep).join("/");
  const retryPack = readJson(built.path);
  retryPack.attachmentHashes[oldRelativePath] = HASH(readFileSync(oldCrop.path));
  writeFileSync(built.path, JSON.stringify(retryPack, null, 2));
  const oldBytes = readFileSync(oldCrop.path);

  const runAttempt = ({ failVerification = false } = {}) => {
    let emittedInitial = false;
    return runJudge({
      packPath: built.path,
      configPath: subject.configPath,
      engine(call) {
        if (call.phase === "verification") {
          if (failVerification) return "{}";
          return JSON.stringify({ verifierVerdict: "confirmed", evidence: "The corrected source-asset crop confirms the issue." });
        }
        if (emittedInitial) return initialEngineResponse(call);
        emittedInitial = true;
        return initialEngineResponse(call, [{
          ...validEngineFinding({ id: findingId, targetId: replacementImage.targetId, assetId: replacementImage.assetId }),
          region,
        }]);
      },
      model: { provider: "fake", name: "fixture" },
    });
  };

  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  try {
    await assert.rejects(
      () => runAttempt({ failVerification: true }),
      (error) => error instanceof JudgeExecutorError && /verification engine output must be/.test(error.message),
    );
    const afterFailure = verificationCrops(subject).filter((crop) => crop.cropId.startsWith(`verify-${findingId}`));
    assert.equal(afterFailure.length, 2, "the changed source asset must stage one versioned replacement");
    const replacement = afterFailure.find((crop) => crop.sourceAssetId === replacementImage.assetId);
    assert.ok(replacement);
    assert.notEqual(replacement.cropId, `verify-${findingId}`);
    const replacementBytes = readFileSync(replacement.path);

    const result = await runAttempt();
    assert.equal(result.outcome, "recorded");
    const afterRetry = verificationCrops(subject).filter((crop) => crop.cropId.startsWith(`verify-${findingId}`));
    assert.equal(afterRetry.length, 2, "identical replacement evidence must reuse its versioned crop");
    assert.equal(readFileSync(oldCrop.path).equals(oldBytes), true, "the original source crop remains untouched");
    assert.equal(readFileSync(replacement.path).equals(replacementBytes), true, "the identical retry reuses the staged replacement bytes");
    const events = readFileSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.find((event) => event.kind === "disposition").finding.cropId, replacement.cropId);
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
});

test("a failed verification retry with the same UUID and changed region versions prompt artifacts by crop identity", async () => {
  const subject = fixture({ count: 6 });
  const built = buildPack(subject);
  const firstImage = readJson(join(subject.runDir, built.pack.batches[0].imageList)).images.find((image) => !image.referenceOnly);
  const findingId = "14141414-1414-4141-8141-141414141414";
  const oldRegion = { x: 0.1, y: 0.2, w: 0.4, h: 0.3, normalized: true };
  const changedRegion = { x: 0.35, y: 0.2, w: 0.4, h: 0.3, normalized: true };
  const runAttempt = (region, { failVerification = false } = {}) => {
    let emittedInitial = false;
    return runJudge({
      packPath: built.path,
      configPath: subject.configPath,
      engine(call) {
        if (call.phase === "verification") {
          if (failVerification) return "{}";
          assert.equal(HASH(Buffer.from(call.prompt, "utf8")), call.promptDigest);
          assert.equal(HASH(readFileSync(call.promptPath)), call.promptDigest);
          return JSON.stringify({ verifierVerdict: "confirmed", evidence: "The changed-region retry crop confirms the issue." });
        }
        if (emittedInitial) return initialEngineResponse(call);
        emittedInitial = true;
        return initialEngineResponse(call, [{
          ...validEngineFinding({ id: findingId, targetId: firstImage.targetId, assetId: firstImage.assetId }),
          region,
        }]);
      },
      model: { provider: "fake", name: "fixture" },
    });
  };

  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  try {
    await assert.rejects(
      () => runAttempt(oldRegion, { failVerification: true }),
      (error) => error instanceof JudgeExecutorError && /verification engine output must be/.test(error.message),
    );
    assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);

    const failedPack = readJson(built.path);
    const oldCrop = verificationCrops(subject).find((crop) => crop.cropId === `verify-${findingId}`);
    assert.ok(oldCrop, "the failed attempt must preserve its bound crop");
    const oldPromptRelative = failedPack.artifacts.find((path) => path.endsWith(`/verification/${oldCrop.cropId}.md`));
    assert.ok(oldPromptRelative, "the failed attempt must preserve its crop-keyed prompt");
    const oldPromptPath = join(subject.runDir, oldPromptRelative);
    const oldPromptBytes = readFileSync(oldPromptPath);
    const oldPromptDigest = HASH(oldPromptBytes);
    assert.equal(failedPack.attachmentHashes[oldPromptRelative], oldPromptDigest);
    assert.equal(failedPack.targetJudgmentEvidence[firstImage.targetId].promptDigests[`verification:${oldCrop.cropId}`], oldPromptDigest);

    const result = await runAttempt(changedRegion);
    assert.equal(result.outcome, "recorded");
    const finalPack = readJson(built.path);
    const crops = verificationCrops(subject).filter((crop) => crop.sourceAssetId === firstImage.assetId);
    const newCrop = crops.find((crop) => crop.cropId !== oldCrop.cropId);
    assert.ok(newCrop, "the changed region must receive a region-specific crop identity");
    const newPromptRelative = finalPack.artifacts.find((path) => path.endsWith(`/verification/${newCrop.cropId}.md`));
    assert.ok(newPromptRelative, "the retry must receive a new crop-keyed prompt path");
    assert.notEqual(newPromptRelative, oldPromptRelative);
    assert.equal(readFileSync(oldPromptPath).equals(oldPromptBytes), true, "the failed attempt's prompt artifact must remain untouched");
    assert.equal(finalPack.attachmentHashes[oldPromptRelative], oldPromptDigest);
    assert.equal(finalPack.targetJudgmentEvidence[firstImage.targetId].promptDigests[`verification:${oldCrop.cropId}`], oldPromptDigest);
    assert.equal(
      finalPack.targetJudgmentEvidence[firstImage.targetId].promptDigests[`verification:${newCrop.cropId}`],
      HASH(readFileSync(join(subject.runDir, newPromptRelative))),
    );
    assert.notEqual(finalPack.attachmentHashes[newPromptRelative], oldPromptDigest, "the changed region must render distinct prompt bytes");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
});

test("review crop persistence rejects a crop from a different source asset", () => {
  const subject = fixture({ count: 6 });
  const crop = cropForRecord(subject);
  const result = recordCropEvents(subject, cropBackedRecordEvents(subject, crop, { assetId: "other/dark/full/base" }));
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /crop source asset does not match finding/i);
});

test("review crop persistence rejects a crop with a different normalized region", () => {
  const subject = fixture({ count: 6 });
  const crop = cropForRecord(subject);
  const result = recordCropEvents(subject, cropBackedRecordEvents(subject, crop, {
    region: { x: 0.2, y: 0.2, w: 0.4, h: 0.3, normalized: true },
  }));
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /crop region does not match finding/i);
});

test("review crop persistence seals an exact source asset and normalized region match", () => {
  const subject = fixture({ count: 6 });
  const crop = cropForRecord(subject);
  const result = recordCropEvents(subject, cropBackedRecordEvents(subject, crop));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const review = JSON.parse(result.stdout).review;
  assert.equal(review.complete, true);
  const durableCropRoot = join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review-crops");
  assert.equal(existsSync(durableCropRoot), true);
});

test("review crop persistence accepts an honest nested crop path", () => {
  const subject = fixture({ count: 6 });
  const crop = cropForRecord(subject);
  const shotsDir = join(subject.runDir, "shots");
  const manifestPath = join(shotsDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const shot = manifest.targets
    .flatMap((target) => target.shots || [])
    .find((candidate) => candidate.cropId === crop.cropId && candidate.sourceAssetId === crop.sourceAssetId);
  const nestedDir = join(shotsDir, "honest", "nested");
  const nestedPath = join(nestedDir, basename(crop.path));
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(nestedPath, readFileSync(crop.path));
  rmSync(crop.path);
  crop.path = nestedPath;
  shot.path = nestedPath;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  subject.run = finalizeCaptureRun(join(subject.runDir, "run.json"), subject.run, manifest, shotsDir);

  assert.doesNotThrow(() => loadCompletedCaptureRun(subject.runDir, subject.cfg));
  const events = cropBackedRecordEvents(subject, crop);
  const result = recordCropEvents(subject, events);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const [durableCrop] = regularFilesUnder(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review-crops"));
  assert.equal(HASH(readFileSync(durableCrop)), events.find((event) => event.kind === "disposition").finding.cropDigest);
});

test("completed-run loading and durable crop copying reject a symlinked crop ancestor", () => {
  const subject = fixture({ count: 6 });
  const crop = cropForRecord(subject);
  const pack = buildPack(subject);
  const events = cropBackedRecordEvents(subject, crop);
  const shotsDir = join(subject.runDir, "shots");
  const manifestPath = join(shotsDir, "manifest.json");
  const manifest = readJson(manifestPath);
  const shot = manifest.targets
    .flatMap((target) => target.shots || [])
    .find((candidate) => candidate.cropId === crop.cropId && candidate.sourceAssetId === crop.sourceAssetId);
  const outside = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-external-crop-"));
  const externalPath = join(outside, basename(crop.path));
  writeFileSync(externalPath, readFileSync(crop.path));
  const link = join(shotsDir, "link");
  symlinkSync(outside, link);
  const linkedPath = join(link, basename(crop.path));
  crop.path = linkedPath;
  shot.path = linkedPath;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  subject.run = finalizeCaptureRun(join(subject.runDir, "run.json"), subject.run, manifest, shotsDir);

  assert.throws(
    () => loadCompletedCaptureRun(subject.runDir, subject.cfg),
    (error) => error.message.includes(linkedPath) && /symlink component/i.test(error.message),
  );

  const lease = acquireLibraryLock(subject.cfg, subject.stateDir);
  try {
    assert.throws(
      () => persistReviewCrops({
        cfg: subject.cfg,
        libraryLease: lease,
        runDir: subject.runDir,
        run: subject.run,
        events,
        reviewPath: join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json"),
        combinedEvents: events,
        finalization: cropReviewFinalization(subject, pack, events),
      }),
      (error) => error.message.includes(linkedPath) && /symlink component/i.test(error.message),
    );
  } finally {
    releaseLibraryLock(lease);
  }
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "review-crops.journal.json")), false);
});

test("same-purpose crops from two assets of one target persist and resolve independently", () => {
  const subject = fixture({ count: 6, assetsByTarget: { anchor: 2 } });
  const manifestPath = join(subject.runDir, "shots", "manifest.json");
  const captureManifest = readJson(manifestPath);
  const target = captureManifest.targets.find((entry) => entry.id === "anchor");
  target.shots[1].variant = "alternate";
  const configuredTarget = subject.cfg.routes.find((entry) => entry.id === "anchor");
  const sourceAssetIds = target.shots.map((shot) => assetIdFor(configuredTarget, shot, captureManifest, subject.cfg));
  const region = { x: 0.1, y: 0.2, w: 0.4, h: 0.3, normalized: true };
  const purpose = `record-shared-${randomUUID()}`;
  const produced = produceCrops({
    captureManifest,
    cfg: subject.cfg,
    shotsDir: join(subject.runDir, "shots"),
    cropRequests: sourceAssetIds.map((assetId) => ({ assetId, rect: region, purpose })),
  });
  assert.deepEqual(produced.errors, []);
  assert.equal(produced.produced.length, 2);
  assert.ok(produced.produced.every((crop) => crop.cropId === purpose));
  writeFileSync(manifestPath, JSON.stringify(captureManifest, null, 2));
  subject.run = finalizeCaptureRun(join(subject.runDir, "run.json"), subject.run, captureManifest, join(subject.runDir, "shots"));

  const finalFindings = produced.produced.map((crop) => ({
    ...validEngineFinding({ id: randomUUID(), targetId: "anchor", assetId: crop.sourceAssetId }),
    region: crop.rect,
    cropId: crop.cropId,
    cropDigest: HASH(readFileSync(crop.path)),
    verifierVerdict: "confirmed",
    disposition: "accepted",
  }));
  const events = [
    recordHeaderFor(subject),
    ...finalFindings.map(({ verifierVerdict, disposition, ...finding }) => ({
      kind: "initial", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", finding,
    })),
    ...finalFindings.map((finding) => ({
      kind: "verification", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:02.000Z",
      findingId: finding.id, verifierVerdict: finding.verifierVerdict, evidence: "The asset-specific crop verifies this fixture finding.",
    })),
    ...finalFindings.map((finding) => ({
      kind: "disposition", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:03.000Z", finding,
    })),
    {
      kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:04.000Z",
      findingCount: finalFindings.length, findingIds: finalFindings.map((finding) => finding.id),
    },
  ];
  const result = recordCropEvents(subject, events);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const durableCropRoot = join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review-crops");
  const durableCrops = regularFilesUnder(durableCropRoot);
  assert.equal(durableCrops.length, 2);
  assert.deepEqual(
    durableCrops.map((path) => HASH(readFileSync(path))).sort(),
    finalFindings.map((finding) => finding.cropDigest).sort(),
  );
});

test("a sequence-invalid crop record publishes nothing, so a valid retry can claim the same cropId", () => {
  const subject = fixture({ count: 6 });
  const crop = cropForRecord(subject);
  const valid = cropBackedRecordEvents(subject, crop);
  const invalid = valid.filter((event) => event.kind !== "verification");
  const durableCropRoot = join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review-crops");

  const rejected = recordCropEvents(subject, invalid);
  assert.notEqual(rejected.status, 0, rejected.stdout);
  assert.match(rejected.stderr, /review event sequence is invalid/i);
  assert.equal(existsSync(durableCropRoot), false, "combined-log validation must run before crop publication");

  const accepted = recordCropEvents(subject, valid);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  assert.equal(existsSync(durableCropRoot), true);
});

test("a failure after crop staging but before review commit leaves no final crop and the same cropId retries", () => {
  const subject = fixture({ count: 6 });
  const crop = cropForRecord(subject);
  const events = cropBackedRecordEvents(subject, crop);
  const pack = buildPack(subject);
  const durableRun = join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId);
  const durableCropRoot = join(durableRun, "review-crops");
  const lease = acquireLibraryLock(subject.cfg, subject.stateDir);
  let publication;
  try {
    assert.throws(
      () => appendReviewRecord(events, {
        projectRoot: subject.cfg.root,
        stateDir: subject.stateDir,
        targetIds: subject.cfg.routes.map((route) => route.id),
        capturedTargetIds: subject.run.targetIds,
        capturedTargetOutcomes: subject.run.targetOutcomes,
        capturedTargetShotHashes: subject.run.targetShotHashes,
        beforeCommit(context) {
          publication = persistReviewCrops({
            cfg: subject.cfg,
            libraryLease: lease,
            runDir: subject.runDir,
            run: subject.run,
            events,
            reviewPath: context.path,
            combinedEvents: context.combinedEvents,
            finalization: cropReviewFinalization(subject, pack, context.combinedEvents),
          });
          throw new Error("fixture failure before review commit");
        },
        afterCommit() {
          publication.commit();
        },
      }),
      /fixture failure before review commit/,
    );
  } finally {
    releaseLibraryLock(lease);
  }
  assert.equal(existsSync(join(durableRun, "review.json")), false);
  assert.equal(existsSync(durableCropRoot), false, "staging must not reserve a final append-only crop path");

  const retry = recordCropEvents(subject, events);
  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  assert.equal(existsSync(durableCropRoot), true);
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "review-crops.journal.json")), false);
});

test("ui-review --record validates an invalid capture before creating run-local judge state", () => {
  const subject = fixture({ count: 3 });
  const invalidRunDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-invalid-run-"));
  const events = [
    recordHeaderFor(subject),
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", findingCount: 0, findingIds: [] },
  ];
  const eventsPath = join(subject.root, "invalid-run-events.json");
  writeFileSync(eventsPath, JSON.stringify(events, null, 2));

  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--record", eventsPath, "--run", invalidRunDir, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
  );

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /completed capture run\.json not found/);
  assert.deepEqual(readdirSync(invalidRunDir), [], "invalid capture validation must not create judge/ or a judge lock");
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name)), false, "invalid capture validation must precede external record-state creation");
});

test("packless ui-review --record succeeds without writing inside a read-only capture", () => {
  const subject = fixture({ count: 3 });
  const events = [
    recordHeaderFor(subject),
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", findingCount: 0, findingIds: [] },
  ];
  const eventsPath = join(subject.root, "packless-read-only-events.json");
  writeFileSync(eventsPath, JSON.stringify(events, null, 2));
  const captureFilesBefore = regularFilesUnder(subject.runDir).map((path) => ({
    path: relative(subject.runDir, path),
    digest: HASH(readFileSync(path)),
  }));
  let result;
  chmodSync(subject.runDir, 0o555);
  try {
    result = spawnSync(
      process.execPath,
      [UI_REVIEW, "--config", subject.configPath, "--record", eventsPath, "--run", subject.runDir, "--json"],
      { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
    );
  } finally {
    chmodSync(subject.runDir, 0o700);
  }

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(
    regularFilesUnder(subject.runDir).map((path) => ({ path: relative(subject.runDir, path), digest: HASH(readFileSync(path)) })),
    captureFilesBefore,
    "packless recording must leave every capture file byte-identical",
  );
  assert.equal(existsSync(join(subject.runDir, "judge")), false, "packless recording must not create run-local judge state");
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), true);
});

test("lagging sealed finalization rejects a non-replay batch and still accepts an exact replay", () => {
  const subject = fixture({ count: 3 });
  const committedEvents = [
    recordHeaderFor(subject),
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", findingCount: 0, findingIds: [] },
  ];
  const review = appendReviewRecord(committedEvents, {
    projectRoot: subject.cfg.root,
    stateDir: subject.stateDir,
    targetIds: subject.cfg.routes.map((route) => route.id),
    capturedTargetIds: subject.run.targetIds,
    capturedTargetOutcomes: subject.run.targetOutcomes,
    capturedTargetShotHashes: subject.run.targetShotHashes,
  });
  const committedBytes = readFileSync(review.path);
  const cursorPath = join(subject.stateDir, subject.cfg.name, "judgments", "latest.json");
  assert.equal(existsSync(cursorPath), false, "the fixture starts with lagging finalization");

  const nonReplayEvents = [
    committedEvents[0],
    { ...committedEvents[1], eventId: randomUUID(), at: "2026-08-11T00:00:02.000Z" },
  ];
  const rejected = recordCropEvents(subject, nonReplayEvents);
  assert.notEqual(rejected.status, 0, rejected.stdout);
  assert.match(rejected.stderr, /seal must be the final event/i);
  assert.equal(readFileSync(review.path).equals(committedBytes), true, "the rejected batch must append zero events");
  assert.equal(existsSync(cursorPath), false, "a non-replay against a sealed log must have no finalization side effects");

  const replayed = recordCropEvents(subject, committedEvents);
  assert.equal(replayed.status, 0, replayed.stderr || replayed.stdout);
  assert.equal(JSON.parse(replayed.stdout).review.appended, 0);
  assert.equal(readFileSync(review.path).equals(committedBytes), true, "an exact replay must remain byte-idempotent");
  assert.equal(readJson(cursorPath).sequence, 1, "an exact replay must not advance the finalized cursor twice");
});

test("sealed run replay and failed non-replay cannot roll a newer not-judged cursor back", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-shared-project-"));
  const runA = fixture({ count: 3, root });
  const eventsA = [
    recordHeaderFor(runA),
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", findingCount: 0, findingIds: [] },
  ];
  const sealedA = recordCropEvents(runA, eventsA);
  assert.equal(sealedA.status, 0, sealedA.stderr || sealedA.stdout);

  const runB = fixture({ count: 3, root, project: runA.cfg.name });
  runB.stateDir = runA.stateDir;
  const unresolved = validEngineFinding({
    id: "31313131-3131-4131-8131-313131313131",
    targetId: "peer",
    assetId: "peer/dark/full/base",
  });
  const { verifierVerdict, disposition, ...initialFinding } = unresolved;
  const eventsB = [
    recordHeaderFor(runB),
    { kind: "initial", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", finding: initialFinding },
    { kind: "verification", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:02.000Z", findingId: unresolved.id, verifierVerdict, evidence: "The fake evidence remains unresolved." },
    { kind: "disposition", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:03.000Z", finding: unresolved },
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:04.000Z", findingCount: 1, findingIds: [unresolved.id] },
  ];
  const sealedB = recordCropEvents(runB, eventsB);
  assert.equal(sealedB.status, 0, sealedB.stderr || sealedB.stdout);

  const cursorPath = join(runA.stateDir, runA.cfg.name, "judgments", "latest.json");
  const newerCursor = readFileSync(cursorPath);
  const newerPeer = readJson(cursorPath).targets.peer;
  assert.equal(newerPeer.runId, runB.run.runId);
  assert.equal(newerPeer.disposition, "not-judged");

  const nonReplay = [
    eventsA[0],
    { ...eventsA[1], eventId: randomUUID(), at: "2026-08-11T00:00:05.000Z" },
  ];
  const rejected = recordCropEvents(runA, nonReplay);
  assert.notEqual(rejected.status, 0, rejected.stdout);
  assert.match(rejected.stderr, /seal must be the final event/i);
  assert.equal(readFileSync(cursorPath).equals(newerCursor), true, "failed non-replay finalization must leave the newer cursor byte-identical");

  const replayed = recordCropEvents(runA, eventsA);
  assert.equal(replayed.status, 0, replayed.stderr || replayed.stdout);
  assert.equal(JSON.parse(replayed.stdout).review.appended, 0);
  assert.equal(readFileSync(cursorPath).equals(newerCursor), true, "exact replay of run A must not demote run B's judgment");
  assert.equal(readJson(cursorPath).targets.peer.disposition, "not-judged");
});

test("late journal recovery cannot replace a newer run's cursor judgment", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-shared-project-"));
  const runA = fixture({ count: 6, root });
  leaveCommittedCropJournal(runA);
  const journalPath = join(runA.stateDir, runA.cfg.name, "review-crops.journal.json");
  const journal = readJson(journalPath);
  assert.ok(journal.finalization.targets.every((target) => target.judgedAt === 1));
  const journalBytes = readFileSync(journalPath);
  rmSync(journalPath);

  const runB = fixture({ count: 6, root, project: runA.cfg.name });
  runB.stateDir = runA.stateDir;
  sealJudgmentState(runB.cfg, {
    stateDir: runB.stateDir,
    targets: journal.finalization.targets.map((target) => ({
      ...target,
      runId: runB.run.runId,
      judgedAt: target.judgedAt + 1,
      disposition: "not-judged",
    })),
  });
  const newerCursor = readFileSync(join(runB.stateDir, runB.cfg.name, "judgments", "latest.json"));
  writeFileSync(journalPath, journalBytes);

  const recovered = readJudgmentState(runB.cfg, { stateDir: runB.stateDir });
  assert.equal(existsSync(journalPath), false);
  assert.equal(recovered.sequence, 2);
  assert.ok(Object.values(recovered.targets).every((target) =>
    target.runId === runB.run.runId && target.judgedAt === 2 && target.disposition === "not-judged"));
  assert.equal(
    readFileSync(join(runB.stateDir, runB.cfg.name, "judgments", "latest.json")).equals(newerCursor),
    true,
    "late run A recovery must leave run B's cursor byte-identical",
  );
});

test("a committed review with interrupted crop promotion finalizes pack and cursor on --record retry idempotently", () => {
  const subject = fixture({ count: 6 });
  const crop = finalizedVerificationCrop(subject);
  const pack = buildPack(subject);
  const events = cropBackedRecordEvents(subject, crop);
  const durableRun = join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId);
  const durableCropRoot = join(durableRun, "review-crops");
  const journalPath = join(subject.stateDir, subject.cfg.name, "review-crops.journal.json");
  const cursorPath = join(subject.stateDir, subject.cfg.name, "judgments", "latest.json");
  const lease = acquireLibraryLock(subject.cfg, subject.stateDir);
  let publication;
  try {
    assert.throws(
      () => appendReviewRecord(events, {
        projectRoot: subject.cfg.root,
        stateDir: subject.stateDir,
        targetIds: subject.cfg.routes.map((route) => route.id),
        capturedTargetIds: subject.run.targetIds,
        capturedTargetOutcomes: subject.run.targetOutcomes,
        capturedTargetShotHashes: subject.run.targetShotHashes,
        beforeCommit(context) {
          publication = persistReviewCrops({
            cfg: subject.cfg,
            libraryLease: lease,
            runDir: subject.runDir,
            run: subject.run,
            events,
            reviewPath: context.path,
            combinedEvents: context.combinedEvents,
            finalization: cropReviewFinalization(subject, pack, context.combinedEvents),
          });
        },
        afterCommit() {
          assert.ok(publication);
          throw new Error("fixture failure before crop promotion");
        },
      }),
      /fixture failure before crop promotion/,
    );
  } finally {
    releaseLibraryLock(lease);
  }
  assert.equal(existsSync(join(durableRun, "review.json")), true, "the review log is the transaction commit");
  assert.equal(existsSync(durableCropRoot), false);
  assert.equal(existsSync(journalPath), true);
  assert.deepEqual(readJson(pack.path).judgedFingerprints, {}, "the crash must precede the pack mirror");
  assert.equal(existsSync(cursorPath), false, "the crash must precede the judgment cursor");

  const retry = recordCropEvents(subject, events);
  assert.equal(retry.status, 0, retry.stderr || retry.stdout);
  const retriedReview = JSON.parse(retry.stdout).review;
  assert.equal(retriedReview.appended, 0);
  assert.match(retriedReview.finalization.note, /finalized from committed log/);
  const [durableCrop] = regularFilesUnder(durableCropRoot);
  assert.equal(HASH(readFileSync(durableCrop)), events.find((event) => event.kind === "disposition").finding.cropDigest);
  assert.equal(existsSync(journalPath), false);
  const finalizedPack = readJson(pack.path);
  assert.deepEqual(finalizedPack.judgedFingerprints, Object.fromEntries(
    Object.entries(finalizedPack.targetFingerprints).map(([targetId, fingerprint]) => [targetId, {
      fingerprint,
      ...finalizedPack.targetJudgmentEvidence[targetId],
      disposition: targetId === crop.sourceAssetId.split("/", 1)[0] ? "accepted" : "clean",
    }]),
  ));
  const finalizedCursor = readJson(cursorPath);
  assert.equal(finalizedCursor.sequence, 1);
  assert.ok(Object.values(finalizedCursor.targets).every((target) => target.runId === subject.run.runId));

  const packBytes = readFileSync(pack.path);
  const cursorBytes = readFileSync(cursorPath);
  const secondRetry = recordCropEvents(subject, events);
  assert.equal(secondRetry.status, 0, secondRetry.stderr || secondRetry.stdout);
  const secondReview = JSON.parse(secondRetry.stdout).review;
  assert.equal(secondReview.appended, 0);
  assert.match(secondReview.finalization.note, /already finalized/);
  assert.equal(readFileSync(pack.path).equals(packBytes), true, "double finalization must not rewrite the pack");
  assert.equal(readFileSync(cursorPath).equals(cursorBytes), true, "double finalization must not advance the cursor");
});

test("judge-pack rebuild finalizes an interrupted committed review against its executed pack before replacing it", () => {
  const subject = fixture({ count: 6 });
  const crop = finalizedVerificationCrop(subject);
  const executed = buildPack(subject);
  const events = cropBackedRecordEvents(subject, crop);
  const finalization = cropReviewFinalization(subject, executed, events);
  const journalPath = join(subject.stateDir, subject.cfg.name, "review-crops.journal.json");
  const cursorPath = join(subject.stateDir, subject.cfg.name, "judgments", "latest.json");
  const lease = acquireLibraryLock(subject.cfg, subject.stateDir);
  try {
    assert.throws(
      () => appendReviewRecord(events, {
        projectRoot: subject.cfg.root,
        stateDir: subject.stateDir,
        targetIds: subject.cfg.routes.map((route) => route.id),
        capturedTargetIds: subject.run.targetIds,
        capturedTargetOutcomes: subject.run.targetOutcomes,
        capturedTargetShotHashes: subject.run.targetShotHashes,
        beforeCommit(context) {
          persistReviewCrops({
            cfg: subject.cfg,
            libraryLease: lease,
            runDir: subject.runDir,
            run: subject.run,
            events,
            reviewPath: context.path,
            combinedEvents: context.combinedEvents,
            finalization,
          });
        },
        afterCommit() {
          throw new Error("fixture crash after committed review");
        },
      }),
      /fixture crash after committed review/,
    );
  } finally {
    releaseLibraryLock(lease);
  }
  assert.equal(readJson(journalPath).finalization.packId, executed.pack.packId);
  assert.equal(existsSync(cursorPath), false);

  const bundlePath = join(subject.runDir, "bundle.json");
  const bundle = readJson(bundlePath);
  bundle.judgeContext.anchor.intentExcerpts = ["Changed only after the executed judgment was committed."];
  writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

  let observedFinalizedOriginal = false;
  const rebuilt = buildPack(subject, {
    writeRootManifest(path, next) {
      const original = readJson(path);
      assert.equal(original.packId, executed.pack.packId);
      assert.deepEqual(original.judgedFingerprints, Object.fromEntries(finalization.targets.map((target) => [target.targetId, {
        fingerprint: target.fingerprint,
        baseEvidenceDigest: target.baseEvidenceDigest,
        evidenceDigest: target.evidenceDigest,
        rubricDigest: target.rubricDigest,
        promptDigests: target.promptDigests,
        disposition: target.disposition,
      }])));
      observedFinalizedOriginal = true;
      writeJsonAtomic(path, next);
    },
  });
  assert.equal(observedFinalizedOriginal, true, "recovery must finalize the original root pack before replacement");
  assert.equal(existsSync(journalPath), false);
  assert.notEqual(rebuilt.pack.packId, executed.pack.packId);
  assert.ok(rebuilt.pack.targets.includes("anchor"), "changed post-execution context should make the rebuilt pack bind new evidence");

  const cursor = readJson(cursorPath);
  for (const target of finalization.targets) {
    const { judgedAt, ...sealed } = cursor.targets[target.targetId];
    assert.equal(judgedAt, 1);
    assert.deepEqual(sealed, {
      fingerprint: target.fingerprint,
      baseEvidenceDigest: target.baseEvidenceDigest,
      evidenceDigest: target.evidenceDigest,
      rubricDigest: target.rubricDigest,
      promptDigests: target.promptDigests,
      runId: target.runId,
      disposition: target.disposition,
    });
  }
  assert.notEqual(
    cursor.targets.anchor.evidenceDigest,
    rebuilt.pack.targetJudgmentEvidence.anchor.evidenceDigest,
    "the sealed cursor must retain executed prompt/evidence digests, not the rebuilt pack's digests",
  );
});

test("judge-pack rebuild finalizes an interrupted clean review with no crops against its executed pack", () => {
  const subject = fixture({ count: 6 });
  const executed = buildPack(subject);
  const events = [
    recordHeaderFor(subject),
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", findingCount: 0, findingIds: [] },
  ];
  const finalization = cropReviewFinalization(subject, executed, events);
  const journalPath = join(subject.stateDir, subject.cfg.name, "review-crops.journal.json");
  const cursorPath = join(subject.stateDir, subject.cfg.name, "judgments", "latest.json");
  const lease = acquireLibraryLock(subject.cfg, subject.stateDir);
  try {
    assert.throws(
      () => appendReviewRecord(events, {
        projectRoot: subject.cfg.root,
        stateDir: subject.stateDir,
        targetIds: subject.cfg.routes.map((route) => route.id),
        capturedTargetIds: subject.run.targetIds,
        capturedTargetOutcomes: subject.run.targetOutcomes,
        capturedTargetShotHashes: subject.run.targetShotHashes,
        beforeCommit(context) {
          persistReviewCrops({
            cfg: subject.cfg,
            libraryLease: lease,
            runDir: subject.runDir,
            run: subject.run,
            events,
            reviewPath: context.path,
            combinedEvents: context.combinedEvents,
            finalization,
          });
        },
        afterCommit() {
          throw new Error("fixture crash before clean review finalization");
        },
      }),
      /fixture crash before clean review finalization/,
    );
  } finally {
    releaseLibraryLock(lease);
  }

  const journal = readJson(journalPath);
  assert.deepEqual(journal.entries, []);
  assert.equal(journal.finalization.packId, executed.pack.packId);
  assert.equal(existsSync(cursorPath), false);
  assert.deepEqual(readJson(executed.path).judgedFingerprints, {});

  const bundlePath = join(subject.runDir, "bundle.json");
  const bundle = readJson(bundlePath);
  bundle.judgeContext.anchor.intentExcerpts = ["Changed only after the clean judgment committed."];
  writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

  let observedFinalizedOriginal = false;
  const rebuilt = buildPack(subject, {
    writeRootManifest(path, next) {
      const original = readJson(path);
      assert.equal(original.packId, executed.pack.packId);
      assert.deepEqual(original.judgedFingerprints, judgedFingerprints(original));
      observedFinalizedOriginal = true;
      writeJsonAtomic(path, next);
    },
  });
  assert.equal(observedFinalizedOriginal, true, "recovery must finalize the executed clean pack before replacement");
  assert.equal(existsSync(journalPath), false);
  assert.notEqual(rebuilt.pack.packId, executed.pack.packId);
  assert.ok(rebuilt.pack.targets.includes("anchor"));

  const cursor = readJson(cursorPath);
  for (const target of finalization.targets) {
    const { judgedAt, ...sealed } = cursor.targets[target.targetId];
    assert.equal(judgedAt, 1);
    assert.deepEqual(sealed, {
      fingerprint: target.fingerprint,
      baseEvidenceDigest: target.baseEvidenceDigest,
      evidenceDigest: target.evidenceDigest,
      rubricDigest: target.rubricDigest,
      promptDigests: target.promptDigests,
      runId: target.runId,
      disposition: "clean",
    });
  }
  assert.notEqual(cursor.targets.anchor.evidenceDigest, rebuilt.pack.targetJudgmentEvidence.anchor.evidenceDigest);
});

test("an operation on run B finalizes run A's committed crop journal and then proceeds", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-shared-project-"));
  const runA = fixture({ count: 6, root });
  const runB = fixture({ count: 6, root, project: runA.cfg.name });
  runB.stateDir = runA.stateDir;
  const pending = leaveCommittedCropJournal(runA);
  const journalPath = join(runA.stateDir, runA.cfg.name, "review-crops.journal.json");
  const durableCropRoot = join(runA.stateDir, runA.cfg.name, "runs", runA.run.runId, "review-crops");
  assert.equal(existsSync(journalPath), true);

  runB.run.targetFingerprints.peer = { fingerprint: `sha256:${"f".repeat(64)}` };
  writeFileSync(join(runB.runDir, "run.json"), JSON.stringify(runB.run, null, 2));
  const builtB = buildPack(runB);

  assert.equal(existsSync(journalPath), false);
  assert.ok(builtB.pack.targets.includes("peer"), "the requested run B judge operation must continue after recovery");
  const [durableCrop] = regularFilesUnder(durableCropRoot);
  assert.equal(HASH(readFileSync(durableCrop)), pending.events.find((event) => event.kind === "disposition").finding.cropDigest);
  const cursor = readJudgmentState(runB.cfg, { stateDir: runB.stateDir });
  assert.ok(Object.values(cursor.targets).every((target) => target.runId === runA.run.runId));
});

test("a deleted run A capture directory cannot block journal recovery or a run B operation", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-shared-project-"));
  const runA = fixture({ count: 6, root });
  const runB = fixture({ count: 6, root, project: runA.cfg.name });
  runB.stateDir = runA.stateDir;
  leaveCommittedCropJournal(runA);
  const journalPath = join(runA.stateDir, runA.cfg.name, "review-crops.journal.json");
  rmSync(runA.runDir, { recursive: true, force: true });

  const recovered = readJudgmentState(runB.cfg, { stateDir: runB.stateDir });
  assert.ok(Object.values(recovered.targets).every((target) => target.runId === runA.run.runId));
  assert.equal(existsSync(journalPath), false);
  assert.doesNotThrow(() => buildPack(runB));
});

test("full per-target, per-phase clean coverage seals clean dispositions", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = stateDir;
  let engineCalls = 0;
  try {
    const result = await runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine(call) {
        engineCalls += 1;
        return initialEngineResponse(call);
      },
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(result.outcome, "recorded");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  assert.equal(engineCalls, pack.pack.batches.length);
  const state = readJson(join(stateDir, subject.cfg.name, "judgments", "latest.json"));
  assert.ok(Object.values(state.targets).every((target) => target.disposition === "clean"));
  const events = readFileSync(join(stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.kind), ["record-header", "seal"]);
  assert.equal(existsSync(join(stateDir, subject.cfg.name, "review-crops.journal.json")), false);
});

test("missing a batch target's coverage degrades to needs-agent without review events", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  const omittedTarget = pack.pack.batches[0].targetIds[0];
  let engineCalls = 0;
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = stateDir;
  try {
    await assert.rejects(
      () => runJudge({
        packPath: pack.path,
        configPath: subject.configPath,
        engine(call) {
          engineCalls += 1;
          const response = JSON.parse(initialEngineResponse(call));
          response.coverage = response.coverage.filter((entry) => entry.targetId !== omittedTarget);
          return JSON.stringify(response);
        },
      }),
      (error) => error instanceof JudgeExecutorError && /coverage.*missing/.test(error.message),
    );
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  assert.equal(engineCalls, 1);
  assert.equal(existsSync(join(stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
  const updated = readJson(pack.path);
  const outcome = updated.artifacts.find((path) => path.endsWith("executor-outcome.json"));
  assert.equal(readJson(join(subject.runDir, outcome)).outcome, "needs-agent");
});

test("a finding whose coverage says clean degrades to needs-agent without review events", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  let engineCalls = 0;
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = stateDir;
  try {
    await assert.rejects(
      () => runJudge({
        packPath: pack.path,
        configPath: subject.configPath,
        engine(call) {
          engineCalls += 1;
          const image = readJson(join(subject.runDir, call.batch.imageList)).images.find((entry) => !entry.referenceOnly);
          const response = JSON.parse(initialEngineResponse(call, [validEngineFinding({
            id: "90909090-9090-4090-8090-909090909090",
            targetId: image.targetId,
            assetId: image.assetId,
          })]));
          response.coverage.find((entry) => entry.targetId === image.targetId && entry.phase === "consistency").result = "clean";
          return JSON.stringify(response);
        },
      }),
      (error) => error instanceof JudgeExecutorError && /requires coverage .*consistency.*result findings/.test(error.message),
    );
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  assert.equal(engineCalls, 1);
  assert.equal(existsSync(join(stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
  const outcome = readJson(pack.path).artifacts.find((path) => path.endsWith("executor-outcome.json"));
  assert.equal(readJson(join(subject.runDir, outcome)).outcome, "needs-agent");
});

test("a finding with an unknown ruleId phase prefix degrades to needs-agent without review events", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = stateDir;
  try {
    await assert.rejects(
      () => runJudge({
        packPath: pack.path,
        configPath: subject.configPath,
        engine(call) {
          const image = readJson(join(subject.runDir, call.batch.imageList)).images.find((entry) => !entry.referenceOnly);
          return initialEngineResponse(call, [{
            ...validEngineFinding({
              id: "91919191-9191-4191-8191-919191919191",
              targetId: image.targetId,
              assetId: image.assetId,
            }),
            ruleId: "unknown-phase/spacing",
          }]);
        },
      }),
      (error) => error instanceof JudgeExecutorError && /canonical checklist phase prefix/.test(error.message),
    );
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  assert.equal(existsSync(join(stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
  const outcome = readJson(pack.path).artifacts.find((path) => path.endsWith("executor-outcome.json"));
  assert.equal(readJson(join(subject.runDir, outcome)).outcome, "needs-agent");
});

test("a not-judged checklist phase persists and reselects its target", async () => {
  const subject = fixture({ count: 3 });
  const pack = buildPack(subject);
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = stateDir;
  try {
    const result = await runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine: (call) => initialEngineResponse(call, [], {
        notJudged: call.batch.targetIds.includes("peer")
          ? [{ targetId: "peer", phase: "accessibility" }]
          : [],
      }),
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(result.outcome, "recorded");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  const state = readJson(join(stateDir, subject.cfg.name, "judgments", "latest.json"));
  assert.equal(state.targets.peer.disposition, "not-judged");
  const events = readFileSync(join(stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(events.some((event) => event.kind === "disposition" && event.finding.targetId === "peer" && event.finding.disposition === "not-judged"));

  const recapture = fixture({ count: 3, root: subject.root, project: subject.cfg.name });
  recapture.stateDir = stateDir;
  assert.deepEqual(buildPack(recapture).pack.targets, ["peer"]);
});

test("ui-judge rejects replacement capture fingerprints before invoking the engine", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const replaced = readJson(join(subject.runDir, "run.json"));
  replaced.targetFingerprints.peer = { fingerprint: `sha256:${"f".repeat(64)}` };
  writeFileSync(join(subject.runDir, "run.json"), JSON.stringify(replaced, null, 2));
  let engineCalls = 0;
  await assert.rejects(
    () => runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine() {
        engineCalls += 1;
        return "unreachable";
      },
    }),
    (error) => error instanceof JudgeExecutorError && /fingerprints.*peer/.test(error.message),
  );
  assert.equal(engineCalls, 0);
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
  assert.equal(readJson(pack.path).artifacts.some((path) => path.endsWith("executor-outcome.json")), false);
});

test("ui-judge rejects replacement captured asset bytes before invoking the engine", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const asset = replaceCapturedShot(subject, "peer");
  let engineCalls = 0;
  await assert.rejects(
    () => runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine() {
        engineCalls += 1;
        return "unreachable";
      },
    }),
    (error) => error instanceof JudgeExecutorError && new RegExp(`asset hashes.*peer/${asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(error.message),
  );
  assert.equal(engineCalls, 0);
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
  assert.equal(readJson(pack.path).artifacts.some((path) => path.endsWith("executor-outcome.json")), false);
});

test("ui-judge rejects replacement captured asset bytes between judging and recording", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  let initialCalls = 0;
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = stateDir;
  try {
    await assert.rejects(
      () => runJudge({
        packPath: pack.path,
        configPath: subject.configPath,
        engine(call) {
          assert.equal(call.phase, "initial");
          initialCalls += 1;
          const response = initialEngineResponse(call);
          if (initialCalls === pack.pack.batches.length) replaceCapturedShot(subject, "peer");
          return response;
        },
      }),
      (error) => error instanceof JudgeExecutorError && /captured asset hashes.*peer\//.test(error.message),
    );
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  assert.equal(initialCalls, pack.pack.batches.length);
  assert.equal(existsSync(join(stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
  assert.equal(readJson(pack.path).artifacts.some((path) => path.endsWith("executor-outcome.json")), false);
});

test("ui-review --record rejects a stale judge pack before writing review state", () => {
  const subject = fixture({ count: 6 });
  buildPack(subject);
  const asset = replaceCapturedShot(subject, "peer");
  const eventsPath = join(subject.root, "stale-pack-events.json");
  writeFileSync(eventsPath, JSON.stringify([
    recordHeaderFor(subject),
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", findingCount: 0, findingIds: [] },
  ], null, 2));
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--record", eventsPath, "--run", subject.runDir, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
  );
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, new RegExp(`captured asset hashes.*peer/${asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
});

test("ui-review --record rejects a mutated packed resized image before durable writes", () => {
  const subject = fixture({ count: 6 });
  const built = buildPack(subject);
  const batch = built.pack.batches[0];
  const image = readJson(join(subject.runDir, batch.imageList)).images[0];
  const packDigest = HASH(readFileSync(built.path));
  writeFileSync(join(subject.runDir, image.image), png(31, 17, 0xa7));
  const eventsPath = join(subject.root, "mutated-packed-image-events.json");
  writeFileSync(eventsPath, JSON.stringify([
    recordHeaderFor(subject),
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", findingCount: 0, findingIds: [] },
  ], null, 2));

  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--record", eventsPath, "--run", subject.runDir, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
  );

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, new RegExp(`image list ${batch.id} image 0.*${image.image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*digest`, "i"));
  assert.equal(HASH(readFileSync(built.path)), packDigest, "artifact rejection must not rewrite the pack");
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "judgments", "latest.json")), false);
});

test("ui-review --record rejects a mutated packed rendered prompt before durable writes", () => {
  const subject = fixture({ count: 6 });
  const built = buildPack(subject);
  const batch = built.pack.batches[0];
  const promptPath = join(subject.runDir, batch.prompt);
  const packDigest = HASH(readFileSync(built.path));
  writeFileSync(promptPath, `${readFileSync(promptPath, "utf8")}\n<!-- manual-record mutation -->\n`);
  const eventsPath = join(subject.root, "mutated-packed-prompt-events.json");
  writeFileSync(eventsPath, JSON.stringify([
    recordHeaderFor(subject),
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", findingCount: 0, findingIds: [] },
  ], null, 2));

  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--record", eventsPath, "--run", subject.runDir, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
  );

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, new RegExp(`prompt for batch ${batch.id}.*${batch.prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*digest`, "i"));
  assert.equal(HASH(readFileSync(built.path)), packDigest, "prompt rejection must not rewrite the pack");
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "judgments", "latest.json")), false);
});

test("ui-review --record rejects a legacy judge pack without evidence before durable writes", () => {
  const subject = fixture({ count: 3 });
  const built = buildPack(subject);
  const legacyPack = readJson(built.path);
  delete legacyPack.targetJudgmentEvidence;
  assert.equal(validateJudgePack(legacyPack).valid, true, "judgepack.v1 keeps the evidence map optional for legacy readers");
  writeFileSync(built.path, JSON.stringify(legacyPack, null, 2));

  const eventsPath = join(subject.root, "legacy-pack-events.json");
  writeFileSync(eventsPath, JSON.stringify([
    recordHeaderFor(subject),
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", findingCount: 0, findingIds: [] },
  ], null, 2));
  const runFilesBefore = regularFilesUnder(subject.runDir).map((path) => ({
    path: relative(subject.runDir, path),
    digest: HASH(readFileSync(path)),
  }));
  const stateFilesBefore = regularFilesUnder(subject.stateDir).map((path) => relative(subject.stateDir, path));

  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--record", eventsPath, "--run", subject.runDir, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
  );

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /legacy judge pack.*missing target judgment evidence.*rebuild the judge pack.*ui-review --judge-pack --run/i);
  assert.doesNotMatch(result.stderr, /TypeError|Cannot read properties/);
  assert.deepEqual(
    regularFilesUnder(subject.runDir).map((path) => ({ path: relative(subject.runDir, path), digest: HASH(readFileSync(path)) })),
    runFilesBefore,
    "legacy-pack rejection must leave the capture and pack byte-identical",
  );
  assert.deepEqual(
    regularFilesUnder(subject.stateDir).map((path) => relative(subject.stateDir, path)),
    stateFilesBefore,
    "legacy-pack rejection must not create review, crop, journal, cursor, or lock state",
  );
});

test("ui-review --record rejects a manual header whose targets exceed the selected judge pack", () => {
  const subject = fixture({ count: 3 });
  retainAnchorLatest(subject);
  buildPack(subject, { targetIds: ["peer"] });
  const header = recordHeaderFor(subject);
  header.targets = ["peer", "third"];
  header.targetShotHashes = {
    peer: subject.run.targetShotHashes.peer,
    third: subject.run.targetShotHashes.third,
  };
  const eventsPath = join(subject.root, "extra-header-target-events.json");
  writeFileSync(eventsPath, JSON.stringify([
    header,
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", findingCount: 0, findingIds: [] },
  ], null, 2));
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--record", eventsPath, "--run", subject.runDir, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
  );
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /judge pack targets do not exactly match/i);
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
});

test("ui-review --record rejects a fingerprint-swapped run after pack build without appending", () => {
  const subject = fixture({ count: 6 });
  buildPack(subject);
  const swapped = readJson(join(subject.runDir, "run.json"));
  swapped.targetFingerprints.peer = { fingerprint: `sha256:${"f".repeat(64)}` };
  writeFileSync(join(subject.runDir, "run.json"), JSON.stringify(swapped, null, 2));
  const eventsPath = join(subject.root, "fingerprint-swapped-events.json");
  writeFileSync(eventsPath, JSON.stringify([
    recordHeaderFor(subject),
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", findingCount: 0, findingIds: [] },
  ], null, 2));
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--record", eventsPath, "--run", subject.runDir, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
  );
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /fingerprints.*peer/i);
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
});

test("ui-judge verifies an intact image-list mapping before clean fake-engine calls", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  for (const batch of pack.pack.batches) {
    assert.equal(batch.imageListDigest, HASH(readFileSync(join(subject.runDir, batch.imageList))));
  }
  let engineCalls = 0;
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  try {
    const result = await runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine(call) {
        engineCalls += 1;
        return initialEngineResponse(call);
      },
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(result.outcome, "recorded");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  assert.equal(engineCalls, pack.pack.batches.length);
});

test("ui-judge refuses a post-build batch prompt edit before the initial engine", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const batch = pack.pack.batches[0];
  const promptPath = join(subject.runDir, batch.prompt);
  writeFileSync(promptPath, `${readFileSync(promptPath, "utf8")}\n<!-- post-build mutation -->\n`);
  let engineCalls = 0;
  await assert.rejects(
    () => runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine() {
        engineCalls += 1;
        return "unreachable";
      },
    }),
    (error) => error instanceof JudgeExecutorError && error.hard === true && new RegExp(`prompt for batch ${batch.id}.*digest`, "i").test(error.message),
  );
  assert.equal(engineCalls, 0);
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
  assert.equal(readJson(pack.path).artifacts.some((path) => path.endsWith("executor-outcome.json")), false);
});

test("ui-judge refuses post-build exemplar metadata edits before the initial engine", async () => {
  const subject = fixture({ count: 6 });
  const exemplar = retainImmutableExemplar(subject);
  const pack = buildPack(subject, { exemplarDefinitions: [exemplar] });
  const edited = readJson(pack.path);
  edited.exemplars[0].expectedFindings = ["Post-build metadata must not alter the executed instructions."];
  assert.equal(validateJudgePack(edited).valid, true);
  writeFileSync(pack.path, JSON.stringify(edited, null, 2));

  let engineCalls = 0;
  await assert.rejects(
    () => runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine() {
        engineCalls += 1;
        return "unreachable";
      },
    }),
    (error) => error instanceof JudgeExecutorError && error.hard === true && /prompt for batch .*final rendered digest/i.test(error.message),
  );
  assert.equal(engineCalls, 0);
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
  assert.equal(readJson(pack.path).artifacts.some((path) => path.endsWith("executor-outcome.json")), false);
});

test("ui-judge rejects a relabeled image-list entry before the fake engine runs", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const listPath = join(subject.runDir, pack.pack.batches[0].imageList);
  const list = readJson(listPath);
  const original = list.images[0];
  const replacement = list.images.find((image) => image.image !== original.image);
  assert.ok(replacement, "fixture must include a second hashed attachment");
  // Leave the original target and asset labels intact while pointing them at a
  // different attachment whose bytes are already digest-bound elsewhere.
  original.image = replacement.image;
  original.sha256 = replacement.sha256;
  writeFileSync(listPath, JSON.stringify(list, null, 2));
  let engineCalls = 0;
  await assert.rejects(
    () => runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine() {
        engineCalls += 1;
        return "unreachable";
      },
    }),
    (error) => error instanceof JudgeExecutorError && /image list .*mapping digest/i.test(error.message),
  );
  assert.equal(engineCalls, 0);
});

test("ui-judge rejects an added post-pack non-verification asset before the fake engine runs", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const manifestPath = join(subject.runDir, "shots", "manifest.json");
  const manifest = readJson(manifestPath);
  const target = manifest.targets.find((entry) => entry.id === "peer");
  const extraPath = join(subject.runDir, "shots", "peer.dark.added-base.png");
  writeFileSync(extraPath, png(37, 19, 0xa9));
  target.shots.push({ path: extraPath, viewport: "fixture-dark-added", kind: "full" });
  subject.run = finalizeCaptureRun(join(subject.runDir, "run.json"), subject.run, manifest, join(subject.runDir, "shots"));
  let engineCalls = 0;
  await assert.rejects(
    () => runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine() {
        engineCalls += 1;
        return "unreachable";
      },
    }),
    (error) => error instanceof JudgeExecutorError && /peer\/peer\.dark\.added-base\.png/.test(error.message),
  );
  assert.equal(engineCalls, 0);
});

test("capture-time requested crops remain in pack integrity hashes and ui-judge proceeds", async () => {
  const subject = fixture({ count: 6 });
  const crop = cropForRecord(subject);
  const cropAsset = relative(join(subject.runDir, "shots"), crop.path).split(sep).join("/");
  const pack = buildPack(subject);
  assert.equal(pack.pack.targetShotHashes.anchor[cropAsset], subject.run.targetShotHashes.anchor[cropAsset]);
  assert.ok(pack.pack.attachmentHashes[`shots/${cropAsset}`], "the capture-time crop attachment must remain digest-bound");
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  try {
    const result = await runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine: (call) => initialEngineResponse(call),
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(result.outcome, "recorded");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
});

test("rebuilt judge batches exclude finalized verification crops while retaining complete integrity hashes", () => {
  const subject = fixture({ count: 6 });
  const crop = finalizedVerificationCrop(subject, "21212121-2121-4212-8212-212121212121");
  const cropAsset = relative(join(subject.runDir, "shots"), crop.path).split(sep).join("/");
  const rebuilt = buildPack(subject);
  const images = rebuilt.pack.batches.flatMap((batch) => readJson(join(subject.runDir, batch.imageList)).images);
  const uniqueInitialAssets = new Set(images.map((image) => image.assetId));
  const coveredTargets = [...new Set(rebuilt.pack.batches.flatMap((batch) => batch.targetIds))].sort();

  assert.equal(uniqueInitialAssets.has(crop.assetId), false, "verification zoom must not become an initial screen");
  assert.equal(uniqueInitialAssets.size, subject.ids.length, "initial batches must contain only the six real screens");
  assert.deepEqual(coveredTargets, [...subject.ids].sort(), "batch coverage must still include every selected screen target");
  assert.equal(rebuilt.pack.targetShotHashes.anchor[cropAsset], subject.run.targetShotHashes.anchor[cropAsset]);
  assert.equal(rebuilt.pack.attachmentHashes[`shots/${cropAsset}`], HASH(readFileSync(crop.path)));
  assert.doesNotThrow(() => assertPackAssetHashesMatchCapture(
    rebuilt.pack,
    subject.run,
    readJson(join(subject.runDir, "shots", "manifest.json")),
    join(subject.runDir, "shots"),
  ));
});

test("judge pack permits only a digest-bound verification crop added after packing", () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const manifestPath = join(subject.runDir, "shots", "manifest.json");
  const manifest = readJson(manifestPath);
  const target = manifest.targets.find((entry) => entry.id === "anchor");
  const configuredTarget = subject.cfg.routes.find((entry) => entry.id === target.id);
  const sourceAssetId = assetIdFor(configuredTarget, target.shots[0], manifest, subject.cfg);
  const crop = produceCrops({
    captureManifest: manifest,
    cfg: subject.cfg,
    shotsDir: join(subject.runDir, "shots"),
    cropRequests: [{
      assetId: sourceAssetId,
      rect: { x: 0.1, y: 0.2, w: 0.4, h: 0.3, normalized: true },
      purpose: `verify-${randomUUID()}`,
    }],
  }).produced[0];
  assert.ok(crop, "the verification crop fixture must be produced");
  subject.run = finalizeCaptureRun(join(subject.runDir, "run.json"), subject.run, manifest, join(subject.runDir, "shots"));
  const updatedPack = readJson(pack.path);
  const cropPath = relative(subject.runDir, crop.path).split(sep).join("/");
  updatedPack.attachmentHashes[cropPath] = HASH(readFileSync(crop.path));
  writeFileSync(pack.path, JSON.stringify(updatedPack, null, 2));
  assert.doesNotThrow(() => assertPackAssetHashesMatchCapture(
    updatedPack,
    subject.run,
    manifest,
    join(subject.runDir, "shots"),
  ));
});

test("judge pack root manifest publication is atomic when replacement fails", () => {
  const subject = fixture({ count: 6 });
  const first = buildPack(subject);
  const previous = readJson(first.path);
  let publishAttempts = 0;
  assert.throws(
    () => buildPack(subject, {
      writeRootManifest(path, value) {
        publishAttempts += 1;
        return writeJsonAtomic(path, value, {
          rename() {
            throw new Error("fixture root-manifest replacement failure");
          },
        });
      },
    }),
    /fixture root-manifest replacement failure/,
  );
  assert.equal(publishAttempts, 1);
  assert.deepEqual(readJson(first.path), previous);
});

test("ui-judge times out a sleeping fake engine and writes needs-agent without events", async () => {
  const subject = fixture({ count: 6 });
  subject.cfg.judge = { timeoutMs: 600000 };
  writeFileSync(subject.configPath, JSON.stringify(subject.cfg, null, 2));
  const pack = buildPack(subject);
  const bin = join(mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-timeout-bin-")), "bin");
  const codexHome = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-timeout-home-"));
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, "#!/bin/sh\nexec sleep 2\n");
  chmodSync(fakeCodex, 0o755);
  writeFileSync(join(codexHome, "auth.json"), "fake timeout auth\n", { mode: 0o600 });
  const environment = {
    PATH: "/usr/bin:/bin",
    HOME: subject.root,
    CODEX_HOME: codexHome,
    AUTOREVIEW_UI_ALLOW_UNCONFINED_JUDGE: "1",
    AUTOREVIEW_UI_JUDGE_TIMEOUT_MS: "25",
    FAKE_SENSITIVE_VAR_TIMEOUT_FIXTURE: "must-not-reach-the-judge",
  };
  let timeoutMs;
  try {
    await assert.rejects(
      () => runJudge({
        packPath: pack.path,
        configPath: subject.configPath,
        environment,
        engine(call, options) {
          timeoutMs = options.timeoutMs;
          return codexEngineAdapter(call, {
            environment: options.environment,
            platform: "linux",
            codexPath: fakeCodex,
            timeoutMs: options.timeoutMs,
          });
        },
      }),
      (error) => error instanceof JudgeExecutorError && error.phase === "engine" && /timed out after 25ms/i.test(error.message),
    );
  } finally {
    rmSync(dirname(bin), { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
  assert.equal(timeoutMs, 25, "the environment override must win over judge.timeoutMs for fake tests");
  const updated = readJson(pack.path);
  const outcome = updated.artifacts.find((path) => path.endsWith("executor-outcome.json"));
  assert.ok(outcome);
  assert.equal(readJson(join(subject.runDir, outcome)).outcome, "needs-agent");
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
});

test("ui-judge rejects a mutated resized attachment before the fake engine runs", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const image = readJson(join(subject.runDir, pack.pack.batches[0].imageList)).images[0];
  writeFileSync(join(subject.runDir, image.image), png(31, 17, 0xa7));
  let engineCalls = 0;
  await assert.rejects(
    () => runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine() {
        engineCalls += 1;
        return "unreachable";
      },
    }),
    (error) => error instanceof JudgeExecutorError && /image list .*digest/i.test(error.message),
  );
  assert.equal(engineCalls, 0);
});

test("ui-judge rejects a verification crop mutated immediately before the fake verify call", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const firstImage = readJson(join(subject.runDir, pack.pack.batches[0].imageList)).images[0];
  const calls = [];
  await assert.rejects(
    () => runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine(call) {
        calls.push(call.phase);
        if (call.phase === "initial") {
          return calls.filter((phase) => phase === "initial").length === 1
            ? initialEngineResponse(call, [validEngineFinding({ id: "abababab-abab-4bab-8bab-abababababab", targetId: firstImage.targetId, assetId: firstImage.assetId })])
            : initialEngineResponse(call);
        }
        return "unreachable";
      },
      beforeEngineCall(call) {
        if (call.phase === "verification") writeFileSync(call.images[0], png(29, 19, 0xb9));
      },
    }),
    (error) => error instanceof JudgeExecutorError && /verification crop .*digest/i.test(error.message),
  );
  assert.equal(calls.includes("verification"), false, "the mutated crop must fail before the verify engine call");
});

test("ui-judge refuses a verification prompt edited immediately before the fake verify call", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const firstImage = readJson(join(subject.runDir, pack.pack.batches[0].imageList)).images[0];
  const calls = [];
  await assert.rejects(
    () => runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine(call) {
        calls.push(call.phase);
        if (call.phase === "initial") {
          return calls.filter((phase) => phase === "initial").length === 1
            ? initialEngineResponse(call, [validEngineFinding({ id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd", targetId: firstImage.targetId, assetId: firstImage.assetId })])
            : initialEngineResponse(call);
        }
        return "unreachable";
      },
      beforeEngineCall(call) {
        if (call.phase === "verification") writeFileSync(call.promptPath, `${call.prompt}\n<!-- verification mutation -->\n`);
      },
    }),
    (error) => error instanceof JudgeExecutorError && error.hard === true && /verification prompt for finding .*digest/i.test(error.message),
  );
  assert.equal(calls.includes("verification"), false, "the mutated prompt must fail before the verify engine call");
  assert.equal(existsSync(join(subject.stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
  assert.equal(readJson(pack.path).artifacts.some((path) => path.endsWith("executor-outcome.json")), false);
});

test("ui-judge rejects replacement capture fingerprints immediately before recording", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const firstImage = readJson(join(subject.runDir, pack.pack.batches[0].imageList)).images[0];
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  let emittedInitial = false;
  const engine = (call) => {
    if (call.phase === "initial") {
      if (emittedInitial) return initialEngineResponse(call);
      emittedInitial = true;
      return initialEngineResponse(call, [validEngineFinding({ id: "77777777-7777-4777-8777-777777777777", targetId: firstImage.targetId, assetId: firstImage.assetId })]);
    }
    const replaced = readJson(join(subject.runDir, "run.json"));
    replaced.targetFingerprints.peer = { fingerprint: `sha256:${"f".repeat(64)}` };
    writeFileSync(join(subject.runDir, "run.json"), JSON.stringify(replaced, null, 2));
    return JSON.stringify({ verifierVerdict: "confirmed", evidence: "The verification crop visibly confirms the uneven spacing." });
  };
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = stateDir;
  try {
    await assert.rejects(
      () => runJudge({ packPath: pack.path, configPath: subject.configPath, engine, model: { provider: "fake", name: "fixture" } }),
      (error) => error instanceof JudgeExecutorError && /fingerprints.*peer/.test(error.message),
    );
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  assert.equal(existsSync(join(stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json")), false);
  assert.equal(readJson(pack.path).artifacts.some((path) => path.endsWith("executor-outcome.json")), false);
});

test("ui-judge keeps sealed judged fingerprints when the later cursor write fails", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const projectState = join(subject.stateDir, subject.cfg.name);
  mkdirSync(projectState, { recursive: true });
  // ui-review writes review.json and the pack mirror before it advances the
  // cursor. A file here makes only that last cursor step fail.
  writeFileSync(join(projectState, "judgments"), "cursor path deliberately unavailable");
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  try {
    await assert.rejects(
      () => runJudge({
        packPath: pack.path,
        configPath: subject.configPath,
        engine: (call) => initialEngineResponse(call),
        model: { provider: "fake", name: "fixture" },
      }),
      (error) => error instanceof JudgeExecutorError && error.phase === "record",
    );
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  const updated = readJson(pack.path);
  assert.equal(validateJudgePack(updated).valid, true);
  assert.deepEqual(updated.judgedFingerprints, judgedFingerprints(updated));
  const outcome = updated.artifacts.find((path) => path.endsWith("executor-outcome.json"));
  assert.ok(outcome, "needs-agent outcome must be merged into the sealed manifest");
  assert.equal(readJson(join(subject.runDir, outcome)).outcome, "needs-agent");
  assert.equal(readJson(join(subject.runDir, outcome)).phase, "record");
  assert.equal(existsSync(join(projectState, "runs", subject.run.runId, "review.json")), true, "the sealed review must remain durable");
});

test("ui-judge maps available exemplar attachments and names unavailable exemplars", async () => {
  const subject = fixture({ count: 6 });
  const missing = {
    id: "exemplar-one",
    path: `projects/exemplars/${subject.cfg.name}/exemplar-one.json`,
    screenshot: { status: "unavailable", reason: "The retained exemplar asset is unavailable." },
    rubricVersion: "rubric.v1",
    curator: "fixture curator",
    expectedFindings: ["This documented exemplar is unavailable."],
    severity: "P2",
  };
  const present = retainImmutableExemplar(subject, "exemplar-two");
  present.expectedFindings = ["This attached exemplar has its own identity."];
  const pack = buildPack(subject, { exemplarDefinitions: [missing, present] });
  const updatedPack = pack.pack;
  const packedPresent = updatedPack.exemplars.find((entry) => entry.id === "exemplar-two");
  const presentPath = join(subject.runDir, packedPresent.screenshot.attachment);
  assert.equal(validateJudgePack(updatedPack).valid, true);

  const initialCalls = [];
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = subject.stateDir;
  try {
    const result = await runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine: (call) => {
        if (call.phase === "initial") initialCalls.push(call);
        return initialEngineResponse(call);
      },
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(result.outcome, "recorded");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }

  assert.equal(initialCalls.length, updatedPack.batches.length);
  for (const call of initialCalls) {
    const screenshots = readJson(join(subject.runDir, call.batch.imageList)).images;
    assert.equal(HASH(Buffer.from(call.prompt, "utf8")), call.promptDigest);
    assert.equal(call.promptDigest, call.batch.promptDigest);
    const mapMatch = call.prompt.match(/## Runtime exemplar attachment map\n\n[\s\S]*?```json\n([\s\S]*?)\n```/);
    assert.ok(mapMatch, "the engine prompt must include the runtime exemplar map");
    const attachmentMap = JSON.parse(mapMatch[1]);
    assert.deepEqual(call.images.slice(screenshots.length), [presentPath], "only the resolvable exemplar path is attached");
    const scratchDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-exemplar-argv-"));
    try {
      const sourceCodexHome = join(scratchDir, "source-codex-home");
      mkdirSync(sourceCodexHome, { mode: 0o700 });
      writeFileSync(join(sourceCodexHome, "auth.json"), "fake auth fixture\n", { mode: 0o600 });
      const invocation = buildCodexEngineInvocation({
        images: call.images,
        scratchDir,
        environment: {
          PATH: "/usr/bin",
          HOME: "/fixture/home",
          CODEX_HOME: sourceCodexHome,
          AUTOREVIEW_UI_ALLOW_UNCONFINED_JUDGE: "1",
        },
        platform: "darwin",
        codexPath: "/runtime/bin/codex",
      });
      const argvAttachments = invocation.codexArgs.flatMap((argument, index, argv) => argument === "-i" ? [argv[index + 1]] : []);
      assert.deepEqual(argvAttachments.slice(screenshots.length), [presentPath], "the Codex argv attaches only the resolvable exemplar path");
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
    assert.deepEqual(
      attachmentMap.attachedExemplars.map(({ attachmentIndex, exemplarId }) => ({ attachmentIndex, exemplarId })),
      [{ attachmentIndex: screenshots.length + 1, exemplarId: "exemplar-two" }],
    );
    assert.deepEqual(attachmentMap.attachedExemplars[0].exemplar.expectedFindings, present.expectedFindings);
    assert.deepEqual(
      attachmentMap.unavailableExemplars.map(({ exemplarId, status }) => ({ exemplarId, status })),
      [{ exemplarId: "exemplar-one", status: "unavailable" }],
    );
    assert.deepEqual(attachmentMap.unavailableExemplars[0].exemplar.expectedFindings, missing.expectedFindings);
  }
});

test("ui-judge rejects an unlocalizable initial claim with a rejected disposition", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const firstImage = readJson(join(subject.runDir, pack.pack.batches[0].imageList)).images[0];
  let emittedInitial = false;
  const engine = (call) => {
    assert.equal(call.phase, "initial", "unlocalizable claims do not request a fabricated crop verification");
    if (emittedInitial) return initialEngineResponse(call);
    emittedInitial = true;
    return initialEngineResponse(call, [{
      ...validEngineFinding({ id: "22222222-2222-4222-8222-222222222222", targetId: firstImage.targetId, assetId: "missing/dark/full/base" }),
      evidence: "A visible issue without a valid captured asset binding.",
    }]);
  };
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = stateDir;
  try {
    await runJudge({ packPath: pack.path, configPath: subject.configPath, engine, model: { provider: "fake", name: "fixture" } });
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  const events = readFileSync(join(stateDir, "fixture", "runs", subject.run.runId, "review.json"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(events[2].verifierVerdict, "rejected");
  assert.equal(events[3].finding.disposition, "rejected");
  assert.match(events[2].evidence, /unlocalizable/);
});

test("ui-judge keeps a valid peer target when repairing its unknown asset binding", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const batch = pack.pack.batches.find((entry) => entry.targetIds.includes("peer"));
  const images = readJson(join(subject.runDir, batch.imageList)).images;
  const firstImage = images.find((image) => !image.referenceOnly);
  const peerImage = images.find((image) => image.targetId === "peer" && !image.referenceOnly);
  assert.ok(peerImage, "the comparison batch must contain a non-reference peer asset");
  assert.notEqual(firstImage.targetId, "peer", "the regression requires a different global first-image fallback");
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = stateDir;
  try {
    const result = await runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine(call) {
        return initialEngineResponse(call, call.batch.id === batch.id ? [{
          ...validEngineFinding({ id: "25252525-2525-4252-8252-252525252525", targetId: "peer", assetId: "unknown/dark/full/base" }),
          evidence: "The peer claim is valid apart from its unknown asset binding.",
        }] : []);
      },
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(result.outcome, "recorded");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  const events = readFileSync(join(stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json"), "utf8").trim().split("\n").map(JSON.parse);
  const initial = events.find((event) => event.kind === "initial");
  const disposition = events.find((event) => event.kind === "disposition");
  assert.equal(initial.finding.targetId, "peer");
  assert.equal(initial.finding.assetId, peerImage.assetId);
  assert.equal(disposition.finding.disposition, "rejected");
  assert.equal(readJson(pack.path).artifacts.some((path) => path.endsWith("executor-outcome.json") && readJson(join(subject.runDir, path)).outcome === "needs-agent"), false);
});

test("ui-judge seals an out-of-batch target claim as a rejected unlocalizable finding when localized coverage agrees", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const firstImage = readJson(join(subject.runDir, pack.pack.batches[0].imageList)).images.find((image) => !image.referenceOnly);
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = stateDir;
  try {
    const result = await runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine(call) {
        const response = JSON.parse(initialEngineResponse(call, call.batch.targetIds.includes(firstImage.targetId) ? [{
          ...validEngineFinding({ id: "23232323-2323-4232-8232-232323232323", targetId: "outside-batch", assetId: "unknown/dark/full/base" }),
          evidence: "The claim has a valid shape but names an out-of-batch target and unknown asset.",
        }] : []));
        if (call.batch.targetIds.includes(firstImage.targetId)) {
          response.coverage.find((entry) => entry.targetId === firstImage.targetId && entry.phase === "consistency").result = "findings";
        }
        return JSON.stringify(response);
      },
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(result.outcome, "recorded");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  const events = readFileSync(join(stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json"), "utf8").trim().split("\n").map(JSON.parse);
  const initial = events.find((event) => event.kind === "initial");
  const disposition = events.find((event) => event.kind === "disposition");
  assert.equal(initial.finding.targetId, firstImage.targetId);
  assert.equal(initial.finding.assetId, firstImage.assetId);
  assert.equal(disposition.finding.disposition, "rejected");
  assert.equal(readJson(pack.path).artifacts.some((path) => path.endsWith("executor-outcome.json") && readJson(join(subject.runDir, path)).outcome === "needs-agent"), false);
});

test("ui-judge binds cross-target asset claims and coverage to the asset target before rejecting them", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const list = readJson(join(subject.runDir, pack.pack.batches[0].imageList)).images;
  const anchor = list.find((image) => image.targetId === "anchor" && !image.referenceOnly);
  const peer = list.find((image) => image.targetId === "peer" && !image.referenceOnly);
  assert.ok(anchor && peer, "the comparison batch must contain anchor and peer assets");
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = stateDir;
  try {
    const result = await runJudge({
      packPath: pack.path,
      configPath: subject.configPath,
      engine(call) {
        const response = JSON.parse(initialEngineResponse(call, call.batch.targetIds.includes("peer") ? [{
          ...validEngineFinding({ id: "24242424-2424-4242-8242-242424242424", targetId: anchor.targetId, assetId: peer.assetId }),
          evidence: "The asset belongs to a different target than the claim.",
        }] : []));
        if (call.batch.targetIds.includes("peer")) {
          response.coverage.find((entry) => entry.targetId === anchor.targetId && entry.phase === "consistency").result = "clean";
          response.coverage.find((entry) => entry.targetId === peer.targetId && entry.phase === "consistency").result = "findings";
        }
        return JSON.stringify(response);
      },
      model: { provider: "fake", name: "fixture" },
    });
    assert.equal(result.outcome, "recorded");
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  const events = readFileSync(join(stateDir, subject.cfg.name, "runs", subject.run.runId, "review.json"), "utf8").trim().split("\n").map(JSON.parse);
  const initial = events.find((event) => event.kind === "initial");
  const disposition = events.find((event) => event.kind === "disposition");
  assert.equal(initial.finding.targetId, peer.targetId);
  assert.equal(initial.finding.assetId, peer.assetId);
  assert.equal(disposition.finding.disposition, "rejected");
});

test("ui-judge degrades schema-invalid initial output instead of fabricating an unlocalizable finding", async () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
  process.env.AUTOREVIEW_UI_STATE_DIR = stateDir;
  try {
    await assert.rejects(
      () => runJudge({
        packPath: pack.path,
        configPath: subject.configPath,
        engine: (call) => initialEngineResponse(call, [{ targetId: "missing", assetId: "missing/dark/full/base", region: null }]),
        model: { provider: "fake", name: "fixture" },
      }),
      (error) => error instanceof JudgeExecutorError && /not finding\.v2 apart from localization/.test(error.message),
    );
  } finally {
    if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
    else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
  }
  const updated = readJson(pack.path);
  const outcome = updated.artifacts.find((path) => path.endsWith("executor-outcome.json"));
  assert.equal(readJson(join(subject.runDir, outcome)).outcome, "needs-agent");
  assert.equal(readJson(join(subject.runDir, outcome)).phase, "initial");
  assert.equal(existsSync(join(stateDir, "fixture", "runs", subject.run.runId, "review.json")), false);
});

test("ui-review seals cursor dispositions from the combined event log across incremental appends", () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const firstImage = readJson(join(subject.runDir, pack.pack.batches[0].imageList)).images[0];
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  const header = {
    kind: "record-header",
    version: 1,
    runId: subject.run.runId,
    project: subject.cfg.name,
    configHash: `sha256:${"a".repeat(64)}`,
    commitHash: subject.run.commit,
    patchHash: subject.run.patchHash,
    targets: subject.ids,
    targetShotHashes: subject.run.targetShotHashes,
    intentSource: subject.cfg.intentDoc,
    rubricVersion: "rubric.v1",
    model: { provider: "fake", name: "fixture" },
    createdAt: "2026-08-11T00:00:00.000Z",
  };
  const fullFinding = validEngineFinding({
    id: "33333333-3333-4333-8333-333333333333",
    targetId: firstImage.targetId,
    assetId: firstImage.assetId,
  });
  const { verifierVerdict, disposition, ...initialFinding } = fullFinding;
  const firstAppend = [
    header,
    { kind: "initial", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", finding: initialFinding },
    {
      kind: "verification",
      version: 1,
      eventId: randomUUID(),
      at: "2026-08-11T00:00:02.000Z",
      findingId: fullFinding.id,
      verifierVerdict: "confirmed",
      evidence: "The crop confirms the visible spacing issue.",
    },
    {
      kind: "disposition",
      version: 1,
      eventId: randomUUID(),
      at: "2026-08-11T00:00:03.000Z",
      finding: { ...fullFinding, verifierVerdict: "confirmed", disposition: "accepted" },
    },
  ];
  const terminalAppend = [
    header,
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:04.000Z", findingCount: 1, findingIds: [fullFinding.id] },
  ];
  const firstPath = join(subject.root, "first-append.json");
  const terminalPath = join(subject.root, "terminal-append.json");
  writeFileSync(firstPath, JSON.stringify(firstAppend, null, 2));
  writeFileSync(terminalPath, JSON.stringify(terminalAppend, null, 2));
  const env = { ...process.env, AUTOREVIEW_UI_STATE_DIR: stateDir };
  for (const eventsPath of [firstPath, terminalPath]) {
    const result = spawnSync(
      process.execPath,
      [UI_REVIEW, "--config", subject.configPath, "--record", eventsPath, "--run", subject.runDir, "--json"],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const state = readJson(join(stateDir, subject.cfg.name, "judgments", "latest.json"));
  assert.equal(state.targets[firstImage.targetId].disposition, "accepted");
  assert.ok(
    Object.entries(state.targets)
      .filter(([targetId]) => targetId !== firstImage.targetId)
      .every(([, target]) => target.disposition === "clean"),
  );
});

test("sealed agent records persist validated pack fingerprints for --previous-pack when state is unavailable", () => {
  const subject = fixture({ count: 6 });
  const originalPack = buildPack(subject);
  const events = [
    recordHeaderFor(subject),
    { kind: "seal", version: 1, eventId: randomUUID(), at: "2026-08-11T00:00:01.000Z", findingCount: 0, findingIds: [] },
  ];
  const eventsPath = join(subject.root, "sealed-agent-events.json");
  writeFileSync(eventsPath, JSON.stringify(events, null, 2));
  const seal = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", subject.configPath, "--record", eventsPath, "--run", subject.runDir, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: subject.stateDir } },
  );
  assert.equal(seal.status, 0, seal.stderr || seal.stdout);
  const sealedPack = readJson(originalPack.path);
  assert.equal(validateJudgePack(sealedPack).valid, true);
  assert.deepEqual(sealedPack.judgedFingerprints, judgedFingerprints(sealedPack));

  const recapture = fixture({ count: 6, root: subject.root, project: subject.cfg.name });
  recapture.run.targetFingerprints.peer = { fingerprint: `sha256:${"e".repeat(64)}` };
  writeFileSync(join(recapture.runDir, "run.json"), JSON.stringify(recapture.run, null, 2));
  rmSync(subject.stateDir, { recursive: true, force: true });
  const unavailableStateDir = join(subject.stateDir, "unavailable");
  const fallback = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", recapture.configPath, "--judge-pack", "--run", recapture.runDir, "--previous-pack", originalPack.path, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: unavailableStateDir } },
  );
  assert.equal(fallback.status, 0, fallback.stderr || fallback.stdout);
  assert.deepEqual(JSON.parse(fallback.stdout).judgePack.targets, ["peer"]);
});

for (const [name, engine] of [
  ["malformed JSON", () => "this is not JSON"],
  ["engine failure", () => { throw new Error("fixture engine unavailable"); }],
]) {
  test(`ui-judge ${name} preserves the pack, writes needs-agent, and never records partial events`, async () => {
    const subject = fixture({ count: 6 });
    const pack = buildPack(subject);
    const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
    const previous = process.env.AUTOREVIEW_UI_STATE_DIR;
    process.env.AUTOREVIEW_UI_STATE_DIR = stateDir;
    try {
      await assert.rejects(
        () => runJudge({ packPath: pack.path, configPath: subject.configPath, engine }),
        (error) => error instanceof JudgeExecutorError && /engine|JSON/i.test(error.message),
      );
    } finally {
      if (previous === undefined) delete process.env.AUTOREVIEW_UI_STATE_DIR;
      else process.env.AUTOREVIEW_UI_STATE_DIR = previous;
    }
    const updated = readJson(pack.path);
    const outcome = updated.artifacts.find((path) => path.endsWith("executor-outcome.json"));
    assert.ok(outcome, "needs-agent outcome must be listed in the preserved pack manifest");
    assert.equal(readJson(join(subject.runDir, outcome)).outcome, "needs-agent");
    assert.equal(existsSync(join(stateDir, "fixture", "runs", subject.run.runId, "review.json")), false);
  });
}

test("ui-judge CLI exits nonzero on a faked codex failure and leaves needs-agent evidence", () => {
  const subject = fixture({ count: 6 });
  const pack = buildPack(subject);
  const bin = join(mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-bin-")), "bin");
  mkdirSync(bin);
  const fakeCodex = join(bin, "codex");
  writeFileSync(fakeCodex, "#!/bin/sh\necho fixture codex failure >&2\nexit 23\n");
  chmodSync(fakeCodex, 0o755);
  const codexHome = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-cli-home-"));
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ fixtureMaterial: "FAKE_CREDENTIAL_MATERIAL_CLI_FAILURE" }), { mode: 0o600 });
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass4-state-"));
  const result = spawnSync(
    process.execPath,
    [UI_JUDGE, "--pack", pack.path, "--config", subject.configPath, "--engine", "codex", "--json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CODEX_HOME: codexHome,
        AUTOREVIEW_UI_ALLOW_UNCONFINED_JUDGE: "1",
        AUTOREVIEW_UI_STATE_DIR: stateDir,
      },
    },
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /needs-agent/);
  const updated = readJson(pack.path);
  const outcome = updated.artifacts.find((path) => path.endsWith("executor-outcome.json"));
  assert.equal(readJson(join(subject.runDir, outcome)).outcome, "needs-agent");
  assert.equal(existsSync(join(stateDir, "fixture", "runs", subject.run.runId, "review.json")), false);
});

test("judge.model and judge.reasoningEffort reach the Codex argv as explicit -c overrides, after the confinement switches", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-judge-model-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const codex = join(bin, "codex");
  writeFileSync(codex, "#!/bin/sh\n", { mode: 0o755 });
  const sourceCodexHome = join(root, "codex-home");
  mkdirSync(sourceCodexHome, { recursive: true });
  writeFileSync(join(sourceCodexHome, "auth.json"), JSON.stringify({ fixture: "FAKE-CRED-M" }), { mode: 0o600 });
  const scratchDir = join(root, "scratch");
  mkdirSync(scratchDir, { recursive: true });
  const environment = { PATH: bin, HOME: root, CODEX_HOME: sourceCodexHome, AUTOREVIEW_UI_ALLOW_UNCONFINED_JUDGE: "1" };
  try {
    const plain = buildCodexEngineInvocation({ images: [], scratchDir, environment, platform: "linux" });
    assert.equal(plain.codexArgs.some((argument) => /^model=/.test(argument)), false, "no model override unless configured");
    assert.equal(plain.codexArgs.some((argument) => /^model_reasoning_effort=/.test(argument)), false);

    const picked = buildCodexEngineInvocation({ images: [], scratchDir, environment, platform: "linux", model: "gpt-5.6-sol", reasoningEffort: "high" });
    const args = picked.codexArgs;
    const modelAt = args.indexOf("model=gpt-5.6-sol");
    const effortAt = args.indexOf("model_reasoning_effort=high");
    assert.ok(modelAt > 0 && args[modelAt - 1] === "-c", "model is passed as a -c override");
    assert.ok(effortAt > 0 && args[effortAt - 1] === "-c", "effort is passed as a -c override");
    assert.ok(modelAt > args.indexOf("mcp_servers={}"), "overrides come after the confinement switches");
    assert.ok(effortAt < args.indexOf("-"), "overrides come before the stdin prompt marker");
    assert.deepEqual(args.slice(0, 7), ["exec", "--sandbox", "read-only", "-C", resolve(scratchDir), "--ignore-user-config", "--ignore-rules"]);

    assert.throws(
      () => buildCodexEngineInvocation({ images: [], scratchDir, environment, platform: "linux", model: "gpt-5.6 sol; rm -rf /" }),
      (error) => error instanceof JudgeExecutorError && /judge\.model must be a bare model name/.test(error.message),
    );
    assert.throws(
      () => buildCodexEngineInvocation({ images: [], scratchDir, environment, platform: "linux", reasoningEffort: "ultra" }),
      (error) => error instanceof JudgeExecutorError && /judge\.reasoningEffort must be one of/.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveJudgeModelSelection accepts an empty judge block and rejects bad values", () => {
  assert.deepEqual(resolveJudgeModelSelection({}), { model: null, reasoningEffort: null });
  assert.deepEqual(resolveJudgeModelSelection({ model: "gpt-5.6-sol", reasoningEffort: "xhigh" }), { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  assert.throws(() => resolveJudgeModelSelection({ model: 42 }), JudgeExecutorError);
  assert.throws(() => resolveJudgeModelSelection({ reasoningEffort: "HIGH" }), JudgeExecutorError);
});

test("the API request carries reasoning.effort only when the judge config sets it", () => {
  const base = { provider: "openai", model: "gpt-5.6", apiKey: "FAKE-CRED-R", url: "https://api.openai.invalid/v1/responses", maxFindingsPerBatch: 3 };
  const without = JSON.parse(buildApiEngineRequest({ images: [], prompt: "p", phase: "initial" }, { api: base }).body);
  assert.equal("reasoning" in without, false);
  const withEffort = JSON.parse(buildApiEngineRequest({ images: [], prompt: "p", phase: "initial" }, { api: { ...base, reasoningEffort: "high" } }).body);
  assert.deepEqual(withEffort.reasoning, { effort: "high" });
  assert.equal(withEffort.model, "gpt-5.6");
});
