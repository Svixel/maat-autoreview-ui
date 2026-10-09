/**
 * sim-target.cjs — iOS Simulator + accessibility-tree helpers for the rn-sim
 * capture backend.
 *
 * Shared by `ui-review` (preconditions: is a simulator booted, is the app
 * installed, are the CLIs present) and `shoot-rn.mjs` (the driver itself), so
 * there is exactly one definition of "which simulator are we shooting".
 *
 * Two external CLIs, both probed before use:
 *   - `xcrun simctl` — Xcode's own simulator control: screenshots, deep links,
 *     light/dark appearance, status-bar overrides.
 *   - `axe` — AXe (github.com/cameroncooke/axe, `brew install axe`), the
 *     scriptable HID/accessibility driver: `describe-ui`, `tap`, `type`.
 *
 * NAME COLLISION, on purpose kept explicit: the `axe` CLI here is AXe, the iOS
 * automation tool. It is unrelated to axe-core, whose results fill the `axe`
 * field of a target manifest. Code refers to the CLI only via AXE_BIN.
 */

"use strict";

const { spawnSync } = require("node:child_process");

const AXE_BIN = "axe";
const SIMCTL_TIMEOUT_MS = 60_000;
const AX_POLL_MS = 400;

function run(command, args, opts = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: opts.timeout ?? SIMCTL_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    ...opts,
  });
}

/** Run `xcrun simctl …`. Throws with the tool's own stderr on failure. */
function simctl(args, opts = {}) {
  const r = run("xcrun", ["simctl", ...args], opts);
  if (r.error) throw new Error(`simctl ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || "").trim().split("\n")[0];
    throw new Error(`simctl ${args.join(" ")} failed (${r.status})${detail ? `: ${detail}` : ""}`);
  }
  return r.stdout;
}

/** Run `axe …`. Throws with the tool's own stderr on failure. */
function axe(args, opts = {}) {
  const r = run(AXE_BIN, args, opts);
  if (r.error) {
    throw new Error(
      r.error.code === "ENOENT"
        ? `${AXE_BIN} not found — install AXe (\`brew install axe\`) for simulator UI automation`
        : `${AXE_BIN} ${args[0]}: ${r.error.message}`,
    );
  }
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || "").trim().split("\n").pop();
    throw new Error(`${AXE_BIN} ${args[0]} failed (${r.status})${detail ? `: ${detail}` : ""}`);
  }
  return r.stdout;
}

/** Is a CLI present and runnable? Used for the rn-sim precondition check. */
function commandAvailable(command, args) {
  const r = run(command, args, { timeout: 20_000 });
  return !r.error && r.status === 0;
}

/** Every currently booted simulator, newest runtime first as simctl lists them. */
function bootedDevices() {
  const parsed = JSON.parse(simctl(["list", "devices", "booted", "-j"]));
  const out = [];
  for (const [runtime, devices] of Object.entries(parsed.devices || {})) {
    for (const d of devices) {
      if (d.state === "Booted") out.push({ udid: d.udid, name: d.name, runtime });
    }
  }
  return out;
}

/**
 * Pick the simulator to shoot from a config `capture` block.
 *   capture.udid                    → that exact device (must be booted)
 *   capture.simulator.deviceName    → the booted device with that name
 *   otherwise                       → the only booted device
 * Ambiguity is an error, never a guess: shooting the wrong simulator silently
 * produces a plausible-looking but wrong review.
 */
function resolveSimulator(capture = {}) {
  const booted = bootedDevices();
  const listing = booted.length
    ? booted.map((d) => `${d.name} (${d.udid})`).join(", ")
    : "none";
  if (capture.udid) {
    const match = booted.find((d) => d.udid === capture.udid);
    if (!match) {
      throw new Error(
        `simulator ${capture.udid} is not booted (booted: ${listing}). ` +
          `Boot it with: xcrun simctl boot ${capture.udid}`,
      );
    }
    return match;
  }
  const wanted = capture.simulator?.deviceName;
  if (wanted) {
    const matches = booted.filter((d) => d.name === wanted);
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw new Error(
        `no booted simulator named "${wanted}" (booted: ${listing}). ` +
          `Boot it with: xcrun simctl boot "${wanted}"`,
      );
    }
    throw new Error(
      `${matches.length} booted simulators are named "${wanted}" — set capture.udid to disambiguate`,
    );
  }
  if (booted.length === 1) return booted[0];
  if (booted.length === 0) {
    throw new Error("no booted simulator — boot one with `xcrun simctl boot <name-or-udid>`");
  }
  throw new Error(
    `${booted.length} simulators are booted (${listing}) — ` +
      "set capture.udid or capture.simulator.deviceName to choose one",
  );
}

/** Is `bundleId` installed on the device? (`get_app_container` exits 2 if not.) */
function appInstalled(udid, bundleId) {
  const r = run("xcrun", ["simctl", "get_app_container", udid, bundleId], { timeout: 30_000 });
  return !r.error && r.status === 0;
}

/** The app's accessibility tree, as AXe's array of root nodes. */
function describeUi(udid, opts = {}) {
  return JSON.parse(axe(["describe-ui", "--udid", udid], opts));
}

