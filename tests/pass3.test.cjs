"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const vm = require("node:vm");

const { encodePng, decodePng } = require("../scripts/png.cjs");
const { produceCrops, assignAssetIds } = require("../scripts/evidence.cjs");
const { boundedSlice, buildJudgeContexts, normalizedScrollFacts } = require("../scripts/judge-context.cjs");
const { finalizeCaptureRun } = require("../scripts/ui-review");
const { assetIdentity, latestAssetPath, persistRunBundle } = require("../scripts/library.cjs");
const { validateConfig } = require("../schemas/validator.cjs");

const SHOOT_RN = join(__dirname, "..", "scripts", "shoot-rn.mjs");

function png(width = 100, height = 200) {
  return encodePng({ width, height, channels: 4, data: Buffer.alloc(width * height * 4, 0x88) });
}

function writeExecutable(path, source) {
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  require("node:fs").chmodSync(path, 0o755);
}

function fakeBoundary(dir) {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeExecutable(join(bin, "xcrun"), String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
const sim = args.slice(1);
if (process.env.FAKE_SIMCTL_LOG) fs.appendFileSync(process.env.FAKE_SIMCTL_LOG, sim.join(" ") + "\n");
if (sim[0] === "terminate" && process.env.FAKE_APP_NOT_RUNNING === "true") {
  process.stderr.write("found nothing to terminate\n");
  process.exit(4);
}
if (sim[0] === "list") {
  process.stdout.write(JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ state: "Booted", udid: "FAKE-UDID", name: "Fixture Phone" }] } }));
} else if (sim[0] === "get_app_container") {
  process.stdout.write("/fake/app");
} else if (sim[0] === "io" && sim[2] === "screenshot") {
  fs.copyFileSync(process.env.FAKE_PNG, sim[3]);
} else if (sim[0] === "ui" && sim[2] === "appearance" && sim.length === 3) {
  process.stdout.write("dark\n");
}
`);
  writeExecutable(join(bin, "axe"), String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_AX_STATE;
const count = () => Number(fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : 0);
const write = (value) => fs.writeFileSync(statePath, String(value));
if (args[0] === "--version") process.stdout.write("fake axe\n");
else if (args[0] === "swipe") write(Math.min(count() + 1, Number(process.env.FAKE_STOP_AFTER || 2)));
else if (args[0] === "describe-ui") {
  const stopAfter = Number(process.env.FAKE_STOP_AFTER || 2);
  const n = count();
  const contentHeight = Number(process.env.FAKE_CONTENT_HEIGHT || 500);
  const extent = Math.max(0, contentHeight - 180);
  const offset = stopAfter > 0 ? Math.min(n, stopAfter) / stopAfter * extent : 0;
  const content = process.env.FAKE_GEOMETRY === "none" ? {} : {
    contentSize: { width: 100, height: contentHeight },
    contentFrame: { x: 0, y: -offset, width: 100, height: contentHeight }
  };
  const position = process.env.FAKE_INERT === "true" ? 0 : n;
  process.stdout.write(JSON.stringify([{
    type: "Window", frame: { x: 0, y: 0, width: 100, height: 200 }, children: [{
      type: "ScrollView", AXUniqueId: "main-scroll", scrollable: true,
      frame: { x: 0, y: 0, width: 100, height: 180 }, ...content,
      children: [{ type: "Text", AXLabel: "Position " + position, frame: { x: 0, y: 10, width: 80, height: 20 } }]
    }, {
      type: "View", AXUniqueId: "clip", frame: { x: 10, y: 20, width: 60, height: 80 }
    }, {
      type: "Button", AXUniqueId: "inside", frame: { x: 20, y: 40, width: 20, height: 20 }
    }, {
      type: "Button", AXUniqueId: "outside", frame: { x: 80, y: 40, width: 10, height: 20 }
    }]
  }]));
}
`);
  return bin;
}

function runFakeRnProbe(options = {}) {
  return runFakeRnDriver(options).target;
}

