"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const { basename, dirname, join } = require("node:path");

const UI_REVIEW = join(__dirname, "..", "scripts", "ui-review");
const REVIEW_RECORD = require.resolve("../scripts/review-record.cjs");
const { appendJsonLines } = require("../scripts/review-record.cjs");
const { changedFingerprintReason, fingerprintTarget, gitProvenance, untrackedPatchMaterial } = require("../scripts/fingerprint.cjs");
const {
  latestAssetPath,
  manifestPath,
  persistRunBundle,
  pruneLibraryRuns,
  readManifestLines,
  runDirectory,
} = require("../scripts/library.cjs");
const { finalizeCaptureRun, loadCompletedCaptureRun } = require("../scripts/ui-review");

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";
const RUN_C = "33333333-3333-4333-8333-333333333333";

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-library-project-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "Screen.tsx"), "export const Screen = () => null;\n");
  return root;
}

function config(root, overrides = {}) {
  const target = {
    id: "home",
    route: "/home",
    params: { tab: "main" },
    sourceFiles: ["src/Screen.tsx"],
    captureVariants: ["default"],
    interactions: [{ id: "open", action: "tap", selector: "label=Open" }],
  };
  return {
    name: "fixture",
    root,
    baseUrl: "http://127.0.0.1:9",
    capture: { mode: "rn-sim", bundleId: "com.example.fixture", appearance: ["light", "dark"], appBuild: "1.0.0" },
    routes: [target],
    ...overrides,
  };
}

