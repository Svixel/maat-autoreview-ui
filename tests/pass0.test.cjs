"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync } = require("node:fs");
const { createHash } = require("node:crypto");

const UI_REVIEW = join(__dirname, "..", "scripts", "ui-review");
const PROJECTS = join(__dirname, "..", "projects");
const REVIEW_RECORD = require.resolve("../scripts/review-record.cjs");
const {
  normalizeConfig,
  recordCompleteness,
  schemas,
  validateConfig,
  validateFinding,
  validateReceiptForTarget,
  validateReviewEvents,
} = require("../schemas/validator.cjs");
const { assertCaptureSession } = require("../scripts/sim-target.cjs");
const { appendReviewRecord, readLog, reclaimStaleLock, resolveReviewPath } = require("../scripts/review-record.cjs");
const { acquireLibraryLock, releaseLibraryLock } = require("../scripts/library.cjs");
const { selectTargets } = require("../scripts/ui-review");
const {
  composeDeepLinkUrl,
  composeWebUrl,
  targetOutputPath,
} = require("../scripts/capture-contract.cjs");

const HASH = `sha256:${"a".repeat(64)}`;
const PATCH_HASH = `sha256:${"b".repeat(64)}`;
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const FINDING_A = "22222222-2222-4222-8222-222222222222";
const FINDING_B = "33333333-3333-4333-8333-333333333333";

function header(project = "fixture") {
  return {
    kind: "record-header",
    version: 1,
    runId: RUN_ID,
    project,
    configHash: HASH,
    commitHash: "abcdef1",
    patchHash: PATCH_HASH,
    targets: ["home"],
    intentSource: "skill:projects/intent/fixture.md",
    rubricVersion: "2026-08",
    model: { provider: "openai", name: "codex" },
    createdAt: "2026-08-11T10:00:00Z",
  };
}

function reorderedHeader(project = "fixture") {
  const source = header(project);
  return {
    createdAt: source.createdAt,
    model: { name: source.model.name, provider: source.model.provider },
    rubricVersion: source.rubricVersion,
    intentSource: source.intentSource,
    targets: source.targets,
    patchHash: source.patchHash,
    commitHash: source.commitHash,
    configHash: source.configHash,
    project: source.project,
    runId: source.runId,
    version: source.version,
    kind: source.kind,
  };
}

function candidate(id) {
  return {
    id,
    ruleId: "layout/overlap",
    targetId: "home",
    assetId: "home.dark.full",
    region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4, normalized: true },
    evidence: "The primary CTA visibly overlaps the caption.",
    priority: "P1",
    confidence: 0.9,
    initialVerdict: "finding",
    scope: "in-scope",
  };
}

function finalized(id) {
  return {
    ...candidate(id),
    verifierVerdict: "confirmed",
    disposition: "accepted",
  };
}

function initial(id, eventId) {
  return { kind: "initial", version: 1, eventId, at: "2026-08-11T10:01:00Z", finding: candidate(id) };
}

function verification(id, eventId) {
  return {
    kind: "verification",
    version: 1,
    eventId,
    at: "2026-08-11T10:02:00Z",
    findingId: id,
    verifierVerdict: "confirmed",
    evidence: "The region crop confirms the overlap at native scale.",
  };
}

function disposition(id, eventId) {
  return { kind: "disposition", version: 1, eventId, at: "2026-08-11T10:03:00Z", finding: finalized(id) };
}

function seal(findingCount, eventId, findingIds) {
  return {
    kind: "seal",
    version: 1,
    eventId,
    at: "2026-08-11T10:04:00Z",
    findingCount,
    ...(findingIds === undefined ? {} : { findingIds }),
  };
}

function writeRecordConfig(root) {
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "fixture",
      root,
      baseUrl: "http://127.0.0.1:9",
      intentDoc: "skill:projects/intent/.gitkeep",
      routes: [{ id: "home", route: "home", waitFor: "label=Home" }],
    }),
  );
  return configPath;
}