function runFakeRnDriver({
  geometry = "available",
  contentHeight = 500,
  stopAfter = 2,
  maxSwipes = 5,
  inert = false,
  cropRequests = [],
  target = null,
  targets = null,
  session = undefined,
  appNotRunning = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass3-rn-"));
  const outDir = join(dir, "shots");
  const runPath = join(dir, "run.json");
  const sourcePng = join(dir, "screen.png");
  const state = join(dir, "axe-state");
  const simctlLog = join(dir, "simctl.log");
  writeFileSync(sourcePng, png());
  const run = {
    outDir,
    settleMs: 0,
    capture: {
      scheme: "fixture",
      bundleId: "com.example.fixture",
      appearance: ["dark"],
      simulator: { deviceName: "Fixture Phone" },
      stableRetries: 1,
      stableIntervalMs: 0,
      scrollProbe: { maxSwipes, settleMs: 0 },
      ...(session ? { session } : {}),
    },
    auth: { mode: "none" },
    cropRequests,
    targets: targets ?? [target ?? { id: "scroll", route: "scroll", axe: false, captureVariants: ["scroll"] }],
  };
  writeFileSync(runPath, JSON.stringify(run));
  const bin = fakeBoundary(dir);
  const result = spawnSync(process.execPath, [SHOOT_RN, "--run", runPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_PNG: sourcePng,
      FAKE_AX_STATE: state,
      FAKE_SIMCTL_LOG: simctlLog,
      FAKE_APP_NOT_RUNNING: String(appNotRunning),
      FAKE_GEOMETRY: geometry === "none" ? "none" : "available",
      FAKE_CONTENT_HEIGHT: String(contentHeight),
      FAKE_STOP_AFTER: String(stopAfter),
      FAKE_INERT: String(inert),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
  return {
    target: manifest.targets[0],
    manifest,
    simctl: existsSync(simctlLog) ? readFileSync(simctlLog, "utf8").trim().split("\n") : [],
  };
}

// A deep link navigates *under* a presented full-screen route, and the covered
// screen stays in the accessibility tree — so `waitFor` matches, the target
// records "captured", and the shot is of whatever is still on top. Relaunching
// before every deep link is what makes that silent wrong-screen capture
// impossible; these tests hold the sequence in place.
const RESET_SESSION = {
  readiness: "id=clip",
  timeoutMs: 5_000,
  bootstrapHint: "fixture bootstrap",
  launchArgs: { RCT_jsLocation: "127.0.0.1:8087", E2E_MUTE: "1" },
};

const PLAIN_TARGETS = [
  { id: "first", route: "first", axe: false },
  { id: "second", route: "second", axe: false },
];

/** simctl argv lines with the device id removed, so intent is what is asserted. */
function navigationSequence(simctl) {
  return simctl
    .filter((line) => /^(terminate|launch|openurl) /.test(line))
    .map((line) => line.replace(" FAKE-UDID", ""));
}

test("rn-sim relaunches the app to root before every target's deep link", () => {
  const { simctl, manifest } = runFakeRnDriver({ targets: PLAIN_TARGETS, session: RESET_SESSION });
  assert.equal(manifest.targets.length, 2);
  const sequence = navigationSequence(simctl);
  const opens = sequence.filter((line) => line.startsWith("openurl "));
  // A target opens more than once (base capture, then the pre-audit re-open);
  // what matters is that no deep link is ever sent to a live app state.
  assert.ok(opens.length >= 2, "each target must open its route at least once");
  assert.deepEqual(
    [...new Set(opens)],
    ["openurl fixture://first", "openurl fixture://second"],
  );
  for (const [index, line] of sequence.entries()) {
    if (!line.startsWith("openurl ")) continue;
    assert.equal(sequence[index - 1], "launch com.example.fixture -RCT_jsLocation 127.0.0.1:8087 -E2E_MUTE 1", `${line} was not preceded by a launch`);
    assert.equal(sequence[index - 2], "terminate com.example.fixture", `${line} was not preceded by a terminate`);
  }
});

test("rn-sim treats a not-running app as a normal state before relaunch", () => {
  const { simctl, manifest } = runFakeRnDriver({
    targets: [PLAIN_TARGETS[0]],
    session: RESET_SESSION,
    appNotRunning: true,
  });
  assert.equal(manifest.targets[0].outcome ?? "captured", "captured");
  assert.deepEqual(manifest.targets[0].errors, []);
  const sequence = navigationSequence(simctl);
  assert.ok(
    sequence.some((line) => line.startsWith("launch com.example.fixture")),
    "a failed terminate must not stop the launch",
  );
});

test("rn-sim capture.session.resetBetweenTargets=false keeps the single-session behaviour", () => {
  const { simctl } = runFakeRnDriver({
    targets: PLAIN_TARGETS,
    session: { ...RESET_SESSION, resetBetweenTargets: false },
  });
  const sequence = navigationSequence(simctl);
  assert.equal(sequence.some((line) => line.startsWith("launch ")), false);
  assert.equal(sequence.some((line) => line.startsWith("terminate ")), false);
  assert.ok(sequence.every((line) => line.startsWith("openurl ")));
});

test("rn-sim scroll probe emits facts, top/bottom assets, and a numeric sliver threshold", () => {
  const measured = runFakeRnProbe({ contentHeight: 200, stopAfter: 2 });
  assert.equal(measured.scroll.scrollable, true);
  assert.equal(measured.scroll.scrollExtentPt, 20);
  assert.equal(measured.scroll.viewportPt, 180);
  assert.equal(measured.scroll.bottomReached, true);
  assert.equal(measured.scroll.sliverScroll, true);
  assert.deepEqual(measured.scroll.layoutEconomy, { verdict: "flagged", flags: ["sliver-scroll"] });
  assert.equal(measured.scroll.containerSelector, "largest-scrollable");
  assert.ok(Array.isArray(measured.scroll.preAxTree));
  assert.ok(Array.isArray(measured.scroll.postAxTree));
  assert.equal(measured.shots.filter((shot) => shot.kind === "scroll-top").length, 1);
  assert.equal(measured.shots.filter((shot) => shot.kind === "scroll-bottom").length, 1);

});

test("rn-sim geometry-null probes retain AX swipe facts and expose them to judge context", () => {
  const unavailable = runFakeRnProbe({ geometry: "none", stopAfter: 2 });
  assert.equal(unavailable.scroll.scrollExtentPt, null);
  assert.equal(unavailable.scroll.viewportPt, null);
  assert.equal(unavailable.scroll.bottomReached, true);
  assert.deepEqual(unavailable.scroll.revealed, {
    count: 1,
    elements: ["Text:Position 2"],
    omitted: 0,
  });
  assert.equal(unavailable.scroll.swipeCount, 3);
  assert.equal(unavailable.scroll.sliverScroll, null);
  assert.deepEqual(unavailable.scroll.layoutEconomy, {
    verdict: "not-judged",
    reason: "scroll geometry unavailable",
  });
  const contextFacts = normalizedScrollFacts(unavailable.scroll);
  assert.equal(contextFacts.bottomReached, true);
  assert.deepEqual(contextFacts.revealed, unavailable.scroll.revealed);
  assert.equal(contextFacts.swipeCount, 3);
  assert.equal(contextFacts.maxSwipes, 5);
});

test("rn-sim flags an inert geometry-null scroll container as suspected sliver-scroll", () => {
  const target = runFakeRnProbe({ geometry: "none", inert: true });
  assert.equal(target.scroll.scrollable, true);
  assert.equal(target.scroll.bottomReached, true);
  assert.equal(target.scroll.inert, true);
  assert.equal(target.scroll.sliverScroll, "suspected");
  assert.deepEqual(target.scroll.revealed, { count: 0, elements: [], omitted: 0 });
  assert.deepEqual(target.scroll.layoutEconomy, {
    verdict: "not-judged",
    reason: "scroll geometry unavailable",
    flags: ["sliver-scroll-suspected"],
  });
});

test("rn-sim scroll probe stops at maxSwipes and records bottomReached false when AX never stabilizes", () => {
  const target = runFakeRnProbe({ stopAfter: 99, maxSwipes: 3 });
  assert.equal(target.scroll.swipeCount, 3);
  assert.equal(target.scroll.maxSwipes, 3);
  assert.equal(target.scroll.bottomReached, false);
});

test("rn-sim detects the bottom when the final permitted swipe reaches the measured content edge", () => {
  const target = runFakeRnProbe({ contentHeight: 500, stopAfter: 2, maxSwipes: 2 });
  assert.equal(target.scroll.swipeCount, 2);
  assert.equal(target.scroll.bottomReached, true);
});

test("rn-sim scroll swipes always move upward and honor the requested distance", async () => {
  const { swipeCoordinates } = await import("../scripts/shoot-rn.mjs");
  const frame = { x: 10, y: 20, width: 100, height: 180 };
  const expected = new Map([[0.1, 18], [0.19, 34], [0.8, 136]]);
  for (const [percent, distance] of expected) {
    const swipe = swipeCoordinates(frame, percent);
    assert.equal(swipe.startY, 164);
    assert.equal(swipe.endY, swipe.startY - distance, `swipePercent ${percent}`);
    assert.ok(swipe.endY < swipe.startY, `swipePercent ${percent} moves upward`);
    assert.ok(swipe.endY >= 28 && swipe.endY <= 192, `swipePercent ${percent} stays inside margins`);
  }
});

test("rn-sim clipped assets retain clip-local selector frames", () => {
  const target = runFakeRnProbe({
    target: { id: "clip", route: "clip", axe: false, clip: "id=clip" },
    cropRequests: [
      { assetId: "clip/dark/clip/base", axSelector: "id=inside", purpose: "inside" },
      { assetId: "clip/dark/clip/base", axSelector: "id=outside", purpose: "outside" },
    ],
  });
  const shot = target.shots.find((candidate) => candidate.kind === "clip");
  assert.deepEqual(shot.selectorFrames["id=inside"], {
    x: 1 / 6, y: 1 / 4, w: 1 / 3, h: 1 / 4, normalized: true,
  });
  assert.deepEqual(shot.selectorOutsideClip, ["id=outside"]);
});

test("web scroll probes fold viewport into scroll asset identity, reset auto-selection before each base shot, and detect bottom on the last swipe", async () => {
  const { shootTarget } = await import("../scripts/shoot.mjs");
  const outDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass3-web-"));
  const element = {
    clientHeight: 100,
    clientWidth: 200,
    scrollHeight: 260,
    scrollWidth: 200,
    scrollTop: 0,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 200, height: 100 }),
    querySelector: () => null,
    dispatchEvent: () => {},
  };
  const document = {
    fonts: { ready: Promise.resolve() },
    body: { scrollWidth: 200, scrollHeight: 260 },
    documentElement: { scrollWidth: 200, scrollHeight: 260 },
    querySelector: () => null,
    querySelectorAll: () => [element],
  };
  const window = { innerWidth: 200, innerHeight: 100, scrollTo: () => {} };
  const screenshots = [];
  const page = {
    context: () => ({ newCDPSession: async () => { throw new Error("no CDP in fake page"); } }),
    addStyleTag: async () => {},
    goto: async () => {},
    on: () => {},
    off: () => {},
    setViewportSize: async ({ width, height }) => { window.innerWidth = width; window.innerHeight = height; },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async (fn, input) => vm.runInNewContext(`(${fn.toString()})(input)`, {
      Event: class Event { constructor(type, init) { this.type = type; this.init = init; } },
      document,
      getComputedStyle: () => ({ overflowY: "auto" }),
      input,
      window,
    }),
    screenshot: async ({ path }) => { screenshots.push({ path, scrollTop: element.scrollTop }); return Buffer.from("shot"); },
  };
  const browser = { newContext: async () => ({ newPage: async () => page, close: async () => {} }) };
  const run = {
    baseUrl: "http://fixture.test",
    outDir,
    settleMs: 0,
    viewports: [
      { name: "mobile", width: 200, height: 100 },
      { name: "desktop", width: 200, height: 100 },
    ],
  };
  const target = {
    id: "scroll",
    route: "/scroll",
    axe: false,
    captureVariants: ["scroll"],
    scrollProbe: { maxSwipes: 2, settleMs: 0, swipePercent: 0.8 },
  };
  const manifest = await shootTarget(browser, run, target);
  assert.equal(manifest.scrollProbes.every((probe) => probe.bottomReached), true);
  assert.deepEqual(
    screenshots.filter((shot) => shot.path.endsWith(".full.png")).map((shot) => shot.scrollTop),
    [0, 0],
  );
  const cfg = { capture: { mode: "playwright" } };
  const captureManifest = { viewports: run.viewports };
  const scrollShots = manifest.shots.filter((shot) => shot.kind.startsWith("scroll-"));
  assert.deepEqual(
    scrollShots.map((shot) => assetIdentity(target, shot, captureManifest, cfg).variant),
    ["mobile:scroll-top", "mobile:scroll-bottom", "desktop:scroll-top", "desktop:scroll-bottom"],
  );
});

test("web scroll probes re-measure geometry after lazy content settles", async () => {
  const { shootTarget } = await import("../scripts/shoot.mjs");
  const outDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass3-web-lazy-"));
  const element = {
    clientHeight: 100,
    clientWidth: 200,
    scrollHeight: 180,
    scrollWidth: 200,
    scrollTop: 0,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 200, height: 100 }),
    querySelector: () => null,
    dispatchEvent: () => {},
  };
  const document = {
    fonts: { ready: Promise.resolve() },
    body: { scrollWidth: 200, scrollHeight: 180 },
    documentElement: { scrollWidth: 200, scrollHeight: 180 },
    querySelector: () => null,
    querySelectorAll: () => [element],
  };
  const window = { innerWidth: 200, innerHeight: 100, scrollTo: () => {} };
  let expanded = false;
  const screenshotScrollTops = [];
  const page = {
    context: () => ({ newCDPSession: async () => { throw new Error("no CDP in fake page"); } }),
    addStyleTag: async () => {},
    goto: async () => {},
    on: () => {},
    off: () => {},
    setViewportSize: async ({ width, height }) => { window.innerWidth = width; window.innerHeight = height; },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {
      if (element.scrollTop > 0 && !expanded) {
        element.scrollHeight = 260;
        expanded = true;
      }
    },
    evaluate: async (fn, input) => vm.runInNewContext(`(${fn.toString()})(input)`, {
      Event: class Event { constructor(type, init) { this.type = type; this.init = init; } },
      document,
      getComputedStyle: () => ({ overflowY: "auto" }),
      input,
      window,
    }),
    screenshot: async () => {
      screenshotScrollTops.push(element.scrollTop);
      return Buffer.from("shot");
    },
  };
  const browser = { newContext: async () => ({ newPage: async () => page, close: async () => {} }) };
  const manifest = await shootTarget(browser, {
    baseUrl: "http://fixture.test",
    outDir,
    settleMs: 0,
    viewports: [{ name: "mobile", width: 200, height: 100 }],
  }, {
    id: "lazy-scroll",
    route: "/scroll",
    axe: false,
    captureVariants: ["scroll"],
    scrollProbe: { maxSwipes: 2, settleMs: 0, swipePercent: 0.8 },
  });
  assert.equal(manifest.scroll.scrollExtentPt, 160);
  assert.equal(manifest.scroll.bottomReached, true);
  assert.ok(screenshotScrollTops.includes(160), "a post-settle expansion receives a second swipe");
});

