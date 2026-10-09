"use strict";

// capture.navigationTimeoutMs / capture.waitForTimeoutMs: per-project Playwright
// waits, so a dev server that compiles each route on first visit can be
// captured. Defaults stay 30 s (navigation) and 15 s (waitFor).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  DEFAULT_WEB_CAPTURE_TIMEOUTS,
  MAX_TIMEOUT_MS,
  webCaptureTimeouts,
} = require("../scripts/web-capture-timeouts.cjs");
const { changedFingerprintReason, fingerprintTarget } = require("../scripts/fingerprint.cjs");
const { schemas, validateConfig } = require("../schemas/validator.cjs");
const { runShots } = require("../scripts/ui-review");

const SHOOT = join(__dirname, "..", "scripts", "shoot.mjs");

function baseConfig(capture) {
  return {
    configVersion: 2,
    name: "fixture",
    root: "/tmp/fixture",
    baseUrl: "http://127.0.0.1:9",
    routes: [{ id: "screen", route: "/screen", sourceFiles: ["app/Screen.tsx"] }],
    ...(capture === undefined ? {} : { capture }),
  };
}

function timeoutError(message) {
  const err = new Error(message);
  err.name = "TimeoutError";
  return err;
}

/**
 * A fake Playwright browser that records the options each wait receives. The
 * optional failures make goto / waitFor throw a Playwright-shaped TimeoutError.
 */
function fakeBrowser({ failGoto = null, failWaitFor = null } = {}) {
  const calls = { goto: [], waitFor: [], post: [] };
  const page = {
    addStyleTag: async () => {},
    goto: async (url, options) => {
      calls.goto.push({ url, options });
      if (failGoto) throw timeoutError(failGoto);
    },
    locator: (selector) => ({
      first: () => ({
        waitFor: async (options) => {
          calls.waitFor.push({ selector, options });
          if (failWaitFor) throw timeoutError(failWaitFor);
        },
      }),
    }),
    on: () => {},
    off: () => {},
    setViewportSize: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => {},
    screenshot: async () => Buffer.from("shot"),
  };
  const context = {
    newPage: async () => page,
    close: async () => {},
    request: {
      post: async (url, options) => {
        calls.post.push({ url, options });
        return { status: () => 204 };
      },
    },
  };
  return { browser: { newContext: async () => context }, calls };
}

function shootRun(extra = {}) {
  return {
    baseUrl: "http://fixture.test",
    outDir: mkdtempSync(join(tmpdir(), "autoreview-ui-timeouts-")),
    settleMs: 0,
    viewports: [{ name: "mobile", width: 375, height: 812 }],
    ...extra,
  };
}

const TARGET = { id: "screen", route: "/screen", waitFor: "main h1", axe: false };

// --- contract ----------------------------------------------------------------

test("webCaptureTimeouts applies the 30 s / 15 s defaults and honours valid overrides", () => {
  assert.deepEqual(DEFAULT_WEB_CAPTURE_TIMEOUTS, { navigationTimeoutMs: 30_000, waitForTimeoutMs: 15_000 });
  assert.deepEqual(webCaptureTimeouts(undefined), { navigationTimeoutMs: 30_000, waitForTimeoutMs: 15_000 });
  assert.deepEqual(webCaptureTimeouts({ mode: "playwright" }), { navigationTimeoutMs: 30_000, waitForTimeoutMs: 15_000 });
  assert.deepEqual(webCaptureTimeouts({ navigationTimeoutMs: 90_000 }), { navigationTimeoutMs: 90_000, waitForTimeoutMs: 15_000 });
  assert.deepEqual(
    webCaptureTimeouts({ navigationTimeoutMs: 1, waitForTimeoutMs: MAX_TIMEOUT_MS }),
    { navigationTimeoutMs: 1, waitForTimeoutMs: MAX_TIMEOUT_MS },
  );
});

test("webCaptureTimeouts rejects values Playwright would misread", () => {
  for (const value of [0, -1, 1.5, "1000", null, Number.NaN, MAX_TIMEOUT_MS + 1]) {
    assert.throws(
      () => webCaptureTimeouts({ waitForTimeoutMs: value }),
      /waitForTimeoutMs must be a positive integer of milliseconds no greater than 2147483647/,
      String(value),
    );
  }
});

// --- config validation -------------------------------------------------------

test("config validation accepts positive-integer timeouts for Playwright captures", () => {
  assert.deepEqual(validateConfig(baseConfig({ navigationTimeoutMs: 90_000, waitForTimeoutMs: 60_000 })).errors, []);
  assert.deepEqual(validateConfig(baseConfig({ mode: "playwright", waitForTimeoutMs: 1 })).errors, []);
  assert.deepEqual(validateConfig(baseConfig()).errors, [], "both keys are optional");
});