/** Depth-first flatten of an AXe tree into plain element records. */
function flattenAx(nodes, out = [], depth = 0) {
  for (const node of nodes || []) {
    const type = node.type ?? null;
    const role = node.role ?? null;
    const contentSize = node.contentSize ?? node.content_size ?? node.AXContentSize ?? null;
    const contentFrame = node.contentFrame ?? node.content_frame ?? node.AXContentFrame ?? null;
    const viewportFrame = node.viewportFrame ?? node.viewport_frame ?? node.AXViewportFrame ?? null;
    out.push({
      label: node.AXLabel ?? null,
      id: node.AXUniqueId ?? null,
      value: node.AXValue ?? null,
      type,
      role,
      help: node.help ?? null,
      enabled: node.enabled !== false,
      frame: node.frame ?? null,
      // AXe versions expose scroll metadata under different spellings. Keep
      // every source-normalized field here so scroll probing can stay a pure
      // driver concern and matching remains backward compatible.
      scrollable:
        node.scrollable === true ||
        node.AXScrollable === true ||
        node.isScrollable === true ||
        Boolean(contentSize || contentFrame || viewportFrame) ||
        /scroll|collection|table|webview/i.test(`${type || ""} ${role || ""}`),
      contentSize,
      contentFrame,
      viewportFrame,
      customActions: node.custom_actions ?? [],
      childCount: (node.children || []).length,
      depth,
    });
    flattenAx(node.children, out, depth + 1);
  }
  return out;
}

const MATCHER_KEYS = new Set(["label", "id", "value", "type"]);

/**
 * Parse a selector into clauses. Comma-separated `key=value` (exact) or
 * `key~=value` (substring); every clause must match. This is the RN analogue of
 * a CSS selector — the deliberate difference is that it addresses the
 * accessibility tree, which is also what a screen reader sees.
 *
 *   "label=Save"                    "id=compose-fab,type=Button"
 *   "label~=About this"             "type=TextField"
 */
function parseMatcher(selector) {
  if (typeof selector !== "string" || !selector.trim()) {
    throw new Error("empty accessibility selector");
  }
  const clauses = selector.split(",").map((raw) => {
    const m = /^\s*([a-z]+)\s*(~?=)\s*([\s\S]*?)\s*$/i.exec(raw);
    if (!m) {
      throw new Error(
        `bad accessibility selector clause "${raw.trim()}" — expected key=value or key~=value ` +
          `(keys: ${[...MATCHER_KEYS].join(", ")})`,
      );
    }
    const key = m[1].toLowerCase();
    if (!MATCHER_KEYS.has(key)) {
      throw new Error(
        `unknown accessibility selector key "${key}" (keys: ${[...MATCHER_KEYS].join(", ")})`,
      );
    }
    return { key, substring: m[2] === "~=", value: m[3] };
  });
  if (!clauses.length) throw new Error(`empty accessibility selector "${selector}"`);
  return clauses;
}

function clauseMatches(element, clause) {
  const actual = element[clause.key];
  if (typeof actual !== "string") return false;
  return clause.substring ? actual.includes(clause.value) : actual === clause.value;
}

/** Does one flattened element satisfy every clause of a parsed selector? */
function matchesSelector(element, clauses) {
  return clauses.every((c) => clauseMatches(element, c));
}

/** All flattened elements matching a parsed selector, in tree order. */
function matchElements(elements, clauses) {
  return elements.filter((el) => matchesSelector(el, clauses));
}

/**
 * Wait for a selector in the live accessibility tree. This sits beside the
 * matcher rather than in shoot-rn so session preconditions and the driver use
 * the same accessibility semantics. `boundary` makes the timing/AX boundary
 * unit-testable without a simulator.
 */
async function waitForAccessibilityElement(
  udid,
  selector,
  timeoutMs,
  boundary = {},
) {
  const describe = boundary.describeUi ?? describeUi;
  const now = boundary.now ?? Date.now;
  const sleep = boundary.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const clauses = parseMatcher(selector);
  const deadline = now() + timeoutMs;
  let lastAxError = null;
  const timeoutError = () => {
    const detail = lastAxError
      ? ` Last AXe error: ${lastAxError.message || String(lastAxError)}`
      : "";
    return new Error(
      `readiness "${selector}" not found within ${timeoutMs}ms ` +
        `(\`axe describe-ui --udid ${udid}\` shows the live tree).${detail}`,
    );
  };
  for (;;) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw timeoutError();
    try {
      // describe-ui is synchronous, so it must receive the session's remaining
      // budget instead of AXe's generic 60s command timeout.
      const matches = matchElements(
        flattenAx(describe(udid, { timeout: Math.max(1, Math.floor(remainingMs)) })),
        clauses,
      );
      lastAxError = null;
      if (matches.length) return matches[0];
    } catch (err) {
      // AXe can return a transiently incomplete tree during a route change.
      // Retain a persistent failure so the final timeout names the real AXe
      // problem instead of misdiagnosing it as a missing readiness selector.
      lastAxError = err;
    }
    const afterReadMs = deadline - now();
    if (afterReadMs <= 0) throw timeoutError();
    await sleep(Math.min(AX_POLL_MS, afterReadMs));
  }
}

/**
 * An external session is prepared by the project, never by this skill. Before
 * shooting the first target, prove the project-supplied readiness selector is
 * present instead of guessing with a delay.
 */
async function assertCaptureSession(capture, sim, boundary = {}) {
  const session = capture?.session;
  if (!session) return null;
  return waitForAccessibilityElement(sim.udid, session.readiness, session.timeoutMs, boundary);
}

module.exports = {
  AXE_BIN,
  appInstalled,
  assertCaptureSession,
  axe,
  bootedDevices,
  commandAvailable,
  describeUi,
  flattenAx,
  matchElements,
  matchesSelector,
  parseMatcher,
  resolveSimulator,
  run,
  simctl,
  waitForAccessibilityElement,
};
