#!/usr/bin/env node
/**
 * shoot-rn.mjs — standalone, project-decoupled UI shot driver for React Native
 * apps running on an iOS Simulator. The rn-sim sibling of shoot.mjs.
 *
 * Same contract as shoot.mjs: reads a self-contained run.json, writes only into
 * run.outDir, imports NO project code, and emits a byte-compatible manifest so
 * ui-review's summarize/actionable and the agent's vision pass are unchanged.
 *
 *   node shoot-rn.mjs --run /abs/run.json    # or UI_SHOOT_RUN=/abs/run.json
 *
 * The web axes map onto native like this:
 *
 *   page.goto(url)          → xcrun simctl openurl  (deep links address screens)
 *   viewport matrix         → light/dark appearance  (a phone has ONE viewport;
 *                             the axis worth sweeping is the colour scheme)
 *   CSS selector            → accessibility selector (see parseMatcher: the tree
 *                             a screen reader sees, so unlabelled controls are
 *                             unaddressable — which is itself the finding)
 *   axe-core                → a runtime accessibility-tree audit (axAudit)
 *   screenshot({clip})      → full-display screenshot + a real PNG crop
 *
 * Deliberate differences from the web driver, all forced by the platform:
 *   - No hover/focus/active. iOS has no pointer hover and no DOM focus ring;
 *     those actions are rejected rather than faked.
 *   - No freezeMotion. Animations live inside the app process and cannot be
 *     disabled from outside it, so determinism comes from a stable-retake loop
 *     (shoot twice, compare bytes, retry) plus a status-bar override.
 *   - The a11y audit runs BEFORE interactions, on the freshly-navigated screen.
 *     Auditing last would audit a half-open sheet.
 *   - One session for the whole run: an app has a single signed-in identity, so
 *     per-target `role` switching is not supported (ui-review rejects it).
 *
 * Why every target relaunches the app (`capture.session.launchArgs`):
 * a deep link addresses a route, it does not dismiss what is already on top.
 * A presented full-screen route therefore survives `openurl`, and — because
 * the accessibility tree still contains the covered screen underneath — the
 * `waitFor` selector matches, the target records "captured", and the shot is
 * of the wrong screen. That failure is silent, which makes it the worst kind.
 * Terminating and relaunching is the only reset iOS offers from outside the
 * app process, so each target starts from a guaranteed root and the readiness
 * marker is re-proven before its deep link is sent.
 */

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { decodePng, cropImage, encodePng, regionEquals } = require("./png.cjs");
const {
  assertSafeTargetId,
  composeDeepLinkUrl,
  shotFile: targetShotFile,
  targetManifestFile,
} = require("./capture-contract.cjs");
const {
  appInstalled,
  axe,
  describeUi,
  flattenAx,
  matchElements,
  matchesSelector,
  parseMatcher,
  resolveSimulator,
  simctl,
} = require("./sim-target.cjs");