function makeCaptureOut(cfg, {
  runId = RUN_A,
  targets = cfg.routes,
  targetOutcomes = Object.fromEntries(targets.map((target) => [target.id, "captured"])),
  targetAssets,
} = {}) {
  const outDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-out-"));
  const shotsDir = join(outDir, "shots");
  mkdirSync(shotsDir);
  const assets = targetAssets ?? {
    home: {
      shots: [
        { viewport: "iPhone-dark", kind: "full", file: "home.dark.full.png", bytes: "dark full" },
        { viewport: "iPhone-light", kind: "clip", file: "home.light.clip.png", bytes: "light clip" },
      ],
      interactions: [
        { id: "open", viewport: "iPhone-dark", file: "home.dark.open.png", bytes: "dark interaction" },
      ],
    },
  };
  const manifestTargets = targets.map((target) => {
    const entries = assets[target.id] || { shots: [], interactions: [] };
    return {
      id: target.id,
      route: target.route,
      outcome: targetOutcomes[target.id],
      reason: targetOutcomes[target.id] === "captured" ? null : "fixture target failed",
      shots: entries.shots.map((shot) => {
        const path = join(shotsDir, shot.file);
        writeFileSync(path, shot.bytes);
        return { viewport: shot.viewport, kind: shot.kind, path };
      }),
      interactions: entries.interactions.map((interaction) => {
        const statePath = join(shotsDir, interaction.file);
        writeFileSync(statePath, interaction.bytes);
        return { id: interaction.id, viewport: interaction.viewport, statePath };
      }),
    };
  });
  const manifest = {
    viewports: [
      { name: "iPhone-light", appearance: "light" },
      { name: "iPhone-dark", appearance: "dark" },
    ],
    device: { name: "iPhone", udid: "fixture", runtime: "iOS" },
    targets: manifestTargets,
  };
  writeFileSync(join(shotsDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const target of manifestTargets) writeFileSync(join(shotsDir, `${target.id}.manifest.json`), JSON.stringify(target, null, 2));
  const targetFingerprints = Object.fromEntries(targets.map((target) => [target.id, fingerprintTarget(cfg, target)]));
  const run = {
    runId,
    project: cfg.name,
    targetIds: targets.map((target) => target.id),
    targets,
    targetOutcomes,
    targetFingerprints,
    captureComplete: Object.values(targetOutcomes).every((outcome) => outcome === "captured"),
    completedAt: "2026-08-11T10:00:00.000Z",
    outDir: shotsDir,
  };
  const bundle = {
    project: cfg.name,
    outDir,
    shots: manifest,
    library: { mode: "persistent", stateDir: null, runDir: null, records: 0 },
  };
  writeFileSync(join(outDir, "run.json"), JSON.stringify(run, null, 2));
  writeFileSync(join(outDir, "bundle.json"), JSON.stringify(bundle, null, 2));
  return { outDir, shotsDir, manifest, run, bundle };
}

function provenance() {
  return {
    branch: "main",
    commit: "abcdef1234567",
    patchHash: null,
    appBuild: "1.0.0",
    device: { name: "iPhone", udid: "fixture", runtime: "iOS" },
  };
}

test("library identity matrix persists independent latest bytes for appearance, variant, interaction, and crop", () => {
  const root = fixtureRoot();
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const cfg = config(root);
  const capture = makeCaptureOut(cfg);
  const persisted = persistRunBundle({ cfg, outDir: capture.outDir, bundle: capture.bundle, provenance: provenance(), stateDir });

  assert.equal(existsSync(join(persisted.runDir, "run.json")), true);
  assert.equal(existsSync(join(persisted.runDir, "bundle.json")), true);
  assert.equal(existsSync(join(persisted.runDir, "shots", "manifest.json")), true);
  const darkFull = latestAssetPath(cfg.name, { targetId: "home", appearance: "dark", variant: "full", interaction: null, crop: null }, stateDir);
  const lightClip = latestAssetPath(cfg.name, { targetId: "home", appearance: "light", variant: "clip", interaction: null, crop: "clip" }, stateDir);
  const opened = latestAssetPath(cfg.name, { targetId: "home", appearance: "dark", variant: "default", interaction: "open", crop: null }, stateDir);
  assert.equal(readFileSync(darkFull, "utf8"), "dark full");
  assert.equal(readFileSync(lightClip, "utf8"), "light clip");
  assert.equal(readFileSync(opened, "utf8"), "dark interaction");
  for (const path of [darkFull, lightClip, opened]) assert.equal(lstatSync(path).isSymbolicLink(), false);
  const records = readManifestLines(cfg.name, stateDir);
  assert.equal(records.filter((record) => record.recordType === "asset").length, 3);
  assert.equal(records.filter((record) => record.recordType === "target").length, 1);
  assert.equal(records.every((record) => record.runId === RUN_A && record.takenAt.endsWith("Z")), true);
  assert.deepEqual(JSON.parse(readFileSync(join(persisted.runDir, "bundle.json"), "utf8")).library, {
    mode: "persistent",
    stateDir: join(stateDir, cfg.name),
    runDir: persisted.runDir,
    manifest: persisted.manifest,
    records: persisted.records,
    retention: persisted.retention,
  });
});

test("library folds the Playwright viewport sweep into variant so latest keeps every width", () => {
  const root = fixtureRoot();
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const cfg = config(root, {
    capture: { mode: "playwright" },
    viewports: [{ name: "mobile", width: 375, height: 812 }, { name: "desktop", width: 1440, height: 900 }],
  });
  const capture = makeCaptureOut(cfg, {
    targetAssets: {
      home: {
        shots: [
          { viewport: "mobile", kind: "full", file: "home.mobile.png", bytes: "mobile" },
          { viewport: "desktop", kind: "full", file: "home.desktop.png", bytes: "desktop" },
        ],
        interactions: [],
      },
    },
  });
  persistRunBundle({ cfg, outDir: capture.outDir, bundle: capture.bundle, provenance: provenance(), stateDir });
  const mobile = latestAssetPath(cfg.name, { targetId: "home", appearance: "default", variant: "mobile:full", interaction: null, crop: null }, stateDir);
  const desktop = latestAssetPath(cfg.name, { targetId: "home", appearance: "default", variant: "desktop:full", interaction: null, crop: null }, stateDir);
  assert.equal(readFileSync(mobile, "utf8"), "mobile");
  assert.equal(readFileSync(desktop, "utf8"), "desktop");
});

test("library rejects a duplicate run without removing the prior durable publication", () => {
  const root = fixtureRoot();
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const cfg = config(root);
  const capture = makeCaptureOut(cfg);
  const first = persistRunBundle({ cfg, outDir: capture.outDir, bundle: capture.bundle, provenance: provenance(), stateDir });
  const originalRun = readFileSync(join(first.runDir, "run.json"), "utf8");

  assert.throws(
    () => persistRunBundle({ cfg, outDir: capture.outDir, bundle: capture.bundle, provenance: provenance(), stateDir }),
    /library run already exists and is not overwritten/,
  );
  assert.equal(readFileSync(join(first.runDir, "run.json"), "utf8"), originalRun);
});

test("library rejects a state root that resolves inside the project before writing or pruning", () => {
  const root = fixtureRoot();
  const cfg = config(root, { name: basename(root) });
  const capture = makeCaptureOut(cfg);
  const stateDir = dirname(root);

  assert.throws(
    () => persistRunBundle({ cfg, outDir: capture.outDir, bundle: capture.bundle, provenance: provenance(), stateDir }),
    /library state root is inside project root and is rejected/,
  );
  assert.throws(
    () => pruneLibraryRuns(cfg, { stateDir }),
    /library state root is inside project root and is rejected/,
  );
  assert.equal(existsSync(join(root, "runs")), false);
  assert.equal(existsSync(join(root, "latest")), false);
  assert.equal(existsSync(join(root, "manifest.jsonl")), false);
});

test("library preserves successful partial-run assets while recording failed targets explicitly", () => {
  const root = fixtureRoot();
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const cfg = config(root, {
    routes: [
      ...config(root).routes,
      { id: "settings", route: "/settings", sourceFiles: ["src/Screen.tsx"], captureVariants: ["default"] },
    ],
  });
  const capture = makeCaptureOut(cfg, {
    targets: cfg.routes,
    targetOutcomes: { home: "captured", settings: "failed" },
    targetAssets: {
      home: { shots: [{ viewport: "iPhone-dark", kind: "full", file: "home.png", bytes: "home bytes" }], interactions: [] },
      settings: { shots: [], interactions: [] },
    },
  });
  const persisted = persistRunBundle({ cfg, outDir: capture.outDir, bundle: capture.bundle, provenance: provenance(), stateDir });
  assert.equal(existsSync(join(persisted.runDir, "shots", "home.png")), true);
  const lines = readManifestLines(cfg.name, stateDir);
  assert.equal(lines.some((line) => line.targetId === "settings" && line.recordType === "target" && line.outcome === "failed"), true);
  const latest = latestAssetPath(cfg.name, { targetId: "home", appearance: "dark", variant: "full", interaction: null, crop: null }, stateDir);
  assert.equal(readFileSync(latest, "utf8"), "home bytes");
});

function runChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("manifest.jsonl parallel appends use the review-record lock discipline", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const path = join(stateDir, "manifest.jsonl");
  const script = `const {appendJsonLines}=require(${JSON.stringify(REVIEW_RECORD)}); appendJsonLines(process.argv[1], [JSON.parse(process.argv[2])]);`;
  const jobs = Array.from({ length: 16 }, (_, index) => runChild([
    "-e", script, path, JSON.stringify({ worker: index, takenAt: "2026-08-11T10:00:00.000Z" }),
  ]));
  const results = await Promise.all(jobs);
  for (const result of results) assert.equal(result.status, 0, result.stderr || result.stdout);
  const lines = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 16);
  assert.deepEqual(new Set(lines.map((line) => line.worker)), new Set(Array.from({ length: 16 }, (_, index) => index)));
});

