"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, symlinkSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

const UI_REVIEW = join(__dirname, "..", "scripts", "ui-review");
const { applyTargetOutcomes, finalizeCaptureRun, loadCompletedCaptureRun, runShots } = require("../scripts/ui-review");

function writeConfig(root, intentDoc, overrides = {}) {
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        name: "fixture",
        root,
        baseUrl: "http://127.0.0.1:9",
        intentDoc,
        auth: { mode: "none" },
        viewports: [{ name: "mobile", width: 375, height: 812 }],
        routes: [],
        ...overrides,
      },
      null,
      2,
    ),
  );
  return configPath;
}

test("ui-review exits nonzero when intent doc is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  const configPath = writeConfig(root, "docs/ui-review/intent.md");
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--no-shots", "--no-scan", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.intentResolved, false);
});

test("ui-review exits zero when intent doc exists and checks are clean", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  mkdirSync(join(root, "docs", "ui-review"), { recursive: true });
  writeFileSync(join(root, "docs", "ui-review", "intent.md"), "# Intent\n");
  const configPath = writeConfig(root, "docs/ui-review/intent.md");
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--no-shots", "--no-scan", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.intentResolved, true);
});

test("ui-review validates --scan-scope values", () => {
  const result = spawnSync(process.execPath, [UI_REVIEW, "--scan-scope", "everything"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /--scan-scope must be diff or targets/);
});

test("--scan-scope targets scans selected sourceFiles without requiring a git diff", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-target-scope-"));
  mkdirSync(join(root, "app"), { recursive: true });
  mkdirSync(join(root, "src", "ui", "atoms"), { recursive: true });
  writeFileSync(join(root, "src", "ui", "atoms", "index.ts"), "export { ScreenHeader } from './ScreenHeader';\n");
  writeFileSync(join(root, "app", "Legacy.tsx"), "export default function Legacy() { return <View />; }\n");
  const configPath = writeConfig(root, "skill:projects/intent/example.md", {
    scan: {
      ruleset: "rn-stylesheet",
      include: ["src"],
      barrels: ["src/ui/atoms/index.ts"],
      shellPolicy: [{
        routeClass: "sub-screen",
        match: ["/legacy"],
        require: ["ScreenHeader"],
        exceptions: [],
      }],
    },
    routes: [{ id: "legacy", route: "/legacy", sourceFiles: ["app/Legacy.tsx"] }],
  });
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--targets", "legacy", "--no-shots", "--scan-scope", "targets", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scan.scope, "targets");
  assert.deepEqual(report.scan.summary.scannedFiles, ["app/Legacy.tsx"]);
  assert.deepEqual(report.scan.inventory.barrels, ["src/ui/atoms/index.ts"]);
  assert.ok(report.scan.inventory.components.includes("ScreenHeader"));
  assert.deepEqual(report.scan.shellPolicy[0], {
    targetId: "legacy",
    route: "/legacy",
    routeClass: "sub-screen",
    require: ["ScreenHeader"],
    verdict: "violated",
    file: "app/Legacy.tsx",
    line: 1,
    missing: ["ScreenHeader"],
  });
});

test("--scan-scope targets reports every declared source file that is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-target-scope-"));
  const configPath = writeConfig(root, "skill:projects/intent/example.md", {
    scan: { ruleset: "rn-stylesheet", include: ["src"] },
    routes: [{ id: "missing", route: "/missing", sourceFiles: ["app/Missing.tsx"] }],
  });
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--targets", "missing", "--no-shots", "--scan-scope", "targets", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.scan.targetErrors, [{
    targetId: "missing",
    sourceFiles: ["app/Missing.tsx"],
    error: "declared sourceFiles are unavailable: app/Missing.tsx",
  }]);
});

test("--scan-scope targets treats a target without sourceFiles as an actionable ownership error", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-target-scope-"));
  const configPath = writeConfig(root, "skill:projects/intent/example.md", {
    scan: { ruleset: "rn-stylesheet", include: ["src"] },
    routes: [{ id: "ownershipless", route: "/ownershipless" }],
  });
  const args = [UI_REVIEW, "--config", configPath, "--targets", "ownershipless", "--no-shots", "--scan-scope", "targets"];
  const text = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(text.status, 1, text.stderr || text.stdout);
  assert.match(text.stdout, /SCAN target ownershipless: error — target has no declared sourceFiles/);

  const result = spawnSync(process.execPath, [...args, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.scan.summary.scannedFiles, []);
  assert.deepEqual(report.scan.targetErrors, [{
    targetId: "ownershipless",
    sourceFiles: [],
    error: "target has no declared sourceFiles",
  }]);
});