test("config validation rejects non-positive, fractional, non-numeric and overflowing timeouts", () => {
  for (const value of [0, -5, 2.5, "90000", true, MAX_TIMEOUT_MS + 1]) {
    const result = validateConfig(baseConfig({ navigationTimeoutMs: value, waitForTimeoutMs: value }));
    const errors = result.errors.join("\n");
    assert.match(errors, /config\.capture\.navigationTimeoutMs: must be a positive integer of milliseconds/, String(value));
    assert.match(errors, /config\.capture\.waitForTimeoutMs: must be a positive integer of milliseconds/, String(value));
  }
});

test("config validation rejects the Playwright timeouts under rn-sim instead of ignoring them", () => {
  const result = validateConfig(baseConfig({ mode: "rn-sim", bundleId: "com.example", navigationTimeoutMs: 1000, waitForTimeoutMs: 1000 }));
  const errors = result.errors.join("\n");
  assert.match(errors, /config\.capture\.navigationTimeoutMs: applies only to capture\.mode playwright/);
  assert.match(errors, /config\.capture\.waitForTimeoutMs: applies only to capture\.mode playwright/);
});

test("config schema declares both timeouts as bounded integers excluded from rn-sim", () => {
  const capture = schemas()["config.v2.json"].properties.capture;
  for (const key of ["navigationTimeoutMs", "waitForTimeoutMs"]) {
    assert.equal(capture.properties[key].type, "integer");
    assert.equal(capture.properties[key].minimum, 1);
    assert.equal(capture.properties[key].maximum, MAX_TIMEOUT_MS);
  }
  const [rnOnly] = capture.allOf;
  assert.equal(rnOnly.if.properties.mode.const, "rn-sim");
  assert.deepEqual(rnOnly.then.not.anyOf.map((clause) => clause.required[0]), ["navigationTimeoutMs", "waitForTimeoutMs"]);
});

// --- driver ------------------------------------------------------------------

test("the Playwright driver bounds page load and waitFor with the default timeouts", async () => {
  const { shootTarget } = await import("../scripts/shoot.mjs");
  const { browser, calls } = fakeBrowser();
  const manifest = await shootTarget(browser, shootRun(), TARGET);
  assert.deepEqual(manifest.errors, []);
  assert.deepEqual(calls.goto[0].options, { waitUntil: "load", timeout: 30_000 });
  assert.deepEqual(calls.waitFor[0].options, { state: "visible", timeout: 15_000 });
});

test("the Playwright driver uses the run's configured timeouts for load, waitFor and dev login", async () => {
  const { shootTarget } = await import("../scripts/shoot.mjs");
  const secretDir = mkdtempSync(join(tmpdir(), "autoreview-ui-timeouts-secret-"));
  writeFileSync(join(secretDir, "dev.env"), "DEV_LOGIN_SECRET=fixture-secret\n");
  const { browser, calls } = fakeBrowser();
  const run = shootRun({
    navigationTimeoutMs: 90_000,
    waitForTimeoutMs: 60_000,
    auth: { mode: "devLogin", endpoint: "/api/dev/login", secretFile: join(secretDir, "dev.env") },
  });
  const manifest = await shootTarget(browser, run, { ...TARGET, role: "admin" });
  assert.deepEqual(manifest.errors, []);
  assert.equal(calls.post[0].options.timeout, 90_000, "the dev-login route compiles like a page");
  assert.deepEqual(calls.goto[0].options, { waitUntil: "load", timeout: 90_000 });
  assert.deepEqual(calls.waitFor[0].options, { state: "visible", timeout: 60_000 });
});

test("a navigation timeout names the config key on the error's first line, before Playwright's call log", async () => {
  const { shootTarget } = await import("../scripts/shoot.mjs");
  const { browser } = fakeBrowser({
    failGoto: 'page.goto: Timeout 1000ms exceeded.\nCall log:\n  - navigating to "http://fixture.test/screen", waiting until "load"\n',
  });
  const manifest = await shootTarget(browser, shootRun({ navigationTimeoutMs: 1000 }), TARGET);
  assert.equal(manifest.errors.length, 1);
  const [firstLine, ...rest] = manifest.errors[0].split("\n");
  assert.equal(
    firstLine,
    "page.goto: Timeout 1000ms exceeded. [capture.navigationTimeoutMs is 1000 ms; raise it in the project config if the server compiles this route on first request]",
  );
  assert.equal(rest[0], "Call log:", "the call log is kept intact after the hint");
});

test("a waitFor timeout names its config key and the selector as the other suspect", async () => {
  const { shootTarget } = await import("../scripts/shoot.mjs");
  const { browser } = fakeBrowser({ failWaitFor: "locator.waitFor: Timeout 500ms exceeded." });
  const manifest = await shootTarget(browser, shootRun({ waitForTimeoutMs: 500 }), TARGET);
  assert.match(manifest.errors[0], /\[capture\.waitForTimeoutMs is 500 ms; raise it .*; otherwise check the waitFor selector\]$/);
});

test("a non-timeout navigation failure passes through without a timeout hint", async () => {
  const { shootTarget } = await import("../scripts/shoot.mjs");
  const { browser } = fakeBrowser();
  const page = await (await browser.newContext()).newPage();
  page.goto = async () => { throw new Error("page.goto: net::ERR_CONNECTION_REFUSED"); };
  const manifest = await shootTarget(browser, shootRun(), TARGET);
  assert.deepEqual(manifest.errors, ["page.goto: net::ERR_CONNECTION_REFUSED"]);
});