test("library publication keeps latest bytes aligned with the last committed manifest transaction", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const script = `
    const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const { persistRunBundle } = require(${JSON.stringify(require.resolve("../scripts/library.cjs"))});
    const [stateDir, runId] = process.argv.slice(1);
    const root = mkdtempSync(join(tmpdir(), "autoreview-ui-library-child-root-"));
    const outDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-child-out-"));
    const shotsDir = join(outDir, "shots");
    mkdirSync(shotsDir);
    const image = join(shotsDir, "home.png");
    writeFileSync(image, "bytes-" + runId);
    const manifest = { targets: [{ id: "home", shots: [{ viewport: "mobile", kind: "full", path: image }], interactions: [] }] };
    const run = { runId, targetIds: ["home"], targets: [{ id: "home" }], targetOutcomes: { home: "captured" }, completedAt: "2026-08-11T10:00:00.000Z" };
    writeFileSync(join(shotsDir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(outDir, "run.json"), JSON.stringify(run));
    persistRunBundle({
      cfg: { name: "fixture", root, capture: { mode: "playwright" } },
      outDir,
      bundle: { project: "fixture", outDir, shots: manifest, library: { mode: "persistent", runDir: null, records: 0 } },
      provenance: { branch: "main", commit: "fixture", patchHash: null, appBuild: null, device: null },
      stateDir,
    });
  `;
  const runIds = Array.from({ length: 8 }, (_, index) => `concurrent-${index}`);
  const results = await Promise.all(runIds.map((runId) => runChild(["-e", script, stateDir, runId])));
  for (const result of results) assert.equal(result.status, 0, result.stderr || result.stdout);

  const records = readManifestLines("fixture", stateDir);
  const lastTarget = [...records].reverse().find((record) => record.recordType === "target");
  const latestRecord = [...records].reverse().find((record) => record.runId === lastTarget.runId && record.recordType === "asset");
  assert.equal(readFileSync(join(stateDir, "fixture", latestRecord.latestPath), "utf8"), `bytes-${lastTarget.runId}`);
});

test("library leaves latest and prior runs untouched when the manifest path is unsafe", () => {
  const root = fixtureRoot();
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const cfg = config(root, { library: { keepRuns: 1 } });
  writeStoredRun(stateDir, cfg.name, "prior-run", "2026-08-11T08:00:00.000Z", 32);
  const latest = latestAssetPath(
    cfg.name,
    { targetId: "home", appearance: "dark", variant: "full", interaction: null, crop: null },
    stateDir,
  );
  mkdirSync(dirname(latest), { recursive: true });
  writeFileSync(latest, "prior latest bytes");
  mkdirSync(manifestPath(cfg.name, stateDir));

  const capture = makeCaptureOut(cfg);
  assert.throws(
    () => persistRunBundle({ cfg, outDir: capture.outDir, bundle: capture.bundle, provenance: provenance(), stateDir }),
    /library state file is unsafe/,
  );

  assert.equal(readFileSync(latest, "utf8"), "prior latest bytes");
  assert.equal(existsSync(runDirectory(cfg.name, "prior-run", stateDir)), true);
  assert.equal(existsSync(runDirectory(cfg.name, RUN_A, stateDir)), true);
  assert.equal(lstatSync(manifestPath(cfg.name, stateDir)).isDirectory(), true);
});

test("library rolls back partial latest publication and reclaims its uncommitted run on retry", () => {
  const root = fixtureRoot();
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const cfg = config(root);
  const capture = makeCaptureOut(cfg);
  const interaction = latestAssetPath(
    cfg.name,
    { targetId: "home", appearance: "dark", variant: "default", interaction: "open", crop: null },
    stateDir,
  );
  const full = latestAssetPath(
    cfg.name,
    { targetId: "home", appearance: "dark", variant: "full", interaction: null, crop: null },
    stateDir,
  );
  const blocked = latestAssetPath(
    cfg.name,
    { targetId: "home", appearance: "light", variant: "clip", interaction: null, crop: "clip" },
    stateDir,
  );
  mkdirSync(dirname(interaction), { recursive: true });
  writeFileSync(interaction, "prior interaction");
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "prior full");
  mkdirSync(blocked, { recursive: true });

  assert.throws(
    () => persistRunBundle({ cfg, outDir: capture.outDir, bundle: capture.bundle, provenance: provenance(), stateDir }),
    /library state file is unsafe/,
  );
  assert.equal(readFileSync(interaction, "utf8"), "prior interaction");
  assert.equal(readFileSync(full, "utf8"), "prior full");
  assert.deepEqual(readManifestLines(cfg.name, stateDir), []);
  assert.equal(existsSync(runDirectory(cfg.name, RUN_A, stateDir)), true);
  assert.equal(existsSync(join(runDirectory(cfg.name, RUN_A, stateDir), "library-install.marker")), true);

  rmSync(blocked, { recursive: true, force: false });
  const retried = persistRunBundle({ cfg, outDir: capture.outDir, bundle: capture.bundle, provenance: provenance(), stateDir });
  assert.equal(retried.runDir, runDirectory(cfg.name, RUN_A, stateDir));
  assert.equal(readFileSync(interaction, "utf8"), "dark interaction");
  assert.equal(readFileSync(full, "utf8"), "dark full");
  assert.equal(readFileSync(blocked, "utf8"), "light clip");
  assert.equal(readManifestLines(cfg.name, stateDir).every((record) => record.runId === RUN_A), true);
});