test("clipped selector crops use clip-local frames and name an outside selector clearly", async () => {
  const { selectorFrameEvidence } = await import("../scripts/shoot.mjs");
  const rects = {
    "#inside": { x: 20, y: 40, width: 20, height: 20 },
    "#outside": { x: 80, y: 40, width: 10, height: 20 },
  };
  const page = {
    evaluate: async (fn, input) => vm.runInNewContext(`(${fn.toString()})(input)`, {
      document: {
        body: { scrollWidth: 100, scrollHeight: 200 },
        documentElement: { scrollWidth: 100, scrollHeight: 200 },
        querySelector: (selector) => rects[selector]
          ? { getBoundingClientRect: () => rects[selector] }
          : null,
      },
      input,
      window: { innerWidth: 100, innerHeight: 200, scrollX: 0, scrollY: 0 },
    }),
  };
  const evidence = await selectorFrameEvidence(page, ["#inside", "#outside"], {
    clip: { x: 10, y: 20, width: 60, height: 80 },
  });
  assert.deepEqual({ ...evidence.frames["#inside"] }, {
    x: 1 / 6, y: 1 / 4, w: 1 / 3, h: 1 / 4, normalized: true,
  });
  assert.deepEqual([...evidence.outsideClip], ["#outside"]);

  const shotsDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass3-clipped-crop-"));
  const source = join(shotsDir, "home.clip.png");
  writeFileSync(source, png(60, 80));
  const manifest = {
    viewports: [],
    targets: [{
      id: "home",
      errors: [],
      interactions: [],
      shots: [{
        assetId: "home/default/clip/base",
        viewport: "mobile",
        kind: "clip",
        path: source,
        selectorFrames: evidence.frames,
        selectorOutsideClip: evidence.outsideClip,
      }],
    }],
  };
  const result = produceCrops({
    captureManifest: manifest,
    cfg: { capture: { mode: "playwright" }, routes: [{ id: "home", route: "/" }] },
    shotsDir,
    cropRequests: [
      { assetId: "home/default/clip/base", axSelector: "#inside", purpose: "inside" },
      { assetId: "home/default/clip/base", axSelector: "#outside", purpose: "outside" },
    ],
  });
  assert.equal(result.produced.length, 1);
  assert.deepEqual(
    [decodePng(readFileSync(result.produced[0].path)).width, decodePng(readFileSync(result.produced[0].path)).height],
    [20, 20],
  );
  assert.match(manifest.targets[0].errors[0], /selector outside clipped area/);
  assert.doesNotMatch(manifest.targets[0].errors[0], /cannot resolve axSelector/);
});