test("ui-review uses a unique default output directory per run", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  mkdirSync(join(root, "docs", "ui-review"), { recursive: true });
  writeFileSync(join(root, "docs", "ui-review", "intent.md"), "# Intent\n");
  const configPath = writeConfig(root, "docs/ui-review/intent.md");
  const run = () => {
    const result = spawnSync(
      process.execPath,
      [UI_REVIEW, "--config", configPath, "--no-shots", "--no-scan", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout).outDir;
  };
  assert.notEqual(run(), run());
});

test("ui-review rejects an output path whose symlinked ancestor resolves inside the project", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  const outside = mkdtempSync(join(tmpdir(), "autoreview-ui-outside-"));
  const configPath = writeConfig(root, "skill:projects/intent/.gitkeep");
  const symlinkedAncestor = join(outside, "into-project");
  symlinkSync(root, symlinkedAncestor);
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--out", join(symlinkedAncestor, "bundle"), "--no-shots", "--no-scan", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /output path is inside project root and is rejected/);
});

test("ui-review rejects a reused output directory before following symlinked output leaves", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  const outDir = mkdtempSync(join(tmpdir(), "autoreview-ui-out-"));
  const configPath = writeConfig(root, "skill:projects/intent/.gitkeep");
  const sentinels = join(root, "sentinels");
  mkdirSync(sentinels);
  const files = ["run.json", "bundle.json"];
  for (const name of files) {
    const sentinel = join(sentinels, name);
    writeFileSync(sentinel, `${name} must not be overwritten\n`);
    symlinkSync(sentinel, join(outDir, name));
  }
  const shots = join(sentinels, "shots");
  mkdirSync(shots);
  symlinkSync(shots, join(outDir, "shots"));

  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--out", outDir, "--no-shots", "--no-scan", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /output directory already exists and is rejected/);
  for (const name of files) {
    assert.equal(readFileSync(join(sentinels, name), "utf8"), `${name} must not be overwritten\n`);
  }
});

test("ui-review rejects a missing or empty --record operand during argument parsing", () => {
  for (const args of [["--record"], ["--record", ""], ["--record", "--json"]]) {
    const result = spawnSync(process.execPath, [UI_REVIEW, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /--record <events\.json> requires a non-empty path/);
  }
});

test("ui-review requires a completed --run directory when recording events", () => {
  const result = spawnSync(process.execPath, [UI_REVIEW, "--record", "events.json"], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /requires --run <capture-dir> from a completed capture/);
});

test("capture finalization writes an immutable run identity for every target PNG", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  const runDir = mkdtempSync(join(tmpdir(), "autoreview-ui-capture-"));
  const shotsDir = join(runDir, "shots");
  mkdirSync(shotsDir);
  const nestedShotsDir = join(shotsDir, "nested");
  mkdirSync(nestedShotsDir);
  const fullPath = join(nestedShotsDir, "home.mobile.full.png");
  const interactionPath = join(nestedShotsDir, "home.mobile.open.png");
  writeFileSync(fullPath, "full capture");
  writeFileSync(interactionPath, "interaction capture");
  const runPath = join(runDir, "run.json");
  const run = {
    runId: "11111111-1111-4111-8111-111111111111",
    project: "fixture",
    targetIds: ["home"],
    root,
    outDir: shotsDir,
  };
  writeFileSync(runPath, JSON.stringify(run));
  const completed = finalizeCaptureRun(
    runPath,
    run,
    {
      targets: [{
        id: "home",
        outcome: "captured",
        shots: [{ path: fullPath }],
        interactions: [{ statePath: interactionPath }],
      }],
    },
    shotsDir,
  );
  assert.equal(completed.captureComplete, true);
  assert.equal(completed.project, "fixture");
  assert.deepEqual(completed.targetIds, ["home"]);
  assert.deepEqual(completed.targetOutcomes, { home: "captured" });
  assert.deepEqual(completed.targetShotHashes, {
    home: {
      "nested/home.mobile.full.png": `sha256:${createHash("sha256").update("full capture").digest("hex")}`,
      "nested/home.mobile.open.png": `sha256:${createHash("sha256").update("interaction capture").digest("hex")}`,
    },
  });
  assert.equal(Object.keys(completed.targetShotHashes.home).some((asset) => asset.includes("\\")), false);
  assert.deepEqual(JSON.parse(readFileSync(runPath, "utf8")), completed);
  assert.equal(loadCompletedCaptureRun(runDir, { name: "fixture", root }).run.runId, run.runId);
});