test("library refuses symlinked state components before publication, retry cleanup, pruning, or recursive deletion", () => {
  const root = fixtureRoot();
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const cfg = config(root);
  const projectDir = join(stateDir, cfg.name);
  const external = mkdtempSync(join(tmpdir(), "autoreview-ui-library-external-"));
  writeFileSync(join(external, "sentinel.txt"), "outside state");

  mkdirSync(projectDir, { recursive: true });
  symlinkSync(external, join(projectDir, "runs"));
  const capture = makeCaptureOut(cfg);
  assert.throws(
    () => persistRunBundle({ cfg, outDir: capture.outDir, bundle: capture.bundle, provenance: provenance(), stateDir }),
    /library state directory is unsafe/,
  );
  assert.equal(readFileSync(join(external, "sentinel.txt"), "utf8"), "outside state");
  unlinkSync(join(projectDir, "runs"));

  mkdirSync(join(projectDir, "runs"));
  symlinkSync(external, join(projectDir, "runs", RUN_A));
  assert.throws(
    () => persistRunBundle({ cfg, outDir: capture.outDir, bundle: capture.bundle, provenance: provenance(), stateDir }),
    /library state directory is unsafe/,
  );
  assert.equal(readFileSync(join(external, "sentinel.txt"), "utf8"), "outside state");
  unlinkSync(join(projectDir, "runs", RUN_A));

  symlinkSync(external, join(projectDir, "latest"));
  assert.throws(
    () => persistRunBundle({ cfg, outDir: capture.outDir, bundle: capture.bundle, provenance: provenance(), stateDir }),
    /library state directory is unsafe/,
  );
  assert.equal(readFileSync(join(external, "sentinel.txt"), "utf8"), "outside state");
  unlinkSync(join(projectDir, "latest"));

  const orphan = join(projectDir, "runs", "orphan");
  mkdirSync(orphan);
  writeFileSync(join(orphan, "library-install.marker"), JSON.stringify({ version: 1, runId: "orphan" }));
  symlinkSync(external, join(orphan, "nested"));
  assert.throws(() => pruneLibraryRuns(cfg, { stateDir }), /refuses recursive delete through symlink/);
  assert.equal(readFileSync(join(external, "sentinel.txt"), "utf8"), "outside state");
});

test("reconciliation reclaims only marked interrupted publications before retention", () => {
  const root = fixtureRoot();
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const cfg = { name: "fixture", root, library: { keepRuns: 1 } };
  writeStoredRun(stateDir, cfg.name, "committed", "2026-08-11T08:00:00.000Z", 8);
  commitStoredRun(stateDir, cfg.name, "committed");
  writeStoredRun(stateDir, cfg.name, "orphan", "2026-08-11T10:00:00.000Z", 8);
  markStoredRun(stateDir, cfg.name, "orphan");

  const retention = pruneLibraryRuns(cfg, { stateDir });
  assert.deepEqual(retention.removed, []);
  assert.deepEqual(retention.retained, ["committed"]);
  assert.equal(existsSync(runDirectory(cfg.name, "committed", stateDir)), true);
  assert.equal(existsSync(runDirectory(cfg.name, "orphan", stateDir)), false);
});

test("a pre-existing review-only run survives the first persistent capture and is excluded from retention", () => {
  const root = fixtureRoot();
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const cfg = config(root, { library: { keepRuns: 1 } });
  const reviewOnly = runDirectory(cfg.name, "historical-review", stateDir);
  mkdirSync(reviewOnly, { recursive: true });
  writeFileSync(join(reviewOnly, "review.json"), '{"historical":true}\n');

  const capture = makeCaptureOut(cfg);
  const persisted = persistRunBundle({
    cfg,
    outDir: capture.outDir,
    bundle: capture.bundle,
    provenance: provenance(),
    stateDir,
  });

  assert.equal(readFileSync(join(reviewOnly, "review.json"), "utf8"), '{"historical":true}\n');
  assert.deepEqual(persisted.retention.retained, [RUN_A]);
});

test("a --no-library review home survives a later persistent capture", () => {
  const root = fixtureRoot();
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const cfg = config(root, { library: { keepRuns: 1 } });
  const noLibraryCapture = makeCaptureOut(cfg, { runId: RUN_B });
  finalizeCaptureRun(join(noLibraryCapture.outDir, "run.json"), noLibraryCapture.run, noLibraryCapture.manifest, noLibraryCapture.shotsDir);
  const configPath = writeConfigFile(cfg);
  const eventsPath = join(noLibraryCapture.outDir, "events.json");
  writeFileSync(eventsPath, JSON.stringify([
    {
      kind: "record-header",
      version: 1,
      runId: RUN_B,
      project: cfg.name,
      configHash: `sha256:${"a".repeat(64)}`,
      commitHash: "abcdef1",
      patchHash: `sha256:${"b".repeat(64)}`,
      targets: ["home"],
      intentSource: "skill:projects/intent/fixture.md",
      rubricVersion: "2026-08",
      model: { provider: "openai", name: "codex" },
      createdAt: "2026-08-11T10:00:00Z",
    },
    {
      kind: "seal",
      version: 1,
      eventId: RUN_C,
      at: "2026-08-11T10:04:00Z",
      findingCount: 0,
    },
  ]));
  const record = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--record", eventsPath, "--run", noLibraryCapture.outDir, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: stateDir } },
  );
  assert.equal(record.status, 0, record.stderr || record.stdout);
  const reviewPath = join(runDirectory(cfg.name, RUN_B, stateDir), "review.json");
  assert.equal(existsSync(reviewPath), true);

  const persistentCapture = makeCaptureOut(cfg);
  persistRunBundle({
    cfg,
    outDir: persistentCapture.outDir,
    bundle: persistentCapture.bundle,
    provenance: provenance(),
    stateDir,
  });
  assert.equal(existsSync(reviewPath), true);
});