const DEFAULT_APPEARANCES = ["light", "dark"];
const DEFAULT_STATUS_BAR = { time: "9:41", batteryState: "charged", batteryLevel: 100 };
const REGION_PADDING_PT = 14;
const SWIPE_MARGIN_PT = 8;
const POLL_MS = 400;
const SUPPORTED_ACTIONS = new Set(["tap", "fill"]);
/** Native analogues of the web actions we cannot perform (see header comment). */
const UNSUPPORTED_ACTIONS = { hover: "tap", focus: "tap", active: "tap", click: "tap" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadRun() {
  const idx = process.argv.indexOf("--run");
  const path = idx >= 0 ? process.argv[idx + 1] : process.env.UI_SHOOT_RUN;
  if (!path) throw new Error("[shoot-rn] --run <run.json> (or UI_SHOOT_RUN) required");
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Read an auth secret out of an env file (same format as shoot.mjs).
 * An absolute `secretFile` is honoured as-is so the token can live outside the
 * repo — this skill never writes into a project, and a mobile app's review
 * token is a server secret that has no reason to be committed there.
 */
function readSecret(run) {
  const { root = process.cwd(), auth } = run;
  const configured = auth.secretFile || ".env.local";
  const file = isAbsolute(configured) ? configured : join(root, configured);
  const env = auth.secretEnv || "APP_REVIEW_SIGNIN_TOKEN";
  const key = env.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = readFileSync(file, "utf8").match(
    new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^#\\n]*))`, "m"),
  );
  if (!m) throw new Error(`[shoot-rn] ${env} not found in ${file}`);
  return m[1] ?? m[2] ?? m[3].trim();
}

// ---------------------------------------------------------------------------
// Simulator I/O
// ---------------------------------------------------------------------------

/** Capture the whole display and return the PNG bytes. */
function capture(ctx) {
  rmSync(ctx.tmpShot, { force: true });
  simctl(["io", ctx.udid, "screenshot", ctx.tmpShot]);
  return readFileSync(ctx.tmpShot);
}

/**
 * Capture once the display stops changing: take shots `stableRetries` times and
 * return the first pair that is byte-identical. RN/Reanimated animations run
 * inside the app and cannot be frozen from outside, so this is the substitute
 * for the web driver's freezeMotion.
 */
async function captureStable(ctx) {
  const retries = Math.max(1, ctx.capture.stableRetries ?? 3);
  const interval = ctx.capture.stableIntervalMs ?? 400;
  let previous = capture(ctx);
  for (let attempt = 1; attempt <= retries; attempt++) {
    await sleep(interval);
    const next = capture(ctx);
    if (next.equals(previous)) return { buffer: next, stable: true };
    previous = next;
  }
  return { buffer: previous, stable: false };
}

function setAppearance(ctx, appearance) {
  simctl(["ui", ctx.udid, "appearance", appearance]);
}

/**
 * The device's current appearance, or null when the runtime cannot report one
 * (`unsupported` / `unknown`) — in which case there is nothing to restore.
 */
function readAppearance(ctx) {
  try {
    const value = simctl(["ui", ctx.udid, "appearance"]).trim();
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function overrideStatusBar(ctx) {
  const bar = { ...DEFAULT_STATUS_BAR, ...(ctx.capture.statusBar || {}) };
  const args = ["status_bar", ctx.udid, "override"];
  for (const [key, value] of Object.entries(bar)) {
    if (value === null || value === undefined) continue;
    args.push(`--${key}`, String(value));
  }
  simctl(args);
}

/**
 * Undo every durable mutation this driver makes to the simulator. Both the
 * status-bar override and the appearance outlive the process, so without this a
 * finished (or crashed) run leaves the device stuck on a fake 9:41 status bar
 * and whatever colour scheme the sweep ended on — poisoning every later manual
 * QA session on that device. Best-effort: a restore failure must never mask the
 * real error that is unwinding.
 */
function restoreSimulatorState(ctx, priorAppearance) {
  try {
    simctl(["status_bar", ctx.udid, "clear"]);
  } catch (err) {
    process.stderr.write(`[shoot-rn] could not clear the status bar override: ${err.message}\n`);
  }
  if (!priorAppearance) return;
  try {
    setAppearance(ctx, priorAppearance);
  } catch (err) {
    process.stderr.write(
      `[shoot-rn] could not restore appearance to ${priorAppearance}: ${err.message}\n`,
    );
  }
}

/** Replace a secret with a placeholder so it can never reach a log or manifest. */
function redact(text, secret) {
  return secret ? String(text).split(secret).join("<redacted>") : String(text);
}

/**
 * Open a deep link. `secret` (when present) is scrubbed from any thrown message
 * — simctl echoes its arguments on failure, and the reviewer token must never
 * land in stderr or the manifest.
 */
function openUrl(ctx, url, secret = null) {
  try {
    simctl(["openurl", ctx.udid, url]);
  } catch (err) {
    throw new Error(redact(err.message, secret));
  }
}

function screenUrl(ctx, route, params) {
  return composeDeepLinkUrl(ctx.capture.scheme, route, params);
}

// ---------------------------------------------------------------------------
// Accessibility tree
// ---------------------------------------------------------------------------

function elements(ctx) {
  return flattenAx(describeUi(ctx.udid));
}

/** First element matching `selector`, or null. */
function findElement(ctx, selector) {
  const matches = matchElements(elements(ctx), parseMatcher(selector));
  return matches.length ? matches[0] : null;
}

async function waitForElement(ctx, selector, timeoutMs) {
  const clauses = parseMatcher(selector);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let matches = [];
    try {
      matches = matchElements(elements(ctx), clauses);
    } catch {
      // A tree read can fail transiently while the app is mid-transition.
      matches = [];
    }
    if (matches.length) return matches[0];
    if (Date.now() >= deadline) {
      throw new Error(
        `waitFor "${selector}" not found within ${timeoutMs}ms — the screen never opened. ` +
          `Check that the route is registered in the app's deep-link config, and that the ` +
          `selector matches a real accessibility label (\`axe describe-ui --udid ${ctx.udid}\`).`,
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * The display's points-per-pixel scale, measured rather than assumed: compare a
 * real screenshot's pixel width to the accessibility root's point width. Works
 * on any device without a hardcoded device-type table.
 */
function measureScale(ctx) {
  const image = decodePng(capture(ctx));
  const roots = describeUi(ctx.udid);
  const pointWidth = Math.max(...roots.map((r) => r.frame?.width || 0), 0);
  const pointHeight = Math.max(...roots.map((r) => r.frame?.height || 0), 0);
  if (!pointWidth || !pointHeight) {
    throw new Error("[shoot-rn] could not read the accessibility root frame to measure scale");
  }
  return {
    scale: image.width / pointWidth,
    pointWidth: Math.round(pointWidth),
    pointHeight: Math.round(pointHeight),
    pixelWidth: image.width,
    pixelHeight: image.height,
  };
}

/** Convert an accessibility frame (points) to a padded pixel rect. */
function frameToPixelRect(ctx, frame, paddingPt = 0) {
  const s = ctx.scale;
  const x = (frame.x - paddingPt) * s;
  const y = (frame.y - paddingPt) * s;
  return {
    x,
    y,
    width: (frame.width + paddingPt * 2) * s,
    height: (frame.height + paddingPt * 2) * s,
  };
}

function writeCrop(buffer, rect, path) {
  const cropped = cropImage(decodePng(buffer), rect);
  if (!cropped) return false;
  writeFileSync(path, encodePng(cropped));
  return true;
}

function wantsScrollProbe(target) {
  return (target.captureVariants || []).includes("scroll");
}

function scrollProbeOptions(run, target) {
  const global = run.capture?.scrollProbe || run.scrollProbe || {};
  const local = target.scrollProbe || {};
  return {
    ...global,
    ...local,
    thresholds: { ...(global.thresholds || {}), ...(local.thresholds || {}) },
    maxSwipes: local.maxSwipes ?? global.maxSwipes ?? 8,
    swipePercent: local.swipePercent ?? global.swipePercent ?? 0.8,
    settleMs: local.settleMs ?? global.settleMs ?? run.settleMs ?? 350,
    sliverExtentViewportRatio:
      local.thresholds?.sliverExtentViewportRatio ??
      global.thresholds?.sliverExtentViewportRatio ??
      0.15,
  };
}

function selectorRequestsForTarget(run, targetId) {
  return [...new Set(
    (run.cropRequests || [])
      .filter((request) => request.axSelector && request.assetId.startsWith(`${targetId}/`))
      .map((request) => request.axSelector),
  )].sort();
}

function frameForManifest(frame) {
  if (!frame || ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite)) return null;
  return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
}

function axisSize(value) {
  if (value && typeof value === "object") return value.height ?? value.Height ?? null;
  return null;
}

function axTreeSignature(tree) {
  return JSON.stringify(tree || null);
}

function axDescription(el) {
  return [el.type || el.role || "element", el.id || el.label || el.value || ""].join(":");
}

function revealedSummary(preTree, postTree) {
  const before = new Set(flattenAx(preTree).map(axDescription));
  const revealed = [...new Set(flattenAx(postTree).map(axDescription))]
    .filter((description) => !before.has(description))
    .sort();
  return { count: revealed.length, elements: revealed.slice(0, 12), omitted: Math.max(0, revealed.length - 12) };
}

function selectScrollContainer(tree, options) {
  const all = flattenAx(tree);
  if (options.containerSelector) {
    try {
      return {
        selector: options.containerSelector,
        element: matchElements(all, parseMatcher(options.containerSelector))[0] || null,
        all,
      };
    } catch {
      return { selector: options.containerSelector, element: null, all };
    }
  }
  const candidates = all
    .filter((element) => element.scrollable && element.frame)
    .sort((left, right) =>
      right.frame.width * right.frame.height - left.frame.width * left.frame.height ||
      left.depth - right.depth,
    );
  return { selector: "largest-scrollable", element: candidates[0] || null, all };
}

function scrollFrames(selection, options) {
  const container = selection.element;
  if (!container) return { container: null, content: null, viewport: null, footer: null };
  const viewport = frameForManifest(container.viewportFrame || container.frame);
  const contentFrame = frameForManifest(container.contentFrame) || (() => {
    const height = axisSize(container.contentSize);
    return Number.isFinite(height) && viewport
      ? { x: viewport.x, y: viewport.y, width: viewport.width, height }
      : null;
  })();
  let footer = null;
  if (options.footerSelector) {
    try { footer = matchElements(selection.all, parseMatcher(options.footerSelector))[0]?.frame || null; } catch { footer = null; }
  } else {
    footer = selection.all.find((element) => /footer/i.test(`${element.type || ""} ${element.role || ""}`))?.frame || null;
  }
  return {
    container: frameForManifest(container.frame),
    content: contentFrame,
    viewport,
    footer: frameForManifest(footer),
  };
}

function scrollGeometry(selection, frames) {
  const contentHeight = frames.content?.height;
  const viewportHeight = frames.viewport?.height;
  return Number.isFinite(contentHeight) && Number.isFinite(viewportHeight)
    ? { contentHeight, viewportHeight }
    : null;
}

function rnScrollAtBottom(selection) {
  // A content frame that moves relative to the viewport exposes the native
  // equivalent of scrollTop. Do not infer this from contentSize alone: that
  // gives extent but no position, so the AX-signature fallback remains the
  // reliable end-state check in that case.
  const content = frameForManifest(selection.element?.contentFrame);
  const viewport = frameForManifest(selection.element?.viewportFrame || selection.element?.frame);
  return Boolean(
    content &&
    viewport &&
    content.height >= viewport.height &&
    content.y + content.height <= viewport.y + viewport.height + 0.5,
  );
}

function scrollFacts(selection, frames, options, preAxTree, postAxTree, bottomReached, swipeCount, inert) {
  const geometry = scrollGeometry(selection, frames);
  const scrollExtentPt = geometry ? Math.max(0, geometry.contentHeight - geometry.viewportHeight) : null;
  const sliverScroll = geometry && selection.element?.scrollable
    ? scrollExtentPt < geometry.viewportHeight * options.sliverExtentViewportRatio
    : inert
      ? "suspected"
      : null;
  const observedScrollContainer = Boolean(selection.element);
  return {
    scrollable: observedScrollContainer ? Boolean(selection.element.scrollable) : null,
    scrollExtentPt,
    viewportPt: geometry?.viewportHeight ?? null,
    // AXe often exposes the container frame without content geometry. A
    // completed swipe sequence still yields useful evidence in that case.
    bottomReached: observedScrollContainer ? bottomReached : null,
    revealed: observedScrollContainer ? revealedSummary(preAxTree, postAxTree) : null,
    containerSelector: selection.selector,
    frames,
    sliverScroll,
    inert: swipeCount > 0 ? Boolean(inert) : null,
    layoutEconomy: geometry
      ? sliverScroll
        ? { verdict: "flagged", flags: ["sliver-scroll"] }
        : { verdict: "not-flagged", flags: [] }
      : {
          verdict: "not-judged",
          reason: "scroll geometry unavailable",
          ...(inert ? { flags: ["sliver-scroll-suspected"] } : {}),
        },
    preAxTree,
    postAxTree,
    swipeCount,
    maxSwipes: options.maxSwipes,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function swipeCoordinates(frame, swipePercent) {
  const margin = Math.min(SWIPE_MARGIN_PT, Math.max(1, frame.height * 0.1));
  const minY = frame.y + margin;
  const maxY = frame.y + frame.height - margin;
  const startY = clamp(frame.y + frame.height * 0.8, minY, maxY);
  // A swipe that reveals lower content travels upward. Derive the end from
  // the actual start, then keep both contacts safely inside the container.
  const endY = clamp(startY - frame.height * swipePercent, minY, maxY);
  return {
    x: Math.round(frame.x + frame.width / 2),
    startY: Math.round(startY),
    endY: Math.round(endY),
  };
}

function swipeScrollContainer(ctx, frame, options) {
  const { x, startY, endY } = swipeCoordinates(frame, options.swipePercent);
  axe([
    "swipe",
    "--start-x", String(x),
    "--start-y", String(startY),
    "--end-x", String(x),
    "--end-y", String(endY),
    "--duration", "0.3",
    "--udid", ctx.udid,
  ]);
}

function selectorFrameEvidence(ctx, selectors, clipFrame = null) {
  if (!selectors.length) return { frames: {}, outsideClip: [] };
  const root = { width: ctx.pointWidth, height: ctx.pointHeight };
  const all = elements(ctx);
  const frames = {};
  const outsideClip = [];
  for (const selector of selectors) {
    let element;
    try { element = matchElements(all, parseMatcher(selector))[0]; } catch { continue; }
    const frame = element?.frame;
    if (!frame || !root.width || !root.height || frame.width <= 0 || frame.height <= 0) continue;
    if (clipFrame) {
      const right = frame.x + frame.width;
      const bottom = frame.y + frame.height;
      const clipRight = clipFrame.x + clipFrame.width;
      const clipBottom = clipFrame.y + clipFrame.height;
      if (right <= clipFrame.x || frame.x >= clipRight || bottom <= clipFrame.y || frame.y >= clipBottom) {
        outsideClip.push(selector);
        continue;
      }
      // A partial overlap is still evidence in the clipped PNG. Clamp it to
      // the image and record its coordinates relative to the clip, not the
      // simulator display.
      const x = Math.max(frame.x, clipFrame.x);
      const y = Math.max(frame.y, clipFrame.y);
      const clippedRight = Math.min(right, clipRight);
      const clippedBottom = Math.min(bottom, clipBottom);
      frames[selector] = {
        x: (x - clipFrame.x) / clipFrame.width,
        y: (y - clipFrame.y) / clipFrame.height,
        w: (clippedRight - x) / clipFrame.width,
        h: (clippedBottom - y) / clipFrame.height,
        normalized: true,
      };
      continue;
    }
    const normalized = {
      x: frame.x / root.width,
      y: frame.y / root.height,
      w: frame.width / root.width,
      h: frame.height / root.height,
      normalized: true,
    };
    if (normalized.x < 0 || normalized.y < 0 || normalized.x + normalized.w > 1 || normalized.y + normalized.h > 1) continue;
    frames[selector] = normalized;
  }
  return { frames, outsideClip };
}

function selectorFrames(ctx, selectors, clipFrame = null) {
  return selectorFrameEvidence(ctx, selectors, clipFrame).frames;
}

async function captureScrollProbe(ctx, run, target, manifest, viewport) {
  const options = scrollProbeOptions(run, target);
  const selectors = selectorRequestsForTarget(run, target.id);
  const preAxTree = describeUi(ctx.udid);
  let selection = selectScrollContainer(preAxTree, options);
  let frames = scrollFrames(selection, options);
  const top = await captureStable(ctx);
  if (!top.stable) manifest.errors.push(`${viewport.name}: scroll top display never settled`);
  const topPath = targetShotFile(run.outDir, target.id, [viewport.name, "scroll-top"]);
  writeFileSync(topPath, top.buffer);
  manifest.shots.push({
    viewport: viewport.name,
    path: topPath,
    kind: "scroll-top",
    variant: "scroll-top",
    selectorFrames: selectorFrames(ctx, selectors),
  });

  let tree = preAxTree;
  let previous = axTreeSignature(tree);
  let bottomReached = false;
  let swipeCount = 0;
  let inert = false;
  if (frames.container) {
    for (let attempt = 0; attempt < options.maxSwipes; attempt++) {
      swipeScrollContainer(ctx, frames.container, options);
      swipeCount++;
      await sleep(options.settleMs);
      tree = describeUi(ctx.udid);
      selection = selectScrollContainer(tree, options);
      frames = scrollFrames(selection, options);
      const signature = axTreeSignature(tree);
      const revealed = revealedSummary(preAxTree, tree);
      if (attempt === 0 && signature === previous && revealed.count === 0) inert = true;
      // A content frame can land on the viewport's lower edge on the final
      // allowed swipe. That is bottom evidence even when there is no later
      // no-op gesture to stabilize the AX signature.
      if (rnScrollAtBottom(selection)) {
        bottomReached = true;
        break;
      }
      if (signature === previous) {
        bottomReached = true;
        break;
      }
      previous = signature;
      if (!frames.container) break;
    }
  }
  const bottom = await captureStable(ctx);
  if (!bottom.stable) manifest.errors.push(`${viewport.name}: scroll bottom display never settled`);
  const bottomPath = targetShotFile(run.outDir, target.id, [viewport.name, "scroll-bottom"]);
  writeFileSync(bottomPath, bottom.buffer);
  manifest.shots.push({
    viewport: viewport.name,
    path: bottomPath,
    kind: "scroll-bottom",
    variant: "scroll-bottom",
    selectorFrames: selectorFrames(ctx, selectors),
  });
  return scrollFacts(selection, frames, options, preAxTree, tree, bottomReached, swipeCount, inert);
}

// ---------------------------------------------------------------------------
// Accessibility audit (fills the manifest's `axe` slot)
// ---------------------------------------------------------------------------

const A11Y_HELP_URL =
  "https://developer.apple.com/design/human-interface-guidelines/accessibility";
const INTERACTIVE_TYPES = new Set([
  "Button",
  "Link",
  "Switch",
  "TextField",
  "SecureTextField",
  "SearchField",
  "Slider",
  "Stepper",
  "CheckBox",
  "RadioButton",
  "PopUpButton",
]);

function describeElement(el) {
  const bits = [el.type || el.role || "element"];
  if (el.id) bits.push(`id=${el.id}`);
  else if (el.label) bits.push(`label=${el.label}`);
  else if (el.value) bits.push(`value=${el.value}`);
  if (el.frame) {
    bits.push(
      `@${Math.round(el.frame.x)},${Math.round(el.frame.y)} ` +
        `${Math.round(el.frame.width)}x${Math.round(el.frame.height)}pt`,
    );
  }
  return bits.join(" ");
}

/**
 * Audit the live accessibility tree and shape the result exactly like axe-core's
 * violations, so every downstream consumer (summarize, actionable, the vision
 * pass, the findings schema) treats web and native results identically.
 *
 * `axAudit` config (from capture.axAudit):
 *   rules            – { "rn/touch-target-size": false } to disable one
 *   touchTargetMinPt – minimum interactive edge in points (default 44)
 *   ignore           – accessibility selectors exempted from every rule
 */
function axAudit(ctx) {
  const cfg = ctx.capture.axAudit || {};
  const enabled = (rule) => cfg.rules?.[rule] !== false;
  const minPt = cfg.touchTargetMinPt ?? 44;
  const ignoreClauses = (cfg.ignore || []).map(parseMatcher);
  const all = elements(ctx).filter(
    (el) => !ignoreClauses.some((clauses) => matchesSelector(el, clauses)),
  );

  const byRule = new Map();
  const add = (rule, impact, help, el, failureSummary) => {
    if (!enabled(rule)) return;
    if (!byRule.has(rule)) {
      byRule.set(rule, { id: rule, impact, help, helpUrl: A11Y_HELP_URL, nodes: [] });
    }
    byRule.get(rule).nodes.push({ target: [describeElement(el)], failureSummary });
  };

  for (const el of all) {
    const named = Boolean(el.label || el.id || el.value || el.help);
    const isButton = el.type === "Button" || el.role === "AXButton";
    const isImage = el.type === "Image" || el.role === "AXImage";

    if (isButton && !named) {
      add(
        "rn/button-name",
        "critical",
        "Buttons must have an accessible name",
        el,
        "This control is in the accessibility tree with no label, identifier, or value, " +
          "so VoiceOver announces nothing. Add accessibilityLabel.",
      );
    }
    if (isImage && !el.label) {
      add(
        "rn/image-alt",
        "serious",
        "Images must have an accessible name or be hidden from assistive tech",
        el,
        "This image is exposed to assistive tech with no label. Add accessibilityLabel, " +
          "or mark it decorative with accessible={false} / accessibilityElementsHidden.",
      );
    }
    if (
      INTERACTIVE_TYPES.has(el.type) &&
      el.frame &&
      (el.frame.width < minPt || el.frame.height < minPt)
    ) {
      add(
        "rn/touch-target-size",
        "minor",
        `Interactive targets should be at least ${minPt}x${minPt}pt`,
        el,
        `Accessibility frame is ${Math.round(el.frame.width)}x${Math.round(el.frame.height)}pt, ` +
          `below ${minPt}pt. NOTE: hitSlop enlarges the touchable area but NOT the accessibility ` +
          `frame, so a control that is intentionally small with hitSlop reports here too — ` +
          `confirm against the source before treating it as a defect.`,
      );
    }
  }
  return { violations: [...byRule.values()] };
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

function tapElement(ctx, el) {
  const x = Math.round(el.frame.x + el.frame.width / 2);
  const y = Math.round(el.frame.y + el.frame.height / 2);
  axe(["tap", "-x", String(x), "-y", String(y), "--udid", ctx.udid]);
}

function applyAction(ctx, el, interaction) {
  switch (interaction.action) {
    case "tap":
      tapElement(ctx, el);
      return;
    case "fill":
      tapElement(ctx, el);
      axe(["type", interaction.value ?? "Test input", "--udid", ctx.udid]);
      return;
    default:
      throw new Error(unsupportedActionMessage(interaction.action));
  }
}

function unsupportedActionMessage(action) {
  const alternative = UNSUPPORTED_ACTIONS[action];
  if (alternative) {
    return (
      `action "${action}" has no iOS equivalent (no pointer hover, no DOM focus ring) — ` +
      `use "${alternative}"`
    );
  }
  return `unsupported action "${action}" (supported: ${[...SUPPORTED_ACTIONS].join(", ")})`;
}

async function runInteraction(ctx, outDir, target, interaction, viewportName, selectors = []) {
  const record = {
    id: interaction.id,
    viewport: viewportName,
    action: interaction.action,
    selector: interaction.selector,
    statePath: null,
    changed: true,
  };
  if (!SUPPORTED_ACTIONS.has(interaction.action)) {
    throw new Error(unsupportedActionMessage(interaction.action));
  }
  const el = findElement(ctx, interaction.selector);
  if (!el) {
    record.note = "selector not found";
    record.changed = false;
    return record;
  }
  if (!el.frame) {
    record.note = "no bounding box";
    record.changed = false;
    return record;
  }

  const mode = interaction.screenshot ?? (interaction.action === "tap" ? "page" : "region");
  const statePath = targetShotFile(outDir, target.id, [viewportName, interaction.id]);

  // `before` is taken STABLE, like `after`. Diffing a mid-animation frame
  // against a settled one reports "changed" for every interaction on a screen
  // that happens to be animating, which is the same blindness as not diffing.
  const before = (await captureStable(ctx)).buffer;

  if (mode === "region") {
    const rect = frameToPixelRect(ctx, el.frame, REGION_PADDING_PT);
    applyAction(ctx, el, interaction);
    await sleep(ctx.settleMs);
    const after = (await captureStable(ctx)).buffer;
    if (!writeCrop(after, rect, statePath)) {
      record.note = "region is outside the display";
      record.changed = false;
      return record;
    }
    record.statePath = statePath;
    record.changed = !regionEquals(before, after, rect);
  } else {
    // "page" mode — the default for `tap`, because a tap usually navigates or
    // opens a sheet, i.e. changes the whole display rather than the control.
    // `changed` MUST be computed here too: ui-review's MISSING-STATE signal
    // keys on `changed === false`, so leaving the initialiser in place made a
    // dead control indistinguishable from a working one on the ONE action that
    // matters most on iOS. Byte equality is the same notion of "unchanged"
    // captureStable already uses.
    applyAction(ctx, el, interaction);
    await sleep(ctx.settleMs);
    const after = (await captureStable(ctx)).buffer;
    writeFileSync(statePath, after);
    record.statePath = statePath;
    record.changed = !before.equals(after);
    record.selectorFrames = selectorFrames(ctx, selectors);
  }
  return record;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function authenticate(ctx, run) {
  const auth = run.auth;
  if (!auth || auth.mode === "none") return;
  if (auth.mode !== "reviewSignin") {
    throw new Error(`[shoot-rn] unsupported auth mode "${auth.mode}"`);
  }
  const secret = readSecret(run);
  const path = (auth.path || "app-review-signin").replace(/^\/+/, "");
  process.stderr.write(`[shoot-rn] signing in via ${ctx.capture.scheme}://${path}…\n`);
  openUrl(ctx, `${ctx.capture.scheme}://${path}?token=${encodeURIComponent(secret)}`, secret);
  await sleep(ctx.settleMs);
  if (auth.waitFor) {
    try {
      await waitForElement(ctx, auth.waitFor, auth.timeoutMs ?? 30_000);
    } catch (err) {
      throw new Error(`[shoot-rn] sign-in did not complete: ${redact(err.message, secret)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * Return the app to its root before a deep link is sent. `simctl terminate`
 * fails when the app is not running, which is a normal state here, so only a
 * launch failure is an error. The readiness marker is re-proven after every
 * relaunch: without it the deep link can race the app's own boot navigation.
 */
async function resetToRoot(ctx) {
  const { bundleId, session } = ctx.capture;
  try {
    simctl(["terminate", ctx.udid, bundleId]);
  } catch {
    // Not running. Launching is the next step either way.
  }
  const args = Object.entries(session?.launchArgs || {}).flatMap(([key, value]) => [`-${key}`, String(value)]);
  simctl(["launch", ctx.udid, bundleId, ...args]);
  await sleep(ctx.settleMs);
  if (session?.readiness) {
    try {
      await waitForElement(ctx, session.readiness, session.timeoutMs ?? 30_000);
    } catch (err) {
      throw new Error(
        `[shoot-rn] the app did not reach capture.session.readiness after relaunch: ${err.message}` +
          (session.bootstrapHint ? `\n  → ${session.bootstrapHint}` : ""),
      );
    }
  }
}

async function openScreen(ctx, target) {
  // A deep link navigates under whatever is presented; only a relaunch clears
  // it. See the "why every target relaunches" note at the top of this file.
  if (ctx.resetBetweenTargets) await resetToRoot(ctx);
  openUrl(ctx, screenUrl(ctx, target.route, target.params));
  await sleep(ctx.settleMs);
  if (target.waitFor) {
    await waitForElement(ctx, target.waitFor, target.timeoutMs ?? 15_000);
  }
}

async function shootTarget(ctx, run, target, viewports) {
  const { outDir } = run;
  assertSafeTargetId(target.id);
  const manifest = {
    id: target.id,
    route: target.route,
    role: target.role ?? null,
    shots: [],
    interactions: [],
    axe: null,
    errors: [],
  };
  try {
    const cropSelectors = selectorRequestsForTarget(run, target.id);
    for (const viewport of viewports) {
      setAppearance(ctx, viewport.appearance);
      await openScreen(ctx, target);
      const { buffer, stable } = await captureStable(ctx);
      if (!stable) {
        manifest.errors.push(
          `${viewport.name}: display never settled — the shot may catch a mid-animation frame`,
        );
      }
      if (target.clip) {
        const el = findElement(ctx, target.clip);
        const path = targetShotFile(outDir, target.id, [viewport.name, "clip"]);
        if (el?.frame && writeCrop(buffer, frameToPixelRect(ctx, el.frame), path)) {
          const selectorEvidence = selectorFrameEvidence(ctx, cropSelectors, el.frame);
          manifest.shots.push({
            viewport: viewport.name,
            path,
            kind: "clip",
            selectorFrames: selectorEvidence.frames,
            ...(selectorEvidence.outsideClip.length
              ? { selectorOutsideClip: selectorEvidence.outsideClip }
              : {}),
          });
        } else {
          manifest.errors.push(`clip "${target.clip}" not found at ${viewport.name}`);
        }
      } else {
        const path = targetShotFile(outDir, target.id, [viewport.name, "full"]);
        writeFileSync(path, buffer);
        manifest.shots.push({ viewport: viewport.name, path, kind: "full", selectorFrames: selectorFrames(ctx, cropSelectors) });
      }
      if (wantsScrollProbe(target)) {
        // Re-open before probing so the top capture is an actual route entry,
        // not a display that a previous full screenshot happened to leave.
        await openScreen(ctx, target);
        const facts = await captureScrollProbe(ctx, run, target, manifest, viewport);
        if (!manifest.scroll) manifest.scroll = facts;
        (manifest.scrollProbes ??= []).push({ viewport: viewport.name, ...facts });
      }
    }

    // Re-open cleanly, then audit BEFORE interacting (see header comment).
    setAppearance(ctx, viewports[0].appearance);
    await openScreen(ctx, target);

    if (target.axe ?? true) {
      try {
        manifest.axe = axAudit(ctx);
      } catch (err) {
        manifest.errors.push(`axe: ${err.message}`);
      }
    }

    for (const interaction of target.interactions ?? []) {
      try {
        manifest.interactions.push(
          await runInteraction(ctx, outDir, target, interaction, viewports[0].name, cropSelectors),
        );
      } catch (err) {
        manifest.errors.push(`interaction "${interaction.id}": ${err.message}`);
      }
      // Re-open so the next interaction starts from the same known screen —
      // native has no "press Escape and you are back" guarantee.
      try {
        await openScreen(ctx, target);
      } catch (err) {
        manifest.errors.push(`reset after "${interaction.id}": ${err.message}`);
        break;
      }
    }
  } catch (err) {
    manifest.errors.push(err.message);
  } finally {
    const fragPath = targetManifestFile(outDir, target.id);
    writeFileSync(fragPath, JSON.stringify(manifest, null, 2));
  }
  return manifest;
}

// ---------------------------------------------------------------------------

async function main() {
  const run = loadRun();
  const captureCfg = run.capture || {};
  if (!captureCfg.scheme) {
    throw new Error('[shoot-rn] capture.scheme is required (e.g. "acmemobile")');
  }
  if (!captureCfg.bundleId) throw new Error("[shoot-rn] capture.bundleId is required");
  for (const target of run.targets || []) assertSafeTargetId(target.id);
  mkdirSync(run.outDir, { recursive: true });

  const sim = resolveSimulator(captureCfg);
  if (!appInstalled(sim.udid, captureCfg.bundleId)) {
    throw new Error(
      `[shoot-rn] ${captureCfg.bundleId} is not installed on ${sim.name} (${sim.udid})`,
    );
  }

  const ctx = {
    udid: sim.udid,
    deviceName: sim.name,
    capture: captureCfg,
    settleMs: run.settleMs ?? 350,
    tmpShot: join(run.outDir, ".capture.tmp.png"),
    scale: 1,
    // Default on: a run that silently captures a covered screen is worse than
    // a slower run. Opting out is only defensible when a project proves no
    // route in the set can present over another.
    resetBetweenTargets: captureCfg.session?.resetBetweenTargets ?? true,
  };

  // Read before the first mutation: this is the state the device must be left
  // in, whichever way the run ends.
  const priorAppearance = readAppearance(ctx);
  const appearances = captureCfg.appearance?.length ? captureCfg.appearance : DEFAULT_APPEARANCES;

  try {
    overrideStatusBar(ctx);
    setAppearance(ctx, appearances[0]);

    await authenticate(ctx, run);

    const metrics = measureScale(ctx);
    ctx.scale = metrics.scale;
    ctx.pointWidth = metrics.pointWidth;
    ctx.pointHeight = metrics.pointHeight;
    const viewports = appearances.map((appearance) => ({
      name: `${sim.name}-${appearance}`,
      width: metrics.pointWidth,
      height: metrics.pointHeight,
      appearance,
      device: sim.name,
    }));
    process.stderr.write(
      `[shoot-rn] ${sim.name} (${sim.udid}) ${metrics.pointWidth}x${metrics.pointHeight}pt ` +
        `@${metrics.scale}x — appearances: ${appearances.join(", ")}\n`,
    );

    const manifests = [];
    for (const target of run.targets) {
      process.stderr.write(`[shoot-rn] ${target.id} (${target.route})…\n`);
      manifests.push(await shootTarget(ctx, run, target, viewports));
    }

    writeFileSync(
      join(run.outDir, "manifest.json"),
      JSON.stringify(
        {
          baseUrl: run.baseUrl,
          viewports,
          device: { name: sim.name, udid: sim.udid, runtime: sim.runtime, ...metrics },
          generatedTargets: manifests.length,
          targets: manifests,
        },
        null,
        2,
      ),
    );
    const totalErrors = manifests.reduce((n, m) => n + m.errors.length, 0);
    process.stderr.write(
      `[shoot-rn] done — ${manifests.length} target(s), ${totalErrors} error(s). ` +
        `manifest: ${join(run.outDir, "manifest.json")}\n`,
    );
    process.exitCode = totalErrors > 0 ? 1 : 0;
  } finally {
    rmSync(ctx.tmpShot, { force: true });
    restoreSimulatorState(ctx, priorAppearance);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}

export { selectorFrameEvidence, swipeCoordinates };