test("rect crops become hashed first-class run and latest assets with their crop identity", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-pass3-project-"));
  const stateDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass3-state-"));
  const outDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass3-out-"));
  const shotsDir = join(outDir, "shots");
  mkdirSync(shotsDir);
  const source = join(shotsDir, "home.dark.full.png");
  writeFileSync(source, png(20, 10));
  const cfg = {
    name: "fixture",
    root,
    baseUrl: "http://127.0.0.1:9",
    capture: { mode: "rn-sim", appearance: ["dark"] },
    routes: [{ id: "home", route: "home", sourceFiles: [] }],
  };
  const manifest = {
    viewports: [{ name: "Fixture-dark", appearance: "dark" }],
    targets: [{ id: "home", route: "home", errors: [], interactions: [], shots: [{ viewport: "Fixture-dark", kind: "full", path: source }] }],
  };
  assignAssetIds(manifest, cfg);
  assert.equal(manifest.targets[0].shots[0].assetId, "home/dark/full/base");
  const crop = produceCrops({
    captureManifest: manifest,
    cfg,
    shotsDir,
    cropRequests: [{ assetId: "home/dark/full/base", rect: { x: 0.25, y: 0.2, w: 0.5, h: 0.6, normalized: true }, purpose: "cta" }],
  });
  assert.equal(crop.errors.length, 0);
  const cropAsset = manifest.targets[0].shots.find((shot) => shot.cropId === "cta");
  assert.equal(cropAsset.assetId, "home/dark/full/base/crop/cta");
  assert.deepEqual([decodePng(readFileSync(cropAsset.path)).width, decodePng(readFileSync(cropAsset.path)).height], [10, 6]);

  const runPath = join(outDir, "run.json");
  const run = { runId: "11111111-1111-4111-8111-111111111111", project: "fixture", targetIds: ["home"], targets: cfg.routes };
  writeFileSync(runPath, JSON.stringify(run));
  manifest.targets[0].outcome = "captured";
  finalizeCaptureRun(runPath, run, manifest, shotsDir);
  writeFileSync(join(outDir, "bundle.json"), JSON.stringify({ project: "fixture", shots: manifest }));
  const persisted = persistRunBundle({
    cfg,
    outDir,
    bundle: { project: "fixture", shots: manifest },
    provenance: { branch: "main", commit: "abcdef1", patchHash: null, appBuild: null, device: null },
    stateDir,
  });
  assert.equal(existsSync(join(persisted.runDir, "shots", cropAsset.path.split("/").pop())), true);
  const latest = latestAssetPath(cfg.name, { targetId: "home", appearance: "dark", variant: "full", interaction: null, crop: "cta" }, stateDir);
  assert.equal(existsSync(latest), true);
});