test("library-lock recovery rolls latest back from an uncommitted publish journal idempotently", () => {
  const root = fixtureRoot();
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const cfg = { name: "fixture", root };
  const projectDir = join(stateDir, cfg.name);
  const stagingName = `.latest-staging-${RUN_A}-123-456-abcd`;
  const latest = join(projectDir, "latest", "sentinel.png");
  const backup = join(projectDir, stagingName, ".latest-rollback", "latest", "sentinel.png");
  mkdirSync(dirname(latest), { recursive: true });
  mkdirSync(dirname(backup), { recursive: true });
  writeFileSync(latest, "new latest bytes");
  writeFileSync(backup, "prior latest bytes");
  mkdirSync(join(projectDir, "runs", RUN_A), { recursive: true });
  writeFileSync(join(projectDir, "runs", RUN_A, "run.json"), JSON.stringify({ completedAt: "2026-08-11T10:00:00.000Z" }));
  writeFileSync(join(projectDir, "runs", RUN_A, "library-install.marker"), JSON.stringify({ version: 1, runId: RUN_A }));
  writeFileSync(join(projectDir, "publish.journal.json"), JSON.stringify({
    version: 1,
    runId: RUN_A,
    stagingDir: stagingName,
    replacements: [{
      destination: "latest/sentinel.png",
      backup: `${stagingName}/.latest-rollback/latest/sentinel.png`,
    }],
  }));

  pruneLibraryRuns(cfg, { stateDir });
  assert.equal(readFileSync(latest, "utf8"), "prior latest bytes");
  assert.equal(existsSync(join(projectDir, "runs", RUN_A)), false);
  assert.equal(existsSync(join(projectDir, stagingName)), false);
  assert.equal(existsSync(join(projectDir, "publish.journal.json")), false);

  pruneLibraryRuns(cfg, { stateDir });
  assert.equal(readFileSync(latest, "utf8"), "prior latest bytes");
});

function writeStoredRun(stateDir, project, id, completedAt, bytes) {
  const dir = runDirectory(project, id, stateDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify({ completedAt }));
  writeFileSync(join(dir, "capture.bin"), "x".repeat(bytes));
}

function markStoredRun(stateDir, project, id) {
  writeFileSync(
    join(runDirectory(project, id, stateDir), "library-install.marker"),
    JSON.stringify({ version: 1, runId: id }),
  );
}

function commitStoredRun(stateDir, project, id) {
  appendJsonLines(manifestPath(project, stateDir), [{ runId: id }]);
}

function storedDirectoryBytes(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += storedDirectoryBytes(child);
    else if (entry.isFile()) total += lstatSync(child).size;
  }
  return total;
}

test("retention prunes oldest run directories for keepRuns and quota without touching latest or manifest", () => {
  const root = fixtureRoot();
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const cfg = { name: "fixture", root, library: { keepRuns: 2 } };
  writeStoredRun(stateDir, cfg.name, "run-one", "2026-08-11T08:00:00.000Z", 80);
  writeStoredRun(stateDir, cfg.name, "run-two", "2026-08-11T09:00:00.000Z", 80);
  writeStoredRun(stateDir, cfg.name, "run-three", "2026-08-11T10:00:00.000Z", 16);
  commitStoredRun(stateDir, cfg.name, "run-one");
  commitStoredRun(stateDir, cfg.name, "run-two");
  commitStoredRun(stateDir, cfg.name, "run-three");
  const latest = join(stateDir, cfg.name, "latest", "sentinel.png");
  mkdirSync(join(stateDir, cfg.name, "latest"), { recursive: true });
  writeFileSync(latest, "latest survives");
  const manifest = manifestPath(cfg.name, stateDir);
  const manifestBeforeRetention = readFileSync(manifest, "utf8");

  const byCount = pruneLibraryRuns(cfg, { stateDir });
  assert.deepEqual(byCount.removed, ["run-one"]);
  assert.equal(existsSync(join(stateDir, cfg.name, "runs", "run-two")), true);
  assert.equal(readFileSync(latest, "utf8"), "latest survives");
  assert.equal(readFileSync(manifest, "utf8"), manifestBeforeRetention);

  const byQuota = pruneLibraryRuns({ name: cfg.name, root, library: { keepRuns: 30, maxBytes: 90 } }, { stateDir });
  assert.deepEqual(byQuota.removed, ["run-two"]);
  assert.deepEqual(readdirSync(join(stateDir, cfg.name, "runs")), ["run-three"]);
  assert.equal(readFileSync(latest, "utf8"), "latest survives");
  assert.equal(readFileSync(manifest, "utf8"), manifestBeforeRetention);

  writeStoredRun(stateDir, cfg.name, "run-current", "2026-08-11T11:00:00.000Z", 200);
  commitStoredRun(stateDir, cfg.name, "run-current");
  const protectedCurrent = pruneLibraryRuns(
    { name: cfg.name, root, library: { keepRuns: 1, maxBytes: 1 } },
    { stateDir, preserveRunId: "run-current" },
  );
  assert.deepEqual(protectedCurrent.retained, ["run-current"]);
  assert.equal(protectedCurrent.quotaExceeded, true);
});

test("retention keeps a committed capture directory when it contains review.json", () => {
  const root = fixtureRoot();
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const cfg = { name: "fixture", root, library: { keepRuns: 1 } };
  writeStoredRun(stateDir, cfg.name, "reviewed-old", "2026-08-11T08:00:00.000Z", 8);
  commitStoredRun(stateDir, cfg.name, "reviewed-old");
  writeFileSync(join(runDirectory(cfg.name, "reviewed-old", stateDir), "review.json"), '{"reviewed":true}\n');
  writeStoredRun(stateDir, cfg.name, "unreviewed-new", "2026-08-11T10:00:00.000Z", 8);
  commitStoredRun(stateDir, cfg.name, "unreviewed-new");

  const retention = pruneLibraryRuns(cfg, { stateDir });
  assert.deepEqual(retention.removed, ["unreviewed-new"]);
  assert.deepEqual(retention.retained, ["reviewed-old"]);
  assert.equal(readFileSync(join(runDirectory(cfg.name, "reviewed-old", stateDir), "review.json"), "utf8"), '{"reviewed":true}\n');
});