test("capture finalization persists failed targets without certifying a partial run", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  const runDir = mkdtempSync(join(tmpdir(), "autoreview-ui-capture-"));
  const shotsDir = join(runDir, "shots");
  mkdirSync(shotsDir);
  const homePath = join(shotsDir, "home.mobile.full.png");
  writeFileSync(homePath, "home capture");
  const runPath = join(runDir, "run.json");
  const run = {
    runId: "11111111-1111-4111-8111-111111111111",
    project: "fixture",
    targetIds: ["home", "settings"],
    root,
    outDir: shotsDir,
  };

  const partial = finalizeCaptureRun(
    runPath,
    run,
    {
      captureFailed: true,
      targets: [
        { id: "home", outcome: "captured", shots: [{ path: homePath }], interactions: [] },
        { id: "settings", outcome: "failed", shots: [], interactions: [] },
      ],
    },
    shotsDir,
  );

  assert.equal(partial.captureComplete, false);
  assert.deepEqual(partial.targetOutcomes, { home: "captured", settings: "failed" });
  assert.deepEqual(partial.targetShotHashes.settings, {});
  assert.deepEqual(JSON.parse(readFileSync(runPath, "utf8")), partial);
  assert.throws(
    () => loadCompletedCaptureRun(runDir, { name: "fixture", root }),
    /failed targets: settings \(failed\); targets without hashed PNGs: settings/,
  );
});

test("capture finalization does not certify a driver-level capture failure", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  const runDir = mkdtempSync(join(tmpdir(), "autoreview-ui-capture-"));
  const shotsDir = join(runDir, "shots");
  mkdirSync(shotsDir);
  const homePath = join(shotsDir, "home.mobile.full.png");
  writeFileSync(homePath, "home capture");
  const runPath = join(runDir, "run.json");
  const run = {
    runId: "11111111-1111-4111-8111-111111111111",
    project: "fixture",
    targetIds: ["home"],
    root,
    outDir: shotsDir,
  };

  const partial = finalizeCaptureRun(
    runPath,
    run,
    {
      captureFailed: true,
      targets: [{ id: "home", outcome: "captured", shots: [{ path: homePath }], interactions: [] }],
    },
    shotsDir,
  );

  assert.equal(partial.captureComplete, false);
  assert.deepEqual(partial.targetOutcomes, { home: "captured" });
  assert.throws(
    () => loadCompletedCaptureRun(runDir, { name: "fixture", root }),
    /capture driver reported failure/,
  );
});

test("ui-review writes a failed fallback manifest when an RN driver exits before shots exists", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  const outDir = mkdtempSync(join(tmpdir(), "autoreview-ui-capture-"));
  const cfg = {
    name: "fixture-rn",
    root,
    baseUrl: "http://127.0.0.1:9",
    capture: { mode: "rn-sim", bundleId: "com.example.app" },
    auth: { mode: "none" },
    routes: [{ id: "home", route: "home" }],
  };

  const manifest = runShots(cfg, outDir, "rn-sim", cfg.routes);

  assert.equal(manifest.captureFailed, true);
  assert.equal(existsSync(join(outDir, "shots", "manifest.json")), true);
  const run = JSON.parse(readFileSync(join(outDir, "run.json"), "utf8"));
  assert.equal(run.targetOutcomes.home, "failed");
  assert.equal(run.captureComplete, false);
});

test("ui-review resolves skill-prefixed intent docs outside the project root", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  const configPath = writeConfig(root, "skill:projects/intent/.gitkeep");
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--no-shots", "--no-scan", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.intentResolved, true);
  assert.ok(!report.intentDoc.startsWith(root));
});