test("crop output names retain source identity and do not merge sanitized purposes", () => {
  const shotsDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pass3-crops-"));
  const top = join(shotsDir, "home.mobile.scroll-top.png");
  const bottom = join(shotsDir, "home.mobile.scroll-bottom.png");
  writeFileSync(top, png(20, 10));
  writeFileSync(bottom, png(20, 10));
  const cfg = {
    capture: { mode: "playwright" },
    routes: [{ id: "home", route: "/" }],
  };
  const manifest = {
    viewports: [{ name: "mobile", width: 375, height: 812 }],
    targets: [{
      id: "home",
      errors: [],
      interactions: [],
      shots: [
        { viewport: "mobile", kind: "scroll-top", path: top },
        { viewport: "mobile", kind: "scroll-bottom", path: bottom },
      ],
    }],
  };
  assignAssetIds(manifest, cfg);
  const [topShot, bottomShot] = manifest.targets[0].shots;
  const result = produceCrops({
    captureManifest: manifest,
    cfg,
    shotsDir,
    cropRequests: [
      { assetId: topShot.assetId, rect: { x: 0, y: 0, w: 1, h: 1 }, purpose: "cta!" },
      { assetId: topShot.assetId, rect: { x: 0, y: 0, w: 1, h: 1 }, purpose: "cta?" },
      { assetId: bottomShot.assetId, rect: { x: 0, y: 0, w: 1, h: 1 }, purpose: "cta!" },
    ],
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.produced.length, 3);
  assert.equal(new Set(result.produced.map((crop) => crop.path)).size, 3);
  assert.equal(result.produced.every((crop) => existsSync(crop.path)), true);
});

test("judge-context slices are deterministic, bounded, ordered, and exclude raw AX dumps", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-pass3-context-"));
  mkdirSync(join(root, "app"));
  writeFileSync(join(root, "app", "Screen.tsx"), "import { Card, Other } from '../ui'; export default () => <Card />;\n");
  const intent = join(root, "intent.md");
  writeFileSync(intent, "## Sub screen policy\nUse the shared header.\n\n## Other\nIgnored.\n");
  const cfg = { name: "fixture", root, judgeContext: { maxBytes: 700 } };
  const targets = [{ id: "home", route: "/home", sourceFiles: ["app/Screen.tsx"] }];
  const scan = {
    inventory: { components: ["Card", "Other", "Unused"] },
    shellPolicy: Array.from({ length: 5 }, (_, index) => ({
      targetId: "home", routeClass: `sub-screen-${index}`, verdict: "violated", missing: ["ScreenHeader"], file: "app/Screen.tsx", line: index + 1,
    })),
  };
  const shots = { targets: [{ id: "home", scroll: {
    scrollable: true, scrollExtentPt: 42, viewportPt: 180, bottomReached: true,
    revealed: { count: 1, elements: ["Text:Footer"], omitted: 0 }, containerSelector: "largest-scrollable",
    frames: { container: null, content: null, viewport: null, footer: null }, sliverScroll: false,
    layoutEconomy: { verdict: "not-flagged", flags: [] }, preAxTree: [{ huge: "must not leak" }], postAxTree: [{ huge: "must not leak" }],
  } }] };
  const first = buildJudgeContexts({ cfg, targets, scan, shots, intentPath: intent });
  const second = buildJudgeContexts({ cfg, targets, scan, shots, intentPath: intent });
  assert.deepEqual(first, second);
  const slice = first.home;
  assert.ok(Buffer.byteLength(JSON.stringify(slice)) <= 700);
  assert.ok(slice.omitted.length > 0, "cap reports its deterministic omissions");
  assert.equal(JSON.stringify(slice).includes("must not leak"), false);
  assert.equal(slice.shellPolicy[0].routeClass, "sub-screen-0");
});