test("maxBytes retention measures the finalized bundle before removing older runs", () => {
  const root = fixtureRoot();
  const probeStateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const probeCfg = config(root);
  const probeCapture = makeCaptureOut(probeCfg);
  const probe = persistRunBundle({
    cfg: probeCfg,
    outDir: probeCapture.outDir,
    bundle: probeCapture.bundle,
    provenance: provenance(),
    stateDir: probeStateDir,
  });
  const finalizedBytes = storedDirectoryBytes(probe.runDir);

  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const cfg = config(root, { library: { keepRuns: 30, maxBytes: finalizedBytes + 512 } });
  writeStoredRun(stateDir, cfg.name, "older-run", "2026-08-11T08:00:00.000Z", 1024);
  commitStoredRun(stateDir, cfg.name, "older-run");
  const capture = makeCaptureOut(cfg);
  const persisted = persistRunBundle({ cfg, outDir: capture.outDir, bundle: capture.bundle, provenance: provenance(), stateDir });

  assert.deepEqual(persisted.retention.removed, ["older-run"]);
  assert.equal(existsSync(runDirectory(cfg.name, "older-run", stateDir)), false);
  assert.equal(persisted.retention.bytes, storedDirectoryBytes(persisted.runDir));
  assert.equal(persisted.retention.quotaExceeded, false);
});

test("library publishes the run and manifest when retention cannot inspect an older run", () => {
  const root = fixtureRoot();
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const cfg = config(root, { library: { keepRuns: 1 } });
  writeStoredRun(stateDir, cfg.name, "unreadable-old-run", "2026-08-11T08:00:00.000Z", 8);
  commitStoredRun(stateDir, cfg.name, "unreadable-old-run");
  const unreadable = join(runDirectory(cfg.name, "unreadable-old-run", stateDir), "unreadable");
  mkdirSync(unreadable);
  writeFileSync(join(unreadable, "capture.bin"), "old");
  chmodSync(unreadable, 0o000);
  try {
    const capture = makeCaptureOut(cfg);
    const persisted = persistRunBundle({ cfg, outDir: capture.outDir, bundle: capture.bundle, provenance: provenance(), stateDir });
    assert.match(persisted.retention.warning, /library retention could not complete/);
    assert.equal(existsSync(persisted.runDir), true);
    assert.equal(readManifestLines(cfg.name, stateDir).some((record) => record.runId === RUN_A), true);
  } finally {
    chmodSync(unreadable, 0o700);
  }
});

test("fingerprint input changes report the precise stale reason", () => {
  const root = fixtureRoot();
  const cfg = config(root);
  const target = cfg.routes[0];
  const baseline = fingerprintTarget(cfg, target);
  const cases = [
    ["sourceFiles", () => writeFileSync(join(root, "src", "Screen.tsx"), "export const Screen = () => 'changed';\n"), /sourceFiles changed: src\/Screen\.tsx/],
    ["route", () => { target.route = "/changed"; }, /route changed/],
    ["params", () => { target.params = { tab: "changed" }; }, /params changed/],
    ["role", () => { target.role = "learner"; }, /role changed/],
    ["state profile", () => { target.stateProfile = "empty"; }, /state profile changed/],
    ["auth config", () => {
      cfg.auth = { mode: "devLogin", account: "learner", alias: "review-learner", storageState: "/tmp/learner.json" };
    }, /auth config changed/],
    ["receipt id", () => { target.receiptId = "receipt-b"; }, /receipt id changed/],
    ["asset variant identity", () => { target.captureVariants = ["scroll"]; }, /asset variant identity changed/],
    ["app build", () => { cfg.capture.appBuild = "2.0.0"; }, /app build changed/],
    ["capture config", () => { cfg.capture.statusBar = { time: "10:10" }; }, /capture config changed/],
    ["waitFor", () => { target.waitFor = "label=Changed"; }, /capture config changed/],
    ["target timeout", () => { target.timeoutMs = 5_000; }, /capture config changed/],
    ["target settle", () => { target.settleMs = 900; }, /capture config changed/],
    ["flow", () => { target.flow = "e2e/changed.yaml"; }, /capture config changed/],
    ["interaction selector", () => { target.interactions[0].selector = "label=Changed"; }, /capture config changed/],
  ];
  for (const [, mutate, expectation] of cases) {
    writeFileSync(join(root, "src", "Screen.tsx"), "export const Screen = () => null;\n");
    target.route = "/home";
    target.params = { tab: "main" };
    delete target.role;
    delete target.stateProfile;
    delete target.receiptId;
    delete target.waitFor;
    delete target.timeoutMs;
    delete target.settleMs;
    delete target.flow;
    target.captureVariants = ["default"];
    target.interactions = [{ id: "open", action: "tap", selector: "label=Open" }];
    cfg.capture.appBuild = "1.0.0";
    delete cfg.capture.statusBar;
    delete cfg.auth;
    mutate();
    const changed = fingerprintTarget(cfg, target);
    assert.notEqual(changed.fingerprint, baseline.fingerprint);
    assert.match(changedFingerprintReason(baseline.inputs, changed.inputs), expectation);
  }
  const driverChanged = JSON.parse(JSON.stringify(baseline.inputs));
  driverChanged.driverVersion.sourceHash = `sha256:${"f".repeat(64)}`;
  assert.match(changedFingerprintReason(baseline.inputs, driverChanged), /driver version changed/);
  assert.deepEqual(baseline.inputs.driverVersion.implementationFiles, [
    "shoot-rn.mjs",
    "capture-contract.cjs",
    "png.cjs",
    "sim-target.cjs",
  ]);
  assert.deepEqual(
    fingerprintTarget(config(root, { capture: { mode: "playwright" } }), target).inputs.driverVersion.implementationFiles,
    ["shoot.mjs", "capture-contract.cjs", "web-capture-timeouts.cjs", "web-capture-retry.cjs"],
  );

  cfg.auth = {
    mode: "devLogin",
    account: "learner",
    alias: "review-learner",
    storageState: "/private/tmp/auth/learner.json",
    secret: "first credential value",
    token: "first token value",
  };
  const authenticated = fingerprintTarget(cfg, target);
  assert.deepEqual(authenticated.inputs.auth, {
    mode: "devLogin",
    account: "learner",
    alias: "review-learner",
    storageState: "learner.json",
  });
  cfg.auth.secret = "rotated credential value";
  cfg.auth.token = "rotated token value";
  cfg.auth.storageState = "/another/machine/learner.json";
  const relocatedSecrets = fingerprintTarget(cfg, target);
  assert.equal(relocatedSecrets.fingerprint, authenticated.fingerprint);
  cfg.auth.storageState = "/another/machine/admin.json";
  const differentStorageState = fingerprintTarget(cfg, target);
  assert.notEqual(differentStorageState.fingerprint, authenticated.fingerprint);
  assert.match(changedFingerprintReason(authenticated.inputs, differentStorageState.inputs), /auth config changed/);
});