test("the driver refuses an invalid run.json timeout before starting a browser", () => {
  const dir = mkdtempSync(join(tmpdir(), "autoreview-ui-timeouts-run-"));
  const outDir = join(dir, "shots");
  const runPath = join(dir, "run.json");
  writeFileSync(runPath, JSON.stringify({ baseUrl: "http://127.0.0.1:9", outDir, targets: [], navigationTimeoutMs: 0 }));
  const result = spawnSync(process.execPath, [SHOOT, "--run", runPath], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /navigationTimeoutMs must be a positive integer of milliseconds/);
  assert.equal(existsSync(outDir), false, "validation runs before the driver creates its output");
});

// --- ui-review → run.json ----------------------------------------------------

test("ui-review records the resolved timeouts in run.json for the Playwright driver", () => {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-timeouts-project-"));
  const cases = [
    [undefined, { navigationTimeoutMs: 30_000, waitForTimeoutMs: 15_000 }],
    [{ navigationTimeoutMs: 90_000, waitForTimeoutMs: 60_000 }, { navigationTimeoutMs: 90_000, waitForTimeoutMs: 60_000 }],
  ];
  for (const [capture, expected] of cases) {
    const outDir = mkdtempSync(join(tmpdir(), "autoreview-ui-timeouts-capture-"));
    const cfg = {
      name: "fixture",
      root,
      baseUrl: "http://127.0.0.1:9",
      auth: { mode: "none" },
      viewports: [{ name: "mobile", width: 375, height: 812 }],
      ...(capture ? { capture } : {}),
      routes: [{ id: "home", route: "/", axe: false }],
    };
    // Port 9 refuses the connection (or no browser is installed); either way
    // the capture fails fast, and run.json is written before the driver runs.
    runShots(cfg, outDir, "playwright", cfg.routes);
    const run = JSON.parse(readFileSync(join(outDir, "run.json"), "utf8"));
    assert.equal(run.navigationTimeoutMs, expected.navigationTimeoutMs);
    assert.equal(run.waitForTimeoutMs, expected.waitForTimeoutMs);
  }
});

// --- fingerprint -------------------------------------------------------------

function fingerprintFixture(capture) {
  const root = mkdtempSync(join(tmpdir(), "autoreview-ui-timeouts-fp-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "Screen.tsx"), "export const Screen = () => null;\n");
  const target = { id: "home", route: "/home", sourceFiles: ["src/Screen.tsx"] };
  return { cfg: { name: "fixture", root, baseUrl: "http://127.0.0.1:9", capture, routes: [target] }, target };
}

test("the capture fingerprint carries the effective Playwright timeouts", () => {
  const { cfg, target } = fingerprintFixture(undefined);
  const defaults = fingerprintTarget(cfg, target);
  assert.deepEqual(defaults.inputs.captureConfig.webTimeouts, { navigationTimeoutMs: 30_000, waitForTimeoutMs: 15_000 });

  cfg.capture = { waitForTimeoutMs: 60_000 };
  const raised = fingerprintTarget(cfg, target);
  assert.deepEqual(raised.inputs.captureConfig.webTimeouts, { navigationTimeoutMs: 30_000, waitForTimeoutMs: 60_000 });
  assert.notEqual(raised.fingerprint, defaults.fingerprint);
  assert.equal(changedFingerprintReason(defaults.inputs, raised.inputs), "capture config changed");
});

test("rn-sim fingerprints keep their shape: they have no Playwright timeouts", () => {
  const { cfg, target } = fingerprintFixture({ mode: "rn-sim", bundleId: "com.example.fixture" });
  const { inputs } = fingerprintTarget(cfg, target);
  assert.equal("webTimeouts" in inputs.captureConfig, false);
  assert.equal(inputs.driverVersion.implementationFiles.includes("web-capture-timeouts.cjs"), false);
});

test("each driver's fingerprint closure covers every local module it loads", () => {
  // Freshness must not survive a change to code a driver runs, so every local
  // module a driver requires (transitively) has to be hashed into its version.
  const scripts = join(__dirname, "..", "scripts");
  const localRequires = (file, seen = new Set()) => {
    if (seen.has(file)) return seen;
    seen.add(file);
    const source = readFileSync(join(scripts, file), "utf8");
    for (const match of source.matchAll(/require\(\s*["']\.\/([^"']+)["']\s*\)/g)) localRequires(match[1], seen);
    return seen;
  };
  for (const [mode, driver] of [["playwright", "shoot.mjs"], ["rn-sim", "shoot-rn.mjs"]]) {
    const { cfg, target } = fingerprintFixture({ mode, bundleId: "com.example.fixture" });
    const hashed = fingerprintTarget(cfg, target).inputs.driverVersion.implementationFiles;
    for (const file of localRequires(driver)) assert.ok(hashed.includes(file), `${mode}: ${file} is not in the driver fingerprint`);
  }
});