test("ui-review fails a target when a required interaction did not capture state", () => {
  const manifest = {
    targets: [{
      id: "home",
      route: "/",
      shots: [{ viewport: "mobile", path: "/tmp/home.png", kind: "full" }],
      interactions: [
        { id: "missing-selector", changed: false, note: "selector not found" },
        { id: "missing-bounds", changed: false, note: "no bounding box" },
        { id: "unchanged", changed: false },
      ],
      axe: null,
      errors: [],
    }],
  };

  applyTargetOutcomes(manifest, [{ id: "home", route: "/" }]);

  assert.equal(manifest.targets[0].outcome, "failed");
  assert.match(manifest.targets[0].reason, /required interactions failed/);
  assert.match(manifest.targets[0].reason, /missing-selector \(selector not found\)/);
  assert.match(manifest.targets[0].reason, /missing-bounds \(no bounding box\)/);
  assert.match(manifest.targets[0].reason, /unchanged \(no visible state change\)/);
});

// --- capture backend selection ------------------------------------------------
//
// The three pre-existing web project configs carry no `capture` block, so the
// first test below is the regression pin that keeps them on Playwright.

function writeRnConfig(root, overrides = {}) {
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        name: "fixture-rn",
        root,
        baseUrl: "http://127.0.0.1:9",
        intentDoc: "skill:projects/intent/.gitkeep",
        capture: {
          mode: "rn-sim",
          bundleId: "com.example.app",
          scheme: "exampleapp",
          appearance: ["light"],
        },
        auth: { mode: "none" },
        routes: [{ id: "home", route: "home", waitFor: "label=Home" }],
        ...overrides,
      },
      null,
      2,
    ),
  );
  return configPath;
}

/**
 * The rn-sim runtime-dependency probe (`xcrun simctl help`, `axe --version`)
 * guards every precondition after it. Any assertion about a *later* stage must
 * therefore satisfy the probe deterministically instead of inheriting whatever
 * the host machine happens to have installed — so stub both CLIs as no-op
 * executables on PATH. Config-lint assertions need none of this: that stage now
 * runs before the probe.
 */