test("web fingerprints include the composed target URL but rn-sim excludes its Metro baseUrl", () => {
  const root = fixtureRoot();
  const webCfg = config(root, {
    baseUrl: "http://127.0.0.1:3000",
    capture: { mode: "playwright" },
  });
  const relative = fingerprintTarget(webCfg, webCfg.routes[0]);
  assert.equal(relative.inputs.webTargetUrl, "http://127.0.0.1:3000/home?tab=main");
  webCfg.baseUrl = "http://127.0.0.1:3001";
  const differentOrigin = fingerprintTarget(webCfg, webCfg.routes[0]);
  assert.notEqual(differentOrigin.fingerprint, relative.fingerprint);
  assert.match(changedFingerprintReason(relative.inputs, differentOrigin.inputs), /web target URL changed/);

  const absoluteCfg = config(root, {
    baseUrl: "http://127.0.0.1:3000",
    capture: { mode: "playwright" },
    routes: [{ ...config(root).routes[0], route: "https://review.example.test/home" }],
  });
  const absolute = fingerprintTarget(absoluteCfg, absoluteCfg.routes[0]);
  absoluteCfg.baseUrl = "http://127.0.0.1:3001";
  assert.equal(fingerprintTarget(absoluteCfg, absoluteCfg.routes[0]).fingerprint, absolute.fingerprint);

  const nativeCfg = config(root);
  const native = fingerprintTarget(nativeCfg, nativeCfg.routes[0]);
  nativeCfg.baseUrl = "http://127.0.0.1:3001";
  const differentMetro = fingerprintTarget(nativeCfg, nativeCfg.routes[0]);
  assert.equal("webTargetUrl" in native.inputs, false);
  assert.equal(differentMetro.fingerprint, native.fingerprint);
});

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("--verify-fresh --base reads sourceFiles relative to a subdirectory project root", () => {
  const repository = mkdtempSync(join(tmpdir(), "autoreview-ui-library-repository-"));
  const root = join(repository, "apps", "fixture");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "Screen.tsx"), "export const Screen = () => null;\n");
  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.email", "fixture@example.test"]);
  git(repository, ["config", "user.name", "Fixture"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-qm", "fixture"]);
  const base = git(repository, ["rev-parse", "HEAD"]);
  const cfg = config(root, { capture: { mode: "playwright" } });
  const baseline = fingerprintTarget(cfg, cfg.routes[0], { base });
  assert.notEqual(baseline.fingerprint, null, baseline.reason);
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  appendJsonLines(manifestPath(cfg.name, stateDir), [{
    schemaVersion: 1,
    recordType: "target",
    targetId: "home",
    outcome: "captured",
    targetFingerprint: baseline.fingerprint,
    fingerprintInputs: baseline.inputs,
  }]);
  const configPath = writeConfigFile(cfg);
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--verify-fresh", "--base", base, "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: stateDir } },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).freshness[0].status, "fresh");
});

test("git provenance includes safe untracked entries and marks files that vanish during hashing", () => {
  const root = fixtureRoot();
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.test"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  const untracked = join(root, "draft.txt");
  writeFileSync(untracked, "first draft");
  const first = gitProvenance(root);
  writeFileSync(untracked, "revised draft");
  const second = gitProvenance(root);
  assert.notEqual(first.patchHash, second.patchHash);

  unlinkSync(untracked);
  const missing = untrackedPatchMaterial(root, ["draft.txt"]);
  assert.deepEqual(missing, untrackedPatchMaterial(root, ["draft.txt"]));
  assert.notDeepEqual(missing, untrackedPatchMaterial(root, []));

  const external = join(tmpdir(), `autoreview-ui-external-${process.pid}-${Date.now()}`);
  writeFileSync(external, "outside first");
  const link = join(root, "outside-link");
  symlinkSync(external, link);
  const linkFirst = untrackedPatchMaterial(root, ["outside-link"]);
  writeFileSync(external, "outside second");
  assert.deepEqual(untrackedPatchMaterial(root, ["outside-link"]), linkFirst);
  unlinkSync(link);
  symlinkSync("missing-target", link);
  assert.notDeepEqual(untrackedPatchMaterial(root, ["outside-link"]), untrackedPatchMaterial(root, []));
  mkdirSync(join(root, "untracked-directory"));
  assert.deepEqual(
    untrackedPatchMaterial(root, ["untracked-directory"]),
    untrackedPatchMaterial(root, ["untracked-directory"]),
  );
});

test("git provenance treats a failed or oversized binary diff as unknown", () => {
  const root = fixtureRoot();
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.test"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  writeFileSync(join(root, "src", "Screen.tsx"), `export const Screen = '${"x".repeat(2 * 1024 * 1024)}';\n`);

  const provenance = gitProvenance(root, { maxBuffer: 1024 });
  assert.equal(provenance.patchHash, null);
  assert.notEqual(provenance.branch, null);
  assert.notEqual(provenance.commit, null);
});

function writeConfigFile(cfg) {
  const path = join(cfg.root, "ui-review.json");
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}