test("judge-context omission counts include every entry trimmed to fit the cap", () => {
  const shellPolicy = Array.from({ length: 12 }, (_, index) => ({
    targetId: "home",
    routeClass: `screen-${index}`,
    verdict: "violated",
    missing: ["ScreenHeader"],
  }));
  const inventoryMatches = Array.from({ length: 8 }, (_, index) => ({
    component: `Component${index}`,
    local: `Component${index}`,
    file: "app/Screen.tsx",
  }));
  const result = boundedSlice({
    target: { id: "home" },
    shellPolicy,
    inventoryMatches,
    scrollProbes: [{
      viewport: "mobile",
      facts: { scrollable: true, layoutEconomy: { verdict: "not-flagged", flags: [] } },
    }],
    excerpts: [],
    maxBytes: 420,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 420);
  const omittedCounts = Object.fromEntries(result.omitted.map((item) => {
    const [section, count] = item.split(":");
    return [section, Number(count)];
  }));
  assert.equal(result.shellPolicy.length + (omittedCounts.shellPolicy || 0), shellPolicy.length);
  assert.equal(result.inventoryMatches.length + (omittedCounts.inventoryMatches || 0), inventoryMatches.length);
  assert.equal(Object.keys(result.scrollProbes).length + (omittedCounts.scrollProbes || 0), 1);
  assert.equal(result.intentExcerpts.length + (omittedCounts.intentExcerpts || 0), 0);
});

test("judge context retains viewport-keyed scroll probes and names probes omitted by its cap", () => {
  const target = { id: "home", route: "/home" };
  const probes = [
    { viewport: "mobile", scrollable: true, scrollExtentPt: 42, viewportPt: 180, bottomReached: true },
    { viewport: "tablet", scrollable: true, scrollExtentPt: 64, viewportPt: 240, bottomReached: false },
    { viewport: "desktop", scrollable: false, scrollExtentPt: 0, viewportPt: 800, bottomReached: true },
  ];
  const shots = { targets: [{ id: "home", scroll: probes[0], scrollProbes: probes }] };
  const full = buildJudgeContexts({
    cfg: { judgeContext: { maxBytes: 8192 } },
    targets: [target],
    scan: {},
    shots,
  }).home;
  assert.deepEqual(Object.keys(full.scrollProbes), ["desktop", "mobile", "tablet"]);
  assert.equal(full.scrollProbes.mobile.scrollExtentPt, 42);
  assert.equal(full.scrollProbes.tablet.bottomReached, false);

  let capped = null;
  const fullBytes = Buffer.byteLength(JSON.stringify(full));
  for (let maxBytes = 256; maxBytes < fullBytes; maxBytes++) {
    try {
      const candidate = buildJudgeContexts({
        cfg: { judgeContext: { maxBytes } },
        targets: [target],
        scan: {},
        shots,
      }).home;
      const retained = Object.keys(candidate.scrollProbes).length;
      if (retained > 0 && retained < probes.length) {
        capped = candidate;
        break;
      }
    } catch {
      // Some small caps cannot encode even the complete omission notice.
    }
  }
  assert.ok(capped, "a bounded slice retains a prefix and explicitly omits the rest");
  const omitted = capped.omitted.find((item) => item.startsWith("scrollProbes:"));
  assert.ok(omitted, "omitted probes are named in the contract");
  assert.equal(Number(omitted.split(":")[1]), probes.length - Object.keys(capped.scrollProbes).length);
});

test("Pass 3 config surfaces validate scroll thresholds, crops, and judge-context caps", () => {
  const good = {
    configVersion: 2,
    name: "fixture",
    root: "/tmp/fixture",
    baseUrl: "http://127.0.0.1:9",
    judgeContext: { maxBytes: 8192 },
    capture: { scrollProbe: { containerSelector: "id=scroll", maxSwipes: 8, thresholds: { sliverExtentViewportRatio: 0.15 } } },
    cropRequests: [{ assetId: "home/dark/full/base", axSelector: "id=cta", purpose: "cta" }],
    routes: [{ id: "home", route: "/", captureVariants: ["scroll"], scrollProbe: { footerSelector: "id=footer" } }],
  };
  assert.equal(validateConfig(good).valid, true);
  const bad = structuredClone(good);
  bad.cropRequests[0].rect = { x: 0.8, y: 0, w: 0.3, h: 1, normalized: true };
  bad.judgeContext.maxBytes = 20;
  assert.match(validateConfig(bad).errors.join("\n"), /exactly one of rect or axSelector/);
  assert.match(validateConfig(bad).errors.join("\n"), /at least 256/);
});

test("capture.session validates launch arguments and the per-target reset switch", () => {
  const withSession = (session) => ({
    configVersion: 2,
    name: "fixture",
    root: "/tmp/fixture",
    baseUrl: "http://127.0.0.1:9",
    capture: {
      mode: "rn-sim",
      bundleId: "com.example.fixture",
      scheme: "fixture",
      simulator: { deviceName: "Fixture Phone" },
      session: { readiness: "id=ready", timeoutMs: 30000, bootstrapHint: "run the bootstrap flow", ...session },
    },
    routes: [{ id: "home", route: "/" }],
  });
  assert.equal(validateConfig(withSession({})).valid, true);
  assert.equal(validateConfig(withSession({ launchArgs: { E2E_MUTE: "1" }, resetBetweenTargets: false })).valid, true);
  // A launch argument becomes `-key value` argv, so a key needing quotes would
  // silently change what the app receives.
  assert.match(
    validateConfig(withSession({ launchArgs: { "bad key": "1" } })).errors.join("\n"),
    /must be a bare launch-argument name/,
  );
  assert.match(
    validateConfig(withSession({ launchArgs: { E2E_MUTE: 1 } })).errors.join("\n"),
    /launchArgs.E2E_MUTE: must be a string/,
  );
  assert.match(
    validateConfig(withSession({ resetBetweenTargets: "yes" })).errors.join("\n"),
    /resetBetweenTargets: must be a boolean/,
  );
});