function writeCompletedCaptureRun(root, { project = "fixture", runId = RUN_ID, targetIds = ["home"] } = {}) {
  const runDir = mkdtempSync(join(tmpdir(), "autoreview-ui-capture-run-"));
  const shotsDir = join(runDir, "shots");
  mkdirSync(shotsDir);
  const targetShotHashes = {};
  const targetOutcomes = {};
  for (const targetId of targetIds) {
    const asset = `${targetId}.capture.png`;
    const assetPath = join(shotsDir, asset);
    const contents = Buffer.from(`captured ${project}/${targetId}\n`);
    writeFileSync(assetPath, contents);
    targetShotHashes[targetId] = {
      [asset]: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
    };
    targetOutcomes[targetId] = "captured";
  }
  writeFileSync(
    join(shotsDir, "manifest.json"),
    JSON.stringify({
      targets: targetIds.map((targetId) => ({
        id: targetId,
        shots: [{ path: join(shotsDir, `${targetId}.capture.png`) }],
        interactions: [],
      })),
    }, null, 2),
  );
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({ runId, project, targetIds, targetOutcomes, targetShotHashes, captureComplete: true }, null, 2),
  );
  return { runDir, targetShotHashes };
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [UI_REVIEW, ...args], { encoding: "utf8", env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("Pass 0 schemas accept a complete sealed finding log and reject invalid coordinate and ordering contracts", () => {
  const finding = finalized(FINDING_A);
  assert.equal(validateFinding(finding).valid, true);
  assert.equal(
    validateReviewEvents([
      header(),
      initial(FINDING_A, "44444444-4444-4444-8444-444444444444"),
      verification(FINDING_A, "55555555-5555-4555-8555-555555555555"),
      disposition(FINDING_A, "66666666-6666-4666-8666-666666666666"),
      seal(1, "77777777-7777-4777-8777-777777777777", [FINDING_A]),
    ]).valid,
    true,
  );
  assert.match(
    validateFinding({ ...finding, region: { ...finding.region, x: 0.8, w: 0.3 } }).errors.join("\n"),
    /within the asset horizontally/,
  );
  assert.match(
    validateReviewEvents([header(), verification(FINDING_A, "88888888-8888-4888-8888-888888888888")]).errors.join("\n"),
    /must follow its initial event/,
  );
  const receipt = {
    id: "88888888-8888-4888-8888-888888888888",
    project: "fixture",
    stateProfile: "rich",
    account: "qa@example.test",
    appBuild: "1.2.3",
    device: { name: "iPhone-17-Pro-E2E" },
    sessionId: "session-123",
    preparedAt: "2026-08-11T10:00:00Z",
    expiresAt: "2026-08-11T11:00:00Z",
    outcome: "prepared",
    producer: { name: "project-qa", version: "1" },
  };
  assert.equal(validateReceiptForTarget(receipt, { project: "fixture", stateProfile: "rich", now: Date.parse("2026-08-11T10:30:00Z") }).valid, true);
  assert.match(
    validateReceiptForTarget(receipt, { project: "fixture", stateProfile: "poor", now: Date.parse("2026-08-11T10:30:00Z") }).errors.join("\n"),
    /must match stateProfile poor/,
  );
});

test("review completion requires one final seal that exactly declares the observed findings", () => {
  const completeEvents = [
    header(),
    initial(FINDING_A, "44444444-4444-4444-8444-444444444444"),
    verification(FINDING_A, "55555555-5555-4555-8555-555555555555"),
    disposition(FINDING_A, "66666666-6666-4666-8666-666666666666"),
  ];
  assert.deepEqual(recordCompleteness([header()]), {
    hasHeader: true,
    initials: 0,
    verifications: 0,
    dispositions: 0,
    pendingFindingIds: [],
    seal: null,
    sealed: false,
    status: "unsealed",
    complete: false,
  });
  assert.equal(recordCompleteness(completeEvents).status, "unsealed");
  assert.equal(recordCompleteness(completeEvents).complete, false);

  const sealed = [...completeEvents, seal(1, "77777777-7777-4777-8777-777777777777", [FINDING_A])];
  assert.equal(validateReviewEvents(sealed).valid, true);
  assert.equal(recordCompleteness(sealed).complete, true);

  const sealedButPending = [
    header(),
    initial(FINDING_A, "44444444-4444-4444-8444-444444444444"),
    seal(1, "77777777-7777-4777-8777-777777777777", [FINDING_A]),
  ];
  assert.equal(validateReviewEvents(sealedButPending).valid, true);
  assert.equal(recordCompleteness(sealedButPending).status, "incomplete");
  assert.equal(recordCompleteness(sealedButPending).complete, false);

  const wrongCount = [...completeEvents, seal(2, "77777777-7777-4777-8777-777777777777", [FINDING_A])];
  assert.match(validateReviewEvents(wrongCount).errors.join("\n"), /must match the 1 observed initial finding/);

  const wrongIds = [...completeEvents, seal(1, "77777777-7777-4777-8777-777777777777", [FINDING_B])];
  assert.match(validateReviewEvents(wrongIds).errors.join("\n"), /must exactly match the observed initial finding ids/);

  const nonTerminal = [...sealed, initial(FINDING_B, "88888888-8888-4888-8888-888888888888")];
  assert.match(validateReviewEvents(nonTerminal).errors.join("\n"), /seal must be the final event/);

  const zeroFinding = [header(), seal(0, "99999999-9999-4999-8999-999999999999", [])];
  assert.equal(validateReviewEvents(zeroFinding).valid, true);
  assert.equal(recordCompleteness(zeroFinding).complete, true);
});

test("project names use one path-safe contract in schemas, validation, and record storage", () => {
  const configName = schemas()["config.v2.json"].properties.name;
  const eventProject = schemas()["review-event.v1.json"].$defs.header.properties.project;
  assert.equal(configName.pattern, "^[A-Za-z0-9_-]+$");
  assert.equal(eventProject.pattern, configName.pattern);

  const invalidName = "Acme Mobile";
  const config = {
    configVersion: 2,
    name: invalidName,
    root: "/tmp/fixture",
    baseUrl: "http://127.0.0.1:9",
    routes: [],
  };
  assert.match(validateConfig(config).errors.join("\n"), /config\.name: must be a safe path segment/);
  assert.match(validateReviewEvents([header(invalidName)]).errors.join("\n"), /events\[0\]\.project: must be a safe path segment/);
  assert.throws(
    () => resolveReviewPath(header(invalidName), { projectRoot: "/tmp/fixture", stateDir: "/tmp/autoreview-ui-state" }),
    /record header project must be a safe path segment/,
  );
});

test("review event sequences require every finding target to be in the header and every header target to be configured", () => {
  const outsideHeader = initial(FINDING_A, "44444444-4444-4444-8444-444444444444");
  outsideHeader.finding.targetId = "settings";
  assert.match(
    validateReviewEvents([header(), outsideHeader]).errors.join("\n"),
    /finding\.targetId: must be listed in the record header targets/,
  );

  const unknownHeader = header();
  unknownHeader.targets = ["settings"];
  const configuredFinding = initial(FINDING_A, "55555555-5555-4555-8555-555555555555");
  configuredFinding.finding.targetId = "settings";
  assert.match(
    validateReviewEvents([unknownHeader, configuredFinding], { targetIds: ["home"] }).errors.join("\n"),
    /events\[0\]\.targets: references target settings not present in the selected project config/,
  );
});

test("record validation rejects headers that name unsuccessful or unhashed capture targets", () => {
  const errors = validateReviewEvents([header()], {
    capturedTargetIds: ["home"],
    capturedTargetOutcomes: { home: "failed" },
    capturedTargetShotHashes: { home: {} },
  }).errors.join("\n");
  assert.match(errors, /references target home that was not successfully captured \(outcome: failed\)/);
  assert.match(errors, /references target home with no hashed PNGs in the capture run/);
});

test("review records compare headers and stable finding fields by value, not object key insertion order", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-record-project-"));
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-record-state-"));
  const options = { projectRoot: root, stateDir, targetIds: ["home"] };
  appendReviewRecord([header(), initial(FINDING_A, "44444444-4444-4444-8444-444444444444")], options);
  const appended = appendReviewRecord([reorderedHeader(), initial(FINDING_B, "55555555-5555-4555-8555-555555555555")], options);
  assert.equal(appended.events, 3);

  const completed = disposition(FINDING_A, "66666666-6666-4666-8666-666666666666");
  completed.finding.region = { normalized: true, h: 0.4, w: 0.3, y: 0.2, x: 0.1 };
  assert.equal(
    validateReviewEvents([
      header(),
      initial(FINDING_A, "77777777-7777-4777-8777-777777777777"),
      verification(FINDING_A, "88888888-8888-4888-8888-888888888888"),
      completed,
    ]).valid,
    true,
  );
});