test("--verify-fresh compares the working tree by default and pins to --base on request", () => {
  const root = fixtureRoot();
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.test"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  const cfg = config(root);
  const configPath = writeConfigFile(cfg);
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const base = git(root, ["rev-parse", "HEAD"]);
  const baseline = fingerprintTarget(cfg, cfg.routes[0], { base });
  appendJsonLines(manifestPath(cfg.name, stateDir), [{
    schemaVersion: 1,
    recordType: "target",
    targetId: "home",
    outcome: "captured",
    targetFingerprint: baseline.fingerprint,
    fingerprintInputs: baseline.inputs,
  }]);
  const env = { ...process.env, AUTOREVIEW_UI_STATE_DIR: stateDir };
  const fresh = spawnSync(process.execPath, [UI_REVIEW, "--config", configPath, "--verify-fresh", "--json"], { encoding: "utf8", env });
  assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);
  assert.equal(JSON.parse(fresh.stdout).freshness[0].status, "fresh");

  writeFileSync(join(root, "src", "Screen.tsx"), "export const Screen = () => 'working tree edit';\n");
  const workingTreeStale = spawnSync(process.execPath, [UI_REVIEW, "--config", configPath, "--verify-fresh", "--json"], { encoding: "utf8", env });
  assert.equal(workingTreeStale.status, 3, workingTreeStale.stderr || workingTreeStale.stdout);
  assert.equal(JSON.parse(workingTreeStale.stdout).freshness[0].status, "stale");
  assert.match(JSON.parse(workingTreeStale.stdout).freshness[0].reason, /sourceFiles changed: src\/Screen\.tsx/);
  const revisionPinnedFresh = spawnSync(process.execPath, [UI_REVIEW, "--config", configPath, "--verify-fresh", "--base", base, "--json"], { encoding: "utf8", env });
  assert.equal(revisionPinnedFresh.status, 0, revisionPinnedFresh.stderr || revisionPinnedFresh.stdout);
  assert.equal(JSON.parse(revisionPinnedFresh.stdout).freshness[0].status, "fresh");

  delete cfg.routes[0].sourceFiles;
  writeConfigFile(cfg);
  const unverifiable = spawnSync(process.execPath, [UI_REVIEW, "--config", configPath, "--verify-fresh", "--base", base, "--json"], { encoding: "utf8", env });
  assert.equal(unverifiable.status, 3, unverifiable.stderr || unverifiable.stdout);
  assert.equal(JSON.parse(unverifiable.stdout).freshness[0].status, "unverifiable");

  cfg.routes[0].sourceFiles = ["src/Screen.tsx"];
  cfg.routes[0].route = "/changed";
  writeConfigFile(cfg);
  const stale = spawnSync(process.execPath, [UI_REVIEW, "--config", configPath, "--verify-fresh", "--base", base, "--json"], { encoding: "utf8", env });
  assert.equal(stale.status, 3, stale.stderr || stale.stdout);
  assert.equal(JSON.parse(stale.stdout).freshness[0].status, "stale");
  assert.match(JSON.parse(stale.stdout).freshness[0].reason, /route changed/);

  cfg.routes[0].route = "/home";
  writeConfigFile(cfg);
  writeFileSync(manifestPath(cfg.name, stateDir), "");
  const never = spawnSync(process.execPath, [UI_REVIEW, "--config", configPath, "--verify-fresh", "--base", base, "--json"], { encoding: "utf8", env });
  assert.equal(never.status, 3, never.stderr || never.stdout);
  assert.equal(JSON.parse(never.stdout).freshness[0].status, "never-captured");

  const missingOperand = spawnSync(process.execPath, [UI_REVIEW, "--config", configPath, "--verify-fresh", "--base", "--json"], { encoding: "utf8", env });
  assert.equal(missingOperand.status, 2, missingOperand.stdout);
  assert.match(missingOperand.stderr, /--base <sha> requires a non-empty revision/);
});

test("--no-library marks an ephemeral run and excludes manifest.jsonl by name", () => {
  const root = fixtureRoot();
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-state-"));
  const cfg = { ...config(root), intentDoc: "skill:projects/intent/.gitkeep" };
  const configPath = writeConfigFile(cfg);
  const manifest = manifestPath(cfg.name, stateDir);
  mkdirSync(join(stateDir, cfg.name), { recursive: true });
  writeFileSync(manifest, '{"prior":true}\n');
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--no-shots", "--no-scan", "--no-library", "--json"],
    { encoding: "utf8", env: { ...process.env, AUTOREVIEW_UI_STATE_DIR: stateDir } },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.library.mode, "ephemeral");
  assert.match(report.library.reason, /--no-library; excluded from manifest\.jsonl/);
  assert.equal(readFileSync(manifest, "utf8"), '{"prior":true}\n');
});

test("completed run rejects both missing and extra PNG hash keys against the capture manifest", () => {
  const root = fixtureRoot();
  const runDir = mkdtempSync(join(tmpdir(), "autoreview-ui-library-run-"));
  const shots = join(runDir, "shots");
  mkdirSync(shots);
  const first = join(shots, "home.one.png");
  const second = join(shots, "home.two.png");
  writeFileSync(first, "one");
  writeFileSync(second, "two");
  const run = {
    runId: RUN_A,
    project: "fixture",
    targetIds: ["home"],
    root,
    outDir: shots,
  };
  const runPath = join(runDir, "run.json");
  const completed = finalizeCaptureRun(runPath, run, {
    targets: [{ id: "home", outcome: "captured", shots: [{ path: first }], interactions: [{ statePath: second }] }],
  }, shots);
  assert.equal(loadCompletedCaptureRun(runDir, { name: "fixture", root }).run.runId, RUN_A);

  const missing = JSON.parse(JSON.stringify(completed));
  delete missing.targetShotHashes.home["home.two.png"];
  writeFileSync(runPath, JSON.stringify(missing));
  assert.throws(() => loadCompletedCaptureRun(runDir, { name: "fixture", root }), /must exactly match capture manifest assets/);

  const extra = JSON.parse(JSON.stringify(completed));
  extra.targetShotHashes.home["home.extra.png"] = extra.targetShotHashes.home["home.one.png"];
  writeFileSync(runPath, JSON.stringify(extra));
  assert.throws(() => loadCompletedCaptureRun(runDir, { name: "fixture", root }), /must exactly match capture manifest assets/);
});