function stubRnToolchainEnv(root) {
  const bin = join(root, "stub-bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["xcrun", "axe"]) {
    const stub = join(bin, name);
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    chmodSync(stub, 0o755);
  }
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

test("ui-review leaves --out available when an RN dependency preflight fails", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  const configPath = writeRnConfig(root);
  const outDir = join(mkdtempSync(join(tmpdir(), "autoreview-ui-out-parent-")), "capture");
  const args = [UI_REVIEW, "--config", configPath, "--out", outDir, "--no-scan", "--json"];
  const env = { ...process.env, PATH: "" };

  for (const attempt of ["first", "retry"]) {
    const result = spawnSync(process.execPath, args, { encoding: "utf8", env });
    assert.equal(result.status, 2, `${attempt}: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, /missing runtime dependencies for capture\.mode rn-sim/);
    assert.doesNotMatch(result.stderr, /output directory already exists/);
    assert.equal(existsSync(outDir), false, `${attempt} preflight must not create --out`);
  }
});

test("ui-review rejects an unknown target before capture preflight for both backends", () => {
  for (const mode of ["playwright", "rn-sim"]) {
    const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
    const configPath =
      mode === "rn-sim"
        ? writeRnConfig(root, { groups: { primary: ["home"] } })
        : writeConfig(root, "skill:projects/intent/.gitkeep", {
            groups: { primary: ["home"] },
            routes: [{ id: "home", route: "/" }],
          });
    const outDir = join(mkdtempSync(join(tmpdir(), "autoreview-ui-out-parent-")), "capture");
    const args = [UI_REVIEW, "--config", configPath, "--targets", "typo", "--out", outDir, "--no-scan", "--json"];
    const env = mode === "rn-sim" ? { ...process.env, PATH: "" } : process.env;

    for (const attempt of ["first", "retry"]) {
      const result = spawnSync(process.execPath, args, { encoding: "utf8", env });
      assert.equal(result.status, 2, `${mode} ${attempt}: ${result.stderr || result.stdout}`);
      assert.match(result.stderr, /unknown target id\(s\): typo/);
      assert.match(result.stderr, /valid target ids: home/);
      assert.match(result.stderr, /valid group names: primary/);
      assert.doesNotMatch(result.stderr, /missing runtime dependencies|not reachable/);
      assert.equal(existsSync(outDir), false, `${mode} ${attempt} must not create --out`);
    }
  }
});

test("web page click interactions report unchanged when before and after match", async () => {
  const { runInteraction } = await import("../scripts/shoot.mjs");
  const screenshots = [];
  const element = {
    count: async () => 1,
    click: async () => {},
    scrollIntoViewIfNeeded: async () => { element.scrolled = (element.scrolled || 0) + 1; },
  };
  const page = {
    locator(selector) {
      assert.equal(selector, "button");
      return {
        first: () => element,
      };
    },
    waitForTimeout: async () => {},
    screenshot: async (options) => {
      screenshots.push(options);
      return Buffer.from("unchanged page");
    },
    mouse: { move: async () => {} },
    keyboard: { press: async () => {} },
  };

  const interaction = await runInteraction(
    page,
    join(tmpdir(), "autoreview-ui-shoot-test"),
    { id: "home" },
    { id: "open", action: "click", selector: "button" },
    "desktop",
    0,
  );

  assert.equal(interaction.changed, false);
  assert.equal(element.scrolled, 1, "page-mode baseline is taken after the locator enters view");
  assert.match(interaction.statePath, /home\.desktop\.open\.png$/);
  assert.deepEqual(screenshots, [
    { fullPage: false },
    { path: interaction.statePath, fullPage: false },
  ]);
});

test("ui-review defaults to the playwright backend when no capture block is set", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  const configPath = writeConfig(root, "skill:projects/intent/.gitkeep");
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--no-shots", "--no-scan", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).captureMode, "playwright");
});

test("ui-review reports the rn-sim backend when the config selects it", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  const configPath = writeRnConfig(root);
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--no-shots", "--no-scan", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).captureMode, "rn-sim");
});

test("ui-review rejects an unknown capture.mode during config validation", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  const configPath = writeRnConfig(root, { capture: { mode: "carrier-pigeon" } });
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--no-shots", "--no-scan", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /config\.capture\.mode: must be playwright or rn-sim/);
});

test("ui-review rejects non-object capture blocks rather than defaulting to playwright", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  for (const capture of [[], "rn-sim"]) {
    const configPath = writeConfig(root, "skill:projects/intent/.gitkeep");
    const config = JSON.parse(require("node:fs").readFileSync(configPath, "utf8"));
    config.capture = capture;
    writeFileSync(configPath, JSON.stringify(config));
    const result = spawnSync(
      process.execPath,
      [UI_REVIEW, "--config", configPath, "--no-shots", "--no-scan", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /config\.capture: must be an object/);
  }
});

test("ui-review rejects hover/focus/active interactions under rn-sim", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  const configPath = writeRnConfig(root, {
    routes: [
      {
        id: "home",
        route: "home",
        interactions: [{ id: "cta-hover", action: "hover", selector: "label=Join" }],
      },
    ],
  });
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--no-scan", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /action "hover" has no iOS equivalent/);
  assert.match(result.stderr, /use "tap"/);
});

test("ui-review rejects per-target roles under rn-sim", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  const configPath = writeRnConfig(root, {
    routes: [{ id: "admin", route: "admin", role: "owner" }],
  });
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--no-scan", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /`role` is not supported by capture\.mode rn-sim/);
});

test("ui-review names Metro when an rn-sim packager is unreachable", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  const configPath = writeRnConfig(root, {
    startHint: "run metro first",
  });
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--no-scan", "--json"],
    { encoding: "utf8", env: stubRnToolchainEnv(root) },
  );
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /Metro bundler not reachable/);
  assert.match(result.stderr, /run metro first/);
});

test("ui-review forwards the scan block to ui-scan", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  const configPath = writeRnConfig(root, {
    scan: { ruleset: "rn-stylesheet", include: ["src"], tokensDir: "nope/theme" },
  });
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--no-shots", "--json"],
    { encoding: "utf8" },
  );
  // No git repo in the fixture root, so ui-scan errors — but only after having
  // accepted the forwarded rn flags. An unknown flag would be a different error.
  const report = JSON.parse(result.stdout);
  assert.ok(report.scan.error, "expected a scan error from the non-repo fixture");
  assert.doesNotMatch(report.scan.error, /unknown|unrecognized/i);
});

test("ui-review exits nonzero when ui-scan reports an error", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-review-"));
  mkdirSync(join(root, "docs", "ui-review"), { recursive: true });
  writeFileSync(join(root, "docs", "ui-review", "intent.md"), "# Intent\n");
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        name: "fixture",
        root,
        baseUrl: "http://127.0.0.1:9",
        tokensCss: "missing-globals.css",
        intentDoc: "docs/ui-review/intent.md",
        auth: { mode: "none" },
        viewports: [{ name: "mobile", width: 375, height: 812 }],
        routes: [],
      },
      null,
      2,
    ),
  );
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--no-shots", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.match(report.scan.error, /ENOENT|no such file/i);
});