test("legacy Windows review headers remain v1-readable and append through canonical comparison while new headers still require POSIX keys", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-legacy-windows-record-project-"));
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-legacy-windows-record-state-"));
  const posixHeader = {
    ...header(),
    targetShotHashes: { home: { "nested/home.capture.png": HASH } },
  };
  const legacyHeader = {
    ...posixHeader,
    targetShotHashes: { home: { "nested\\home.capture.png": HASH } },
  };
  const publishedShotHashes = schemas()["review-event.v1.json"].$defs.header.properties.targetShotHashes;
  assert.equal(
    publishedShotHashes.additionalProperties.propertyNames,
    undefined,
    "the published v1 schema must not retroactively reject Windows path keys",
  );
  assert.equal(
    validateReviewEvents([legacyHeader]).valid,
    true,
    "the schema companion validator must keep a stored legacy header readable",
  );
  const options = {
    projectRoot: root,
    stateDir,
    targetIds: ["home"],
    capturedTargetIds: ["home"],
    capturedTargetOutcomes: { home: "captured" },
    capturedTargetShotHashes: posixHeader.targetShotHashes,
  };
  const path = resolveReviewPath(legacyHeader, options);
  mkdirSync(dirname(path), { recursive: true });
  const storedBytes = `${JSON.stringify(legacyHeader)}\n${JSON.stringify(initial(FINDING_A, "44444444-4444-4444-8444-444444444444"))}\n`;
  writeFileSync(path, storedBytes);

  const warnings = [];
  const originalError = console.error;
  console.error = (message) => warnings.push(String(message));
  let appended;
  try {
    appended = appendReviewRecord([
      posixHeader,
      verification(FINDING_A, "55555555-5555-4555-8555-555555555555"),
      disposition(FINDING_A, "66666666-6666-4666-8666-666666666666"),
      seal(1, "77777777-7777-4777-8777-777777777777", [FINDING_A]),
    ], options);
  } finally {
    console.error = originalError;
  }

  assert.equal(appended.completeness.complete, true);
  assert.deepEqual(readLog(path).map((event) => event.kind), ["record-header", "initial", "verification", "disposition", "seal"]);
  assert.equal(warnings.filter((warning) => warning.includes("legacy Windows shot-hash keys")).length, 1);
  assert.ok(warnings[0].includes(path), "the warning must name the legacy review log");
  assert.ok(readFileSync(path, "utf8").startsWith(storedBytes), "the stored legacy header and initial event bytes must remain unchanged");

  const newStateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-new-windows-record-state-"));
  const newOptions = { ...options, stateDir: newStateDir };
  const rejectedPath = resolveReviewPath(legacyHeader, newOptions);
  assert.throws(
    () => appendReviewRecord([legacyHeader], newOptions),
    /append policy:.*must use forward-slash POSIX path separators/,
  );
  assert.equal(existsSync(rejectedPath), false);
});

test("legacy crop logs remain schema-valid and can append their digest-less disposition, while new crop events require one by append policy", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-legacy-record-project-"));
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-legacy-record-state-"));
  const options = { projectRoot: root, stateDir, targetIds: ["home"] };
  const legacyFinding = { ...candidate(FINDING_A), cropId: "legacy-crop" };
  const legacyFinal = { ...legacyFinding, verifierVerdict: "confirmed", disposition: "accepted" };
  const legacyInitialId = "44444444-4444-4444-8444-444444444444";
  const legacyDispositionId = "66666666-6666-4666-8666-666666666666";
  const legacy = [
    header(),
    { kind: "initial", version: 1, eventId: legacyInitialId, at: "2026-08-11T10:01:00Z", finding: legacyFinding },
    verification(FINDING_A, "55555555-5555-4555-8555-555555555555"),
  ];
  assert.equal(validateReviewEvents(legacy).valid, true, "published schemas must keep old crop-backed events readable");
  const path = resolveReviewPath(legacy[0], options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${legacy.map((event) => JSON.stringify(event)).join("\n")}\n`);

  const warnings = [];
  const originalError = console.error;
  console.error = (message) => warnings.push(String(message));
  try {
    const appended = appendReviewRecord([
      header(),
      { kind: "disposition", version: 1, eventId: legacyDispositionId, at: "2026-08-11T10:03:00Z", finding: legacyFinal },
      seal(1, "77777777-7777-4777-8777-777777777777", [FINDING_A]),
    ], options);
    assert.equal(appended.completeness.complete, true);
  } finally {
    console.error = originalError;
  }
  assert.match(warnings.join("\n"), /WARNING: accepting legacy crop-backed review event/);
  assert.match(warnings.join("\n"), new RegExp(legacyInitialId));

  const newCropFinding = { ...candidate(FINDING_B), cropId: "new-crop" };
  const newOptions = { ...options, stateDir: mkdtempSync(join(tmpdir(), "autoreview-ui-new-crop-policy-state-")) };
  assert.throws(
    () => appendReviewRecord([
      header(),
      { kind: "initial", version: 1, eventId: "88888888-8888-4888-8888-888888888888", at: "2026-08-11T10:04:00Z", finding: newCropFinding },
    ], newOptions),
    /append policy: crop-backed initial event 88888888-8888-4888-8888-888888888888 must include cropDigest/,
  );
});

test("ui-review --record serializes concurrent appends and rejects state output under the project root", async () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-record-project-"));
  const home = mkdtempSync(join(tmpdir(), "autoreview-ui-record-home-"));
  const configPath = writeRecordConfig(root);
  const { runDir } = writeCompletedCaptureRun(root);
  const firstPath = join(root, "first.json");
  const secondPath = join(root, "second.json");
  writeFileSync(firstPath, JSON.stringify([header(), initial(FINDING_A, "44444444-4444-4444-8444-444444444444")]));
  writeFileSync(secondPath, JSON.stringify([header(), initial(FINDING_B, "55555555-5555-4555-8555-555555555555")]));
  const env = { ...process.env, HOME: home };
  const [first, second] = await Promise.all([
    runCli(["--config", configPath, "--record", firstPath, "--run", runDir, "--json"], env),
    runCli(["--config", configPath, "--record", secondPath, "--run", runDir, "--json"], env),
  ]);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const report = JSON.parse(first.stdout);
  const events = readLog(report.review.path);
  assert.equal(events.length, 3, JSON.stringify(events));
  assert.equal(events[0].kind, "record-header");
  assert.deepEqual(new Set(events.slice(1).map((event) => event.finding.id)), new Set([FINDING_A, FINDING_B]));

  const rootOutput = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--record", firstPath, "--run", runDir],
    { encoding: "utf8", env: { ...process.env, HOME: root } },
  );
  assert.equal(rootOutput.status, 2, rootOutput.stdout);
  assert.match(rootOutput.stderr, /library state root is inside project root and is rejected/);
});

test("ui-review --record takes the project library lease before validating a capture run", async () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-record-project-"));
  const home = mkdtempSync(join(tmpdir(), "autoreview-ui-record-home-"));
  const stateDir = join(home, ".local", "state", "autoreview-ui");
  const configPath = writeRecordConfig(root);
  const { runDir } = writeCompletedCaptureRun(root);
  const eventsPath = join(root, "events.json");
  writeFileSync(eventsPath, JSON.stringify([header(), initial(FINDING_A, "44444444-4444-4444-8444-444444444444")]));
  const lease = acquireLibraryLock({ name: "fixture", root }, stateDir);
  const reviewPath = resolveReviewPath(header(), { projectRoot: root, stateDir });
  try {
    const pending = runCli(
      ["--config", configPath, "--record", eventsPath, "--run", runDir, "--json"],
      { ...process.env, HOME: home },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(reviewPath), false);
    releaseLibraryLock(lease);
    const result = await pending;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(reviewPath), true);
  } finally {
    if (existsSync(lease.lockPath)) releaseLibraryLock(lease);
  }
});

test("ui-review --record safely reclaims a dead writer lock while concurrent writers race", async () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-record-project-"));
  const home = mkdtempSync(join(tmpdir(), "autoreview-ui-record-home-"));
  const configPath = writeRecordConfig(root);
  const { runDir } = writeCompletedCaptureRun(root);
  const firstPath = join(root, "first.json");
  const secondPath = join(root, "second.json");
  writeFileSync(firstPath, JSON.stringify([header(), initial(FINDING_A, "44444444-4444-4444-8444-444444444444")]));
  writeFileSync(secondPath, JSON.stringify([header(), initial(FINDING_B, "55555555-5555-4555-8555-855555555555")]));
  const deadWriter = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(deadWriter.status, 0);
  const stateDir = join(home, ".local", "state", "autoreview-ui");
  const reviewPath = resolveReviewPath(header(), { projectRoot: root, stateDir });
  const lockPath = `${reviewPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify({ pid: deadWriter.pid, createdAt: Date.now() })}\n`, { mode: 0o600 });

  const env = { ...process.env, HOME: home };
  const [first, second] = await Promise.all([
    runCli(["--config", configPath, "--record", firstPath, "--run", runDir, "--json"], env),
    runCli(["--config", configPath, "--record", secondPath, "--run", runDir, "--json"], env),
  ]);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(readLog(reviewPath).length, 3);
  assert.equal(existsSync(lockPath), false);
});

test("ui-review --record binds events to one completed capture run and its shot hashes", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-record-project-"));
  const home = mkdtempSync(join(tmpdir(), "autoreview-ui-record-home-"));
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "fixture",
      root,
      baseUrl: "http://127.0.0.1:9",
      intentDoc: "skill:projects/intent/.gitkeep",
      routes: [
        { id: "home", route: "home" },
        { id: "settings", route: "settings" },
      ],
    }),
  );
  const { runDir, targetShotHashes } = writeCompletedCaptureRun(root, { targetIds: ["home"] });
  const eventsPath = join(root, "events.json");
  const runCliSync = (events, args = []) => {
    writeFileSync(eventsPath, JSON.stringify(events));
    return spawnSync(
      process.execPath,
      [UI_REVIEW, "--config", configPath, "--record", eventsPath, ...args],
      { encoding: "utf8", env: { ...process.env, HOME: home } },
    );
  };

  assert.match(
    runCliSync([header()]).stderr,
    /requires --run <capture-dir> from a completed capture/,
  );

  const wrongRun = header();
  wrongRun.runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const wrongRunResult = runCliSync([wrongRun], ["--run", runDir]);
  assert.equal(wrongRunResult.status, 2, wrongRunResult.stdout);
  assert.match(wrongRunResult.stderr, /record header runId .* does not match capture run/);

  const uncapturedTarget = header();
  uncapturedTarget.targets = ["settings"];
  const uncapturedResult = runCliSync([uncapturedTarget], ["--run", runDir]);
  assert.equal(uncapturedResult.status, 2, uncapturedResult.stdout);
  assert.match(uncapturedResult.stderr, /references target settings not present in the capture run/);

  const wrongShotHash = header();
  wrongShotHash.targetShotHashes = {
    home: { "home.capture.png": `sha256:${"0".repeat(64)}` },
  };
  const wrongHashResult = runCliSync([wrongShotHash], ["--run", runDir]);
  assert.equal(wrongHashResult.status, 2, wrongHashResult.stdout);
  assert.match(wrongHashResult.stderr, /must match the captured shot hash/);

  const boundHeader = header();
  boundHeader.targetShotHashes = targetShotHashes;
  const boundResult = runCliSync([boundHeader], ["--run", runDir, "--json"]);
  assert.equal(boundResult.status, 0, boundResult.stderr || boundResult.stdout);
  const report = JSON.parse(boundResult.stdout);
  assert.equal(report.review.status, "unsealed");
  assert.equal(report.review.complete, false);

  const runPath = join(runDir, "run.json");
  const incompleteRun = JSON.parse(readFileSync(runPath, "utf8"));
  incompleteRun.captureComplete = false;
  writeFileSync(runPath, JSON.stringify(incompleteRun));
  const incompleteResult = runCliSync([boundHeader], ["--run", runDir]);
  assert.equal(incompleteResult.status, 2, incompleteResult.stdout);
  assert.match(incompleteResult.stderr, /must name a completed capture/);

  incompleteRun.captureComplete = true;
  incompleteRun.targetOutcomes.home = "failed";
  incompleteRun.targetShotHashes.home = {};
  writeFileSync(runPath, JSON.stringify(incompleteRun));
  const mislabelledRunResult = runCliSync([boundHeader], ["--run", runDir]);
  assert.equal(mislabelledRunResult.status, 2, mislabelledRunResult.stdout);
  assert.match(mislabelledRunResult.stderr, /claims complete but failed targets: home \(failed\); targets without hashed PNGs: home/);

  incompleteRun.targetOutcomes.home = "captured";
  incompleteRun.targetShotHashes = targetShotHashes;
  writeFileSync(runPath, JSON.stringify(incompleteRun));
  writeFileSync(join(runDir, "shots", "home.capture.png"), "mutated capture\n");
  const mutatedCaptureResult = runCliSync([boundHeader], ["--run", runDir]);
  assert.equal(mutatedCaptureResult.status, 2, mutatedCaptureResult.stdout);
  assert.match(mutatedCaptureResult.stderr, /captured shot hash no longer matches run identity/);
});

test("stale-lock recovery backs off when another reclaimer holds the stale inode", () => {
  const directory = mkdtempSync(join(tmpdir(), "autoreview-ui-reclaim-"));
  const lockPath = join(directory, "review.json.lock");
  const otherClaimPath = join(directory, "other-reclaimer.claim");
  writeFileSync(lockPath, `${JSON.stringify({ pid: 999_999_999, createdAt: Date.now() })}\n`, { mode: 0o600 });
  const staleInode = statSync(lockPath).ino;

  // Model a first writer which has linked the stale inode, just before a
  // second writer attempts recovery. The second must leave the public name
  // alone, rather than risking an unlink after the first installs a live lock.
  linkSync(lockPath, otherClaimPath);
  assert.equal(reclaimStaleLock(lockPath), false);
  assert.equal(statSync(lockPath).ino, staleInode);

  unlinkSync(otherClaimPath);
  assert.equal(reclaimStaleLock(lockPath), true);
  assert.equal(existsSync(lockPath), false);
});

test("lock snapshots read metadata and identity from one descriptor", () => {
  const directory = mkdtempSync(join(tmpdir(), "autoreview-ui-lock-snapshot-"));
  const lockPath = join(directory, "review.json.lock");
  const replacementPath = join(directory, "replacement.lock");
  const staleMetadata = { pid: 999_999_999, createdAt: Date.now() };
  const liveMetadata = { pid: process.pid, createdAt: Date.now() };
  writeFileSync(lockPath, `${JSON.stringify(staleMetadata)}\n`, { mode: 0o600 });
  writeFileSync(replacementPath, `${JSON.stringify(liveMetadata)}\n`, { mode: 0o600 });
  const staleStat = statSync(lockPath);

  const fs = require("node:fs");
  const originalOpenSync = fs.openSync;
  const originalFstatSync = fs.fstatSync;
  let openedFd;
  let readSnapshot;
  fs.openSync = (path, flags, ...args) => {
    const fd = originalOpenSync(path, flags, ...args);
    if (path === lockPath && flags === "r") {
      openedFd = fd;
      unlinkSync(lockPath);
      renameSync(replacementPath, lockPath);
    }
    return fd;
  };
  fs.fstatSync = (fd, ...args) => {
    assert.equal(fd, openedFd);
    return originalFstatSync(fd, ...args);
  };
  delete require.cache[REVIEW_RECORD];
  try {
    ({ readLockSnapshot: readSnapshot } = require("../scripts/review-record.cjs"));
    const snapshot = readSnapshot(lockPath);
    assert.deepEqual(snapshot, { ...staleMetadata, dev: staleStat.dev, ino: staleStat.ino });
    assert.notEqual(statSync(lockPath).ino, staleStat.ino);
  } finally {
    fs.openSync = originalOpenSync;
    fs.fstatSync = originalFstatSync;
    delete require.cache[REVIEW_RECORD];
  }
});

test("external session uses the AX boundary before capture and fails on a missing marker", async () => {
  const capture = { session: { readiness: "id=e2e-boot-settled", timeoutMs: 800 } };
  const matched = await assertCaptureSession(capture, { udid: "sim-1" }, {
    describeUi: () => [{ AXUniqueId: "e2e-boot-settled", type: "View", children: [] }],
  });
  assert.equal(matched.id, "e2e-boot-settled");

  let elapsed = 0;
  await assert.rejects(
    assertCaptureSession(capture, { udid: "sim-1" }, {
      describeUi: () => [],
      now: () => elapsed,
      sleep: async (ms) => { elapsed += ms; },
    }),
    /readiness "id=e2e-boot-settled" not found within 800ms/,
  );
});

test("external session bounds each AXe read by its remaining deadline and retains AXe errors", async () => {
  const capture = { session: { readiness: "id=e2e-boot-settled", timeoutMs: 800 } };
  let elapsed = 0;
  const timeouts = [];
  await assert.rejects(
    assertCaptureSession(capture, { udid: "sim-1" }, {
      describeUi: (_udid, options) => {
        timeouts.push(options.timeout);
        throw new Error("AXe connection lost");
      },
      now: () => elapsed,
      sleep: async (ms) => { elapsed += ms; },
    }),
    /readiness "id=e2e-boot-settled" not found within 800ms.*Last AXe error: AXe connection lost/,
  );
  assert.deepEqual(timeouts, [800, 400]);
});

test("groups expand through --targets before the RN simulator toolchain is consulted", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-groups-"));
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      configVersion: 2,
      name: "groups",
      root,
      baseUrl: "http://127.0.0.1:9",
      intentDoc: "skill:projects/intent/.gitkeep",
      capture: { mode: "rn-sim", bundleId: "com.example.app", scheme: "example" },
      groups: { smoke: ["hidden"] },
      routes: [{ id: "hidden", route: "hidden", interactions: [{ id: "bad", action: "hover", selector: "label=Go" }] }],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--targets", "smoke", "--no-scan", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /target "hidden" interaction "bad"/);
});

test("target IDs are safe path segments in the schema, validator, and both capture drivers", () => {
  const targetSchema = schemas()["config.v2.json"].$defs.target.properties.id;
  assert.equal(targetSchema.pattern, "^[A-Za-z0-9_-]+$");

  for (const id of ["../../path/in/project/foo", "with.dot", "with/slash", ""]) {
    const validation = validateConfig({
      name: "fixture",
      root: "/tmp/fixture",
      baseUrl: "http://127.0.0.1:9",
      routes: [{ id, route: "/" }],
    });
    assert.equal(validation.valid, false, id);
    assert.match(validation.errors.join("\n"), /safe path segment/, id);
  }

  const outDir = mkdtempSync(join(tmpdir(), "autoreview-ui-target-id-"));
  assert.throws(() => targetOutputPath(outDir, "../../path/in/project/foo", ".manifest.json"), /safe path segment/);

  for (const driver of ["shoot.mjs", "shoot-rn.mjs"]) {
    const root = mkdtempSync(join(tmpdir(), "autoreview-ui-driver-target-id-"));
    const driverOut = join(root, "shots");
    const runPath = join(root, "run.json");
    const run = {
      outDir: driverOut,
      targets: [{ id: "../../path/in/project/foo", route: "/" }],
    };
    if (driver === "shoot-rn.mjs") run.capture = { scheme: "fixture", bundleId: "com.example.fixture" };
    writeFileSync(runPath, JSON.stringify(run));

    const result = spawnSync(process.execPath, [join(__dirname, "..", "scripts", driver), "--run", runPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1, `${driver}: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, /safe path segment/, driver);
    assert.equal(existsSync(driverOut), false, `${driver} created its output directory`);
  }
});

test("target selection ignores inherited properties and config rejects group/target collisions", () => {
  const targets = [
    { id: "constructor", route: "/constructor" },
    { id: "toString", route: "/to-string" },
    { id: "home", route: "/" },
  ];
  const inherited = selectTargets({ routes: targets, groups: {} }, { targets: ["constructor", "toString"] });
  assert.deepEqual(inherited.targets.map((target) => target.id), ["constructor", "toString"]);

  const ownConstructor = selectTargets(
    { routes: targets, groups: JSON.parse('{"constructor":["home"]}') },
    { targets: ["constructor"] },
  );
  assert.deepEqual(ownConstructor.targets.map((target) => target.id), ["home"]);

  const collision = validateConfig({
    name: "fixture",
    root: "/tmp/fixture",
    baseUrl: "http://127.0.0.1:9",
    routes: [{ id: "home", route: "/" }],
    groups: { home: ["home"] },
  });
  assert.equal(collision.valid, false);
  assert.match(collision.errors.join("\n"), /must not share a name with a target id/);
});

test("web and RN capture URLs merge target.params without clobbering route queries", () => {
  const params = { devStage: "performing", preview: true, retry: 2, optional: null };
  assert.equal(
    composeWebUrl("http://127.0.0.1:3000", "/perform?devStage=results&keep=route#recap", params),
    "http://127.0.0.1:3000/perform?devStage=results&keep=route&preview=true&retry=2&optional=null#recap",
  );
  assert.equal(
    composeDeepLinkUrl("acmemobile", "acmemobile://perform?devStage=results", params),
    "acmemobile://perform?devStage=results&preview=true&retry=2&optional=null",
  );

  assert.equal(
    validateConfig({
      name: "fixture",
      root: "/tmp/fixture",
      baseUrl: "http://127.0.0.1:9",
      routes: [{ id: "perform", route: "/perform?devStage=results", params }],
    }).valid,
    true,
  );
  assert.match(
    validateConfig({
      name: "fixture",
      root: "/tmp/fixture",
      baseUrl: "http://127.0.0.1:9",
      routes: [{ id: "perform", route: "/perform", params: { invalid: { nested: true } } }],
    }).errors.join("\n"),
    /config\.routes\[0\]\.params\.invalid: must be a string, number, boolean, or null/,
  );
});

test("captureVariants requires at least one variant in both JSON Schema and runtime validation", () => {
  const captureVariants = schemas()["config.v2.json"].$defs.target.properties.captureVariants;
  assert.equal(captureVariants.minItems, 1);
  assert.match(
    validateConfig({
      configVersion: 2,
      name: "fixture",
      root: "/tmp/fixture",
      baseUrl: "http://127.0.0.1:9",
      routes: [{ id: "home", route: "/", captureVariants: [] }],
    }).errors.join("\n"),
    /captureVariants: must be a non-empty array of strings/,
  );
});

test("the shipped example config uses a valid path-safe name", () => {
  const shipped = [
    "example.json",
  ];
  for (const name of shipped) {
    const source = JSON.parse(readFileSync(join(PROJECTS, name), "utf8"));
    assert.equal(validateConfig(source).valid, true, name);
    const normalized = normalizeConfig(source);
    assert.equal(normalized.configVersion, 2, name);
    assert.deepEqual(normalized.routes, source.routes, name);
  }
});
