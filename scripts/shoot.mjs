#!/usr/bin/env node
/**
 * shoot.mjs — standalone, project-decoupled UI shot driver for autoreview-ui.
 *
 * Drives a Chromium browser (Playwright, the skill's own dependency, reusing
 * the shared browser cache) against ANY already-running project dev server. It
 * NEVER writes into the project repo and imports NO project code — auth, routes,
 * tokens, and viewports all come from a self-contained run.json. This is what
 * makes the skill global: a repo can be reviewed without dropping a spec into
 * its test tree (which a branch's tooling can clean away).
 *
 *   node shoot.mjs --run /abs/run.json      # or UI_SHOOT_RUN=/abs/run.json
 *
 * run.json:
 * {
 *   "root": "/abs/project",          // resolves auth.secretFile
 *   "baseUrl": "http://127.0.0.1:3001",
 *   "outDir": "/abs/out",
 *   "settleMs": 350,
 *   "navigationTimeoutMs": 30000,    // page.goto (to `load`) + dev-login request
 *   "waitForTimeoutMs": 15000,       // each target's `waitFor` visibility wait
 *   "viewports": [{ "name":"mobile","width":375,"height":812 }, ...],
 *   "auth": { "mode":"devLogin", "endpoint":"/api/dev/login",
 *             "header":"x-dev-login-secret", "secretFile":".env.local",
 *             "secretEnv":"DEV_LOGIN_SECRET", "handleField":"handle" },
 *   "targets": [{ "id","route","role","waitFor","fullPage","clip","interactions","axe" }]
 * }
 *
 * Full-page shots: a full-page screenshot captures beyond the viewport without
 * scrolling, so lazy images and scroll-revealed content below the fold would be
 * blank in it. Before each full-page shot the driver scrolls to the bottom one
 * viewport at a time, waits for the network and the images to settle, and
 * returns to the top (see preScrollFullPage). The shot records what it found
 * as `preScroll`.
 *
 * Missing-state detection: hover/focus probes screenshot the same padded region
 * before and after; identical PNG bytes ⇒ the element has no visible state
 * change (a lazy gap — no :hover, no focus ring).
 */

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const require = createRequire(import.meta.url);
const {
  assertSafeTargetId,
  composeWebUrl,
  shotFile: targetShotFile,
  targetManifestFile,
} = require("./capture-contract.cjs");
const { webCaptureTimeouts } = require("./web-capture-timeouts.cjs");
const { shouldRetryTarget, waitForServer } = require("./web-capture-retry.cjs");

const TIMEOUT_HINTS = {
  navigationTimeoutMs: "raise it in the project config if the server compiles this route on first request",
  waitForTimeoutMs: "raise it in the project config if the page is still compiling or loading; otherwise check the waitFor selector",
};

/**
 * Name the config key that bounds a wait when Playwright gives up on it, so a
 * slow first compile on a dev server points at the fix instead of reading as a
 * broken route. The hint joins the first line: Playwright appends a multi-line
 * call log, and summaries show the start of the message.
 */
async function withTimeoutHint(key, timeoutMs, action) {
  try {
    return await action();
  } catch (err) {
    if (err?.name === "TimeoutError" && typeof err.message === "string") {
      const [first, ...callLog] = err.message.split("\n");
      err.message = [`${first} [capture.${key} is ${timeoutMs} ms; ${TIMEOUT_HINTS[key]}]`, ...callLog].join("\n");
    }
    throw err;
  }
}

const DEFAULT_VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "desktop", width: 1920, height: 1080 },
];

function loadRun() {
  const idx = process.argv.indexOf("--run");
  const path = idx >= 0 ? process.argv[idx + 1] : process.env.UI_SHOOT_RUN;
  if (!path) throw new Error("[shoot] --run <run.json> (or UI_SHOOT_RUN) required");
  return JSON.parse(readFileSync(path, "utf8"));
}

function readSecret(run) {
  const { root = process.cwd(), auth } = run;
  // An absolute secretFile is honoured as-is so the secret can live outside the
  // repo (the skill's no-repo-write contract); a relative one resolves against
  // the project root. Matches shoot-rn.mjs's readSecret.
  const configured = auth.secretFile || ".env.local";
  const file = isAbsolute(configured) ? configured : join(root, configured);
  const env = auth.secretEnv || "DEV_LOGIN_SECRET";
  const key = env.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = readFileSync(file, "utf8").match(
    new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^#\\n]*))`, "m"),
  );
  if (!m) throw new Error(`[shoot] ${env} not found in ${file}`);
  return m[1] ?? m[2] ?? m[3].trim();
}

async function settle(page, settleMs) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(settleMs);
}

async function freezeMotion(page) {
  await page
    .addStyleTag({
      content:
        "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important;scroll-behavior:auto!important;}",
    })
    .catch(() => {});
}

/**
 * Bounds for the pre-scroll of a full-page shot. The waits count polls, not
 * wall-clock time, so a bound is the same number of steps on any machine.
 */
const PRE_SCROLL = Object.freeze({
  // Viewports scrolled per shot. Bounds a feed that grows on every scroll.
  maxSteps: 100,
  // Pause after each step, so lazy loaders and observers react to it.
  stepDelayMs: 100,
  pollMs: 100,
  // The network is quiet after this many polls in a row with no request in
  // flight and none started or ended (500 ms).
  quietPolls: 5,
  // Poll budget of one pre-scroll for its network waits, and the same again
  // for its image waits (15 s each), however often the page is settled.
  maxPolls: 150,
  // Deadline for one script evaluation in the page. `page.evaluate` has no
  // timeout of its own, so a stalled renderer would hold the capture for ever.
  evaluateTimeoutMs: 10_000,
  // How many unloaded image sources a shot lists by name.
  maxListedImages: 12,
});

/** Run a function in the page, and give up with an error when it does not return in time. */
function evaluateWithDeadline(page, pageFunction, what) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not return within ${PRE_SCROLL.evaluateTimeoutMs} ms`)),
      PRE_SCROLL.evaluateTimeoutMs,
    );
  });
  return Promise.race([page.evaluate(pageFunction), deadline]).finally(() => clearTimeout(timer));
}

// Requests that stay open by design. They never make the network "quiet",
// and a still image needs neither an event stream nor media bytes.
const LONG_LIVED_RESOURCE_TYPES = new Set(["eventsource", "websocket", "media"]);

/**
 * Count the page's requests in flight. `waitForLoadState("networkidle")`
 * cannot do this: it resolves at once when the page was idle once already, so
 * it never sees the requests that a scroll starts.
 *
 * Attach it when the page is created. A request that starts before a
 * pre-scroll (on load, or after a viewport resize) and is still in flight
 * when the pre-scroll begins is then counted too.
 */
function watchNetwork(page) {
  const inFlight = new Set();
  let activity = 0;
  const started = (request) => {
    if (LONG_LIVED_RESOURCE_TYPES.has(request.resourceType())) return;
    inFlight.add(request);
    activity += 1;
  };
  const ended = (request) => {
    if (!inFlight.delete(request)) return;
    activity += 1;
  };
  page.on("request", started);
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);
  return {
    state: () => ({ inFlight: inFlight.size, activity }),
    stop() {
      page.off("request", started);
      page.off("requestfinished", ended);
      page.off("requestfailed", ended);
    },
  };
}

/**
 * Resolve true once the network was quiet for `quietPolls` polls in a row,
 * false when the poll budget of this pre-scroll is used up.
 */
async function waitForQuietNetwork(page, network, budget) {
  let quiet = 0;
  let seen = network.state().activity;
  while (budget.networkPolls > 0) {
    budget.networkPolls -= 1;
    await page.waitForTimeout(PRE_SCROLL.pollMs);
    const { inFlight, activity } = network.state();
    quiet = inFlight === 0 && activity === seen ? quiet + 1 : 0;
    seen = activity;
    if (quiet >= PRE_SCROLL.quietPolls) return true;
  }
  return false;
}

/**
 * Scroll the document down by one viewport, without animation. Returns the
 * scroll position before and after, so the caller sees when the bottom is
 * reached (the position stops moving).
 */
function scrollDownOneViewport(page) {
  return evaluateWithDeadline(page, () => {
    const before = window.scrollY;
    window.scrollTo({ top: before + window.innerHeight, left: window.scrollX, behavior: "instant" });
    return { before, after: window.scrollY };
  }, "the scroll step");
}

function scrollToTop(page) {
  return evaluateWithDeadline(page, () => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, "the scroll to the top");
}

/**
 * Sort the images a full-page shot can show into loaded, still loading and
 * not loaded. "Loaded" is `complete && naturalWidth > 0`.
 *
 * An image counts only when it has a source, has a layout box, and that box
 * lies inside the area a full-page shot covers (the document's scroll size).
 * The browser never starts a lazy image inside a `display: none` subtree, or
 * one far off to the side inside a carousel's own scroll box, and the shot
 * shows neither; waiting for them would only run into the bound.
 */
function imageLoadState(page) {
  return evaluateWithDeadline(page, () => {
    const root = document.documentElement;
    const body = document.body;
    // The same box a full-page screenshot covers.
    const pageWidth = Math.max(
      root.scrollWidth || 0, root.offsetWidth || 0, root.clientWidth || 0,
      body?.scrollWidth || 0, body?.offsetWidth || 0, window.innerWidth || 0,
    );
    const pageHeight = Math.max(
      root.scrollHeight || 0, root.offsetHeight || 0, root.clientHeight || 0,
      body?.scrollHeight || 0, body?.offsetHeight || 0, window.innerHeight || 0,
    );
    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;
    const state = { total: 0, loading: [], notLoaded: [] };
    for (const img of document.querySelectorAll("img")) {
      const hasSource = img.hasAttribute("src") || img.hasAttribute("srcset") || img.parentElement?.tagName === "PICTURE";
      if (!hasSource) continue;
      const rect = img.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) continue;
      const left = rect.left + scrollX;
      const top = rect.top + scrollY;
      if (left + rect.width <= 0 || left >= pageWidth || top + rect.height <= 0 || top >= pageHeight) continue;
      state.total += 1;
      if (img.complete && img.naturalWidth > 0) continue;
      const name = img.currentSrc || img.getAttribute("src") || img.getAttribute("srcset") || "(picture source)";
      // `complete` with no pixels is a finished request that gave no image: a
      // broken file. It will not change, so it is not worth waiting for.
      (img.complete ? state.notLoaded : state.loading).push(name);
    }
    return state;
  }, "the image check");
}

/**
 * Poll until no counted image is still loading, or until the poll budget of
 * this pre-scroll is used up. Returns the last state.
 */
async function waitForImages(page, budget) {
  let state = await imageLoadState(page);
  while (state?.loading?.length && budget.imagePolls > 0) {
    budget.imagePolls -= 1;
    await page.waitForTimeout(PRE_SCROLL.pollMs);
    state = await imageLoadState(page);
  }
  return state;
}

/**
 * Bring a page into the state a reader reaches by scrolling through it, then
 * return to the top, so a full-page shot shows the content below the fold.
 *
 *   1. Start at the top. An earlier viewport or a scroll probe can have left
 *      the page anywhere.
 *   2. Scroll down one viewport at a time until the position stops moving.
 *      The position is read after every step, so content that a scroll adds
 *      (a lazy grid, a deferred section) is scrolled through as well.
 *   3. Wait until the network is quiet, then until every image the shot can
 *      show is loaded.
 *   4. Try one more step. A request that finished during step 3 can have made
 *      the page longer; if the position moves, go on from step 2.
 *   5. Scroll back to the top and let the top state settle.
 *
 * Every wait, step count and script evaluation is bounded. A failure here
 * never costs the shot: the screenshot is still taken, and the returned facts
 * say what was not reached.
 */
async function preScrollFullPage(page, network, settleMs) {
  const facts = { steps: 0, bottomReached: false, networkIdle: false, images: 0, imagesNotLoaded: [] };
  const budget = { networkPolls: PRE_SCROLL.maxPolls, imagePolls: PRE_SCROLL.maxPolls };
  try {
    const settleContent = async () => {
      facts.networkIdle = await waitForQuietNetwork(page, network, budget);
      const images = await waitForImages(page, budget);
      const unloaded = [...(images?.loading ?? []), ...(images?.notLoaded ?? [])];
      facts.images = images?.total ?? 0;
      facts.imagesNotLoaded = unloaded.slice(0, PRE_SCROLL.maxListedImages);
      delete facts.imagesNotLoadedOmitted;
      if (unloaded.length > PRE_SCROLL.maxListedImages) {
        facts.imagesNotLoadedOmitted = unloaded.length - PRE_SCROLL.maxListedImages;
      }
    };
    await scrollToTop(page);
    // The top viewport gets the same pause as every later one. Without it a
    // page that was left scrolled down would pass its top content before any
    // observer there has run.
    await page.waitForTimeout(PRE_SCROLL.stepDelayMs);
    // True while nothing has moved since the content last settled.
    let settled = false;
    while (facts.steps < PRE_SCROLL.maxSteps) {
      const position = await scrollDownOneViewport(page);
      if (position?.after > position?.before) {
        facts.steps += 1;
        settled = false;
        await page.waitForTimeout(PRE_SCROLL.stepDelayMs);
        continue;
      }
      if (settled) {
        facts.bottomReached = true;
        break;
      }
      await settleContent();
      settled = true;
    }
    if (!settled) await settleContent();
  } catch (err) {
    facts.error = err.message;
  } finally {
    await scrollToTop(page).catch(() => {});
    await page.waitForTimeout(settleMs).catch(() => {});
  }
  return facts;
}

async function regionClip(page, selector, padding = 14) {
  const el = page.locator(selector).first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const box = await el.boundingBox();
  if (!box) return null;
  const vp = page.viewportSize() ?? {
    width: box.x + box.width,
    height: box.y + box.height,
  };
  const x = Math.max(0, box.x - padding);
  const y = Math.max(0, box.y - padding);
  return {
    x,
    y,
    width: Math.min(vp.width - x, box.width + padding * 2),
    height: Math.min(vp.height - y, box.height + padding * 2),
  };
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

async function selectorFrameEvidence(page, selectors, { fullPage = false, clip = null } = {}) {
  if (!selectors.length) return { frames: {}, outsideClip: [] };
  return page.evaluate(({ selectors: requested, fullPage: isFullPage, clip: clipRect }) => {
    const width = isFullPage
      ? Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0, window.innerWidth)
      : window.innerWidth;
    const height = isFullPage
      ? Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, window.innerHeight)
      : window.innerHeight;
    const frames = {};
    const outsideClip = [];
    for (const selector of requested) {
      let element;
      try { element = document.querySelector(selector); } catch { continue; }
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (!width || !height || rect.width <= 0 || rect.height <= 0) continue;
      if (clipRect) {
        const right = rect.x + rect.width;
        const bottom = rect.y + rect.height;
        const clipRight = clipRect.x + clipRect.width;
        const clipBottom = clipRect.y + clipRect.height;
        if (right <= clipRect.x || rect.x >= clipRight || bottom <= clipRect.y || rect.y >= clipBottom) {
          outsideClip.push(selector);
          continue;
        }
        // A partial overlap is a valid crop of the captured evidence. Clamp it
        // to the actual PNG so its normalized coordinates stay clip-local.
        const x = Math.max(rect.x, clipRect.x);
        const y = Math.max(rect.y, clipRect.y);
        const clippedRight = Math.min(right, clipRight);
        const clippedBottom = Math.min(bottom, clipBottom);
        frames[selector] = {
          x: (x - clipRect.x) / clipRect.width,
          y: (y - clipRect.y) / clipRect.height,
          w: (clippedRight - x) / clipRect.width,
          h: (clippedBottom - y) / clipRect.height,
          normalized: true,
        };
        continue;
      }
      const x = rect.x + (isFullPage ? window.scrollX : 0);
      const y = rect.y + (isFullPage ? window.scrollY : 0);
      const frame = { x: x / width, y: y / height, w: rect.width / width, h: rect.height / height, normalized: true };
      if (frame.x < 0 || frame.y < 0 || frame.x + frame.w > 1 || frame.y + frame.h > 1) continue;
      frames[selector] = frame;
    }
    return { frames, outsideClip };
  }, { selectors, fullPage, clip });
}

async function selectorFrames(page, selectors, options = {}) {
  return (await selectorFrameEvidence(page, selectors, options)).frames;
}

async function captureWebAxTree(page) {
  let session;
  try {
    session = await page.context().newCDPSession(page);
    return (await session.send("Accessibility.getFullAXTree")).nodes;
  } catch {
    return null;
  } finally {
    await session?.detach().catch(() => {});
  }
}

function axDescriptions(tree) {
  const descriptions = new Set();
  for (const node of tree || []) {
    const role = node.role?.value || "";
    const name = node.name?.value || "";
    if (role || name) descriptions.add(`${role}:${name}`);
  }
  return descriptions;
}

function revealedSummary(preTree, postTree) {
  const before = axDescriptions(preTree);
  const revealed = [...axDescriptions(postTree)].filter((item) => !before.has(item)).sort();
  return { count: revealed.length, elements: revealed.slice(0, 12), omitted: Math.max(0, revealed.length - 12) };
}

function axSignature(tree, metrics) {
  // CDP node ids remain stable while the page is alive; pairing them with the
  // settled scroll metrics keeps an unchanged end state distinguishable from a
  // swipe that merely leaves the same semantic tree in a different position.
  // Content geometry belongs here too: lazy growth after a gesture is progress,
  // not evidence that the scroll container is inert or at its end.
  return JSON.stringify({
    tree: tree || null,
    scrollTop: metrics?.scrollTop ?? null,
    contentHeight: metrics?.contentHeight ?? null,
    viewportHeight: metrics?.viewportHeight ?? null,
  });
}

async function webScrollMetrics(page, options, { reset = false, scroll = false } = {}) {
  return page.evaluate(({ options: cfg, shouldReset, shouldScroll }) => {
    const frame = (rect) => rect ? {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    } : null;
    const elementIsScrollable = (element) => {
      const style = getComputedStyle(element);
      return /(auto|scroll|overlay)/.test(style.overflowY) || element.scrollHeight > element.clientHeight;
    };
    const candidates = [...document.querySelectorAll("*")]
      .filter((element) => elementIsScrollable(element))
      .map((element) => ({ element, area: element.clientWidth * element.clientHeight }))
      .filter((candidate) => candidate.area > 0)
      .sort((left, right) => right.area - left.area);
    let element = null;
    if (cfg.containerSelector) {
      try { element = document.querySelector(cfg.containerSelector); } catch { element = null; }
    } else {
      element = candidates[0]?.element || null;
    }
    if (!element) {
      if (shouldReset) window.scrollTo(0, 0);
      return {
        found: false,
        containerSelector: cfg.containerSelector || "largest-scrollable",
        frames: { container: null, content: null, viewport: null, footer: null },
      };
    }
    if (shouldReset) {
      // Resolve the candidate in this same evaluation as probing so an
      // automatically selected container is reset too. A page-level reset on
      // its own leaves nested scroll roots at their previous position.
      element.scrollTop = 0;
      window.scrollTo(0, 0);
    }
    if (shouldScroll) {
      const distance = Math.max(1, element.clientHeight * cfg.swipePercent);
      element.scrollTop = Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + distance);
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
    const rect = element.getBoundingClientRect();
    let footer = null;
    if (cfg.footerSelector) {
      try { footer = element.querySelector(cfg.footerSelector) || document.querySelector(cfg.footerSelector); } catch { footer = null; }
    } else {
      footer = element.querySelector("footer,[role=contentinfo]");
    }
    const footerRect = footer?.getBoundingClientRect() || null;
    return {
      found: true,
      containerSelector: cfg.containerSelector || "largest-scrollable",
      scrollable: elementIsScrollable(element),
      scrollTop: element.scrollTop,
      contentHeight: element.scrollHeight,
      viewportHeight: element.clientHeight,
      frames: {
        container: frame(rect),
        content: { x: rect.x, y: rect.y, width: element.scrollWidth, height: element.scrollHeight },
        viewport: { x: rect.x, y: rect.y, width: element.clientWidth, height: element.clientHeight },
        footer: frame(footerRect),
      },
    };
  }, { options, shouldReset: reset, shouldScroll: scroll });
}

async function resetWebScroll(page, options) {
  await webScrollMetrics(page, options, { reset: true }).catch(() => {});
}

function webScrollAtBottom(metrics) {
  return Boolean(
    metrics?.found &&
    Number.isFinite(metrics.scrollTop) &&
    Number.isFinite(metrics.contentHeight) &&
    Number.isFinite(metrics.viewportHeight) &&
    metrics.scrollTop >= Math.max(0, metrics.contentHeight - metrics.viewportHeight),
  );
}

function scrollFacts(metrics, options, preAxTree, postAxTree, bottomReached) {
  const geometry = metrics?.found &&
    Number.isFinite(metrics.contentHeight) && Number.isFinite(metrics.viewportHeight);
  const scrollExtentPt = geometry ? Math.max(0, metrics.contentHeight - metrics.viewportHeight) : null;
  const viewportPt = geometry ? metrics.viewportHeight : null;
  const sliverScroll = geometry && metrics.scrollable
    ? scrollExtentPt < viewportPt * options.sliverExtentViewportRatio
    : null;
  return {
    scrollable: metrics?.found ? Boolean(metrics.scrollable) : null,
    scrollExtentPt,
    viewportPt,
    bottomReached: geometry ? bottomReached : null,
    revealed: geometry ? revealedSummary(preAxTree, postAxTree) : null,
    containerSelector: metrics?.containerSelector ?? options.containerSelector ?? "largest-scrollable",
    frames: metrics?.frames ?? { container: null, content: null, viewport: null, footer: null },
    sliverScroll,
    layoutEconomy: geometry
      ? sliverScroll
        ? { verdict: "flagged", flags: ["sliver-scroll"] }
        : { verdict: "not-flagged", flags: [] }
      : { verdict: "not-judged", reason: "scroll geometry unavailable" },
    preAxTree,
    postAxTree,
  };
}

async function captureScrollProbe(page, run, target, manifest, vp, fullPage) {
  const options = scrollProbeOptions(run, target);
  const selectors = selectorRequestsForTarget(run, target.id);
  await resetWebScroll(page, options);
  const preMetrics = await webScrollMetrics(page, options);
  const preAxTree = await captureWebAxTree(page);
  const topPath = targetShotFile(run.outDir, target.id, [vp.name, "scroll-top"]);
  await page.screenshot({ path: topPath, fullPage: false });
  manifest.shots.push({
    viewport: vp.name,
    path: topPath,
    kind: "scroll-top",
    selectorFrames: await selectorFrames(page, selectors, { fullPage: false }),
  });

  let metrics = preMetrics;
  let tree = preAxTree;
  let previous = axSignature(tree, metrics);
  let bottomReached = false;
  if (preMetrics.found && Number.isFinite(preMetrics.contentHeight) && Number.isFinite(preMetrics.viewportHeight)) {
    for (let attempt = 0; attempt < options.maxSwipes; attempt++) {
      await webScrollMetrics(page, options, { scroll: true });
      await page.waitForTimeout(options.settleMs);
      // Lazy content can change scrollHeight while the scroll event settles.
      // Read the same selected container again before deciding whether the
      // latest gesture reached its end or left the AX state unchanged.
      metrics = await webScrollMetrics(page, options);
      tree = await captureWebAxTree(page);
      const signature = axSignature(tree, metrics);
      // A final permitted swipe can land exactly at max scrollTop, without a
      // following no-op swipe to make the AX signature stable.
      if (webScrollAtBottom(metrics)) {
        bottomReached = true;
        break;
      }
      if (signature === previous) {
        bottomReached = true;
        break;
      }
      previous = signature;
    }
  }
  const postMetrics = metrics;
  const postAxTree = tree;
  if (preMetrics.found) {
    const bottomPath = targetShotFile(run.outDir, target.id, [vp.name, "scroll-bottom"]);
    await page.screenshot({ path: bottomPath, fullPage: false });
    manifest.shots.push({
      viewport: vp.name,
      path: bottomPath,
      kind: "scroll-bottom",
      selectorFrames: await selectorFrames(page, selectors, { fullPage: false }),
    });
  }
  return scrollFacts(postMetrics, options, preAxTree, postAxTree, bottomReached);
}

async function applyAction(page, el, interaction) {
  switch (interaction.action) {
    case "hover":
      await el.hover();
      return null;
    case "focus":
      await focusByKeyboard(page, el, interaction.selector);
      return null;
    case "active":
      await el.hover();
      await page.mouse.down();
      return async () => {
        await page.mouse.up().catch(() => {});
      };
    case "fill":
      await el.fill(interaction.value ?? "Test input");
      return null;
    case "click":
      await el.click();
      return null;
  }
  return null;
}

async function focusByKeyboard(page, el, selector) {
  const sentinelId = `autoreview-focus-sentinel-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const inserted = await el.evaluate(
    (node, id) => {
      if (!node.parentNode) return false;
      const sentinel = document.createElement("button");
      sentinel.type = "button";
      sentinel.id = id;
      sentinel.setAttribute("aria-hidden", "true");
      sentinel.tabIndex = 0;
      sentinel.style.cssText =
        "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;";
      node.parentNode.insertBefore(sentinel, node);
      sentinel.focus();
      return document.activeElement === sentinel;
    },
    sentinelId,
  );
  if (!inserted) throw new Error(`focus sentinel could not be inserted before "${selector}"`);
  let focused = false;
  try {
    await page.keyboard.press("Tab");
    focused = await el.evaluate(
      (node) => node === document.activeElement || node.contains(document.activeElement),
    );
  } finally {
    await page.evaluate((id) => document.getElementById(id)?.remove(), sentinelId).catch(() => {});
  }
  if (!focused) throw new Error(`selector "${selector}" was not reached by keyboard Tab`);
}

async function runInteraction(page, outDir, target, interaction, vpName, settleMs, selectors = []) {
  const record = {
    id: interaction.id,
    viewport: vpName,
    action: interaction.action,
    selector: interaction.selector,
    statePath: null,
    changed: true,
  };
  const el = page.locator(interaction.selector).first();
  if ((await el.count()) === 0) {
    record.note = "selector not found";
    record.changed = false;
    return record;
  }
  const mode =
    interaction.screenshot ?? (interaction.action === "click" ? "page" : "region");
  const statePath = targetShotFile(outDir, target.id, [vpName, interaction.id]);

  if (mode === "region") {
    const clip = await regionClip(page, interaction.selector);
    if (!clip) {
      record.note = "no bounding box";
      record.changed = false;
      return record;
    }
    let cleanup = null;
    try {
      const before = await page.screenshot({ clip });
      cleanup = await applyAction(page, el, interaction);
      await page.waitForTimeout(settleMs);
      const after = await page.screenshot({ clip, path: statePath });
      record.statePath = statePath;
      record.changed = !before.equals(after);
    } finally {
      if (cleanup) await cleanup();
    }
  } else {
    let cleanup = null;
    try {
      // Page mode is the click default because navigation and sheets usually
      // change more than the control itself. It still needs the same
      // before/after assertion as a clipped interaction: otherwise a dead
      // click retains the initial `changed: true` and is falsely captured.
      // Playwright clicks auto-scroll an off-screen locator. Establish the
      // same viewport for both sides of the diff before taking the baseline,
      // otherwise that automatic scroll alone looks like a working action.
      if (typeof el.scrollIntoViewIfNeeded === "function") {
        await el.scrollIntoViewIfNeeded().catch(() => {});
      }
      const before = await page.screenshot({ fullPage: false });
      cleanup = await applyAction(page, el, interaction);
      await page.waitForTimeout(settleMs);
      const after = await page.screenshot({ path: statePath, fullPage: false });
      record.statePath = statePath;
      record.changed = !before.equals(after);
      record.selectorFrames = await selectorFrames(page, selectors, { fullPage: false });
    } finally {
      if (cleanup) await cleanup();
    }
  }
  await page.mouse.move(0, 0).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  return record;
}

async function authenticate(context, run, role) {
  const { auth, baseUrl } = run;
  if (!auth || auth.mode === "none") return;
  if (auth.mode !== "devLogin") {
    throw new Error(`[shoot] unsupported auth mode "${auth.mode}"`);
  }
  const secret = readSecret(run);
  // The dev-login route compiles on first request like any page does, so it
  // shares the navigation budget.
  const { navigationTimeoutMs } = webCaptureTimeouts(run);
  const res = await withTimeoutHint("navigationTimeoutMs", navigationTimeoutMs, () =>
    context.request.post(`${baseUrl}${auth.endpoint}`, {
      headers: { [auth.header || "x-dev-login-secret"]: secret },
      data: { [auth.handleField || "handle"]: role },
      timeout: navigationTimeoutMs,
    }),
  );
  if (res.status() !== 204) {
    throw new Error(
      `[shoot] dev login for "${role}" → ${res.status()} (is the server up and fixtures seeded?)`,
    );
  }
}

async function shootTarget(browser, run, target) {
  const { baseUrl, outDir, settleMs = 350 } = run;
  assertSafeTargetId(target.id);
  const { navigationTimeoutMs, waitForTimeoutMs } = webCaptureTimeouts(run);
  const viewports = run.viewports?.length ? run.viewports : DEFAULT_VIEWPORTS;
  const interactionViewport = viewports.reduce((a, b) => (b.width > a.width ? b : a));
  const manifest = {
    id: target.id,
    route: target.route,
    role: target.role ?? null,
    shots: [],
    interactions: [],
    axe: null,
    errors: [],
  };
  const context = await browser.newContext();
  let network = null;
  try {
    if (target.role) await authenticate(context, run, target.role);
    const page = await context.newPage();
    // From the page's first request on; the pre-scroll of a full-page shot reads it.
    network = watchNetwork(page);
    // Absolute URLs pass through; target.params fills only query keys the route
    // did not already declare.
    const url = composeWebUrl(baseUrl, target.route, target.params);

    await page.setViewportSize({ width: viewports[0].width, height: viewports[0].height });
    await withTimeoutHint("navigationTimeoutMs", navigationTimeoutMs, () =>
      page.goto(url, { waitUntil: "load", timeout: navigationTimeoutMs }),
    );
    if (target.waitFor) {
      await withTimeoutHint("waitForTimeoutMs", waitForTimeoutMs, () =>
        page.locator(target.waitFor).first().waitFor({ state: "visible", timeout: waitForTimeoutMs }),
      );
    }
    await freezeMotion(page);
    await settle(page, settleMs);

    const fullPage = target.fullPage ?? true;
    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await settle(page, settleMs);
      // Per viewport: a new width changes the page height and the srcset
      // candidate of each image.
      const preScroll = !target.clip && fullPage ? await preScrollFullPage(page, network, settleMs) : null;
      // The prior viewport's probe may have ended at the bottom. Reset before
      // its successor's base shot, not merely before the probe itself.
      if (wantsScrollProbe(target)) await resetWebScroll(page, scrollProbeOptions(run, target));
      if (target.clip) {
        const clip = await regionClip(page, target.clip, 0);
        const path = targetShotFile(outDir, target.id, [vp.name, "clip"]);
        if (clip) {
          await page.screenshot({ clip, path });
          const selectorEvidence = await selectorFrameEvidence(
            page,
            selectorRequestsForTarget(run, target.id),
            { clip },
          );
          manifest.shots.push({
            viewport: vp.name,
            path,
            kind: "clip",
            selectorFrames: selectorEvidence.frames,
            ...(selectorEvidence.outsideClip.length
              ? { selectorOutsideClip: selectorEvidence.outsideClip }
              : {}),
          });
        } else {
          manifest.errors.push(`clip "${target.clip}" not found at ${vp.name}`);
        }
      } else {
        const path = targetShotFile(outDir, target.id, [vp.name, fullPage ? "full" : "view"]);
        await page.screenshot({ path, fullPage });
        manifest.shots.push({
          viewport: vp.name,
          path,
          kind: "full",
          selectorFrames: await selectorFrames(page, selectorRequestsForTarget(run, target.id), { fullPage }),
          ...(preScroll ? { preScroll } : {}),
        });
      }
      if (wantsScrollProbe(target)) {
        const facts = await captureScrollProbe(page, run, target, manifest, vp, fullPage);
        if (!manifest.scroll) manifest.scroll = facts;
        (manifest.scrollProbes ??= []).push({ viewport: vp.name, ...facts });
      }
    }

    if (wantsScrollProbe(target)) await resetWebScroll(page, scrollProbeOptions(run, target));

    await page.setViewportSize({
      width: interactionViewport.width,
      height: interactionViewport.height,
    });
    await settle(page, settleMs);
    for (const interaction of target.interactions ?? []) {
      try {
        manifest.interactions.push(
          await runInteraction(page, outDir, target, interaction, interactionViewport.name, settleMs, selectorRequestsForTarget(run, target.id)),
        );
      } catch (err) {
        manifest.errors.push(`interaction "${interaction.id}": ${err.message}`);
      }
    }

    if (target.axe ?? true) {
      try {
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        manifest.axe = {
          violations: results.violations.map((v) => ({
            id: v.id,
            impact: v.impact ?? null,
            help: v.help,
            helpUrl: v.helpUrl,
            nodes: v.nodes.map((n) => ({
              target: n.target.map(String),
              failureSummary: n.failureSummary,
            })),
          })),
        };
      } catch (err) {
        manifest.errors.push(`axe: ${err.message}`);
      }
    }
  } catch (err) {
    manifest.errors.push(err.message);
  } finally {
    network?.stop();
    await context.close();
    const fragPath = targetManifestFile(outDir, target.id);
    writeFileSync(fragPath, JSON.stringify(manifest, null, 2));
  }
  return manifest;
}

async function main() {
  const run = loadRun();
  for (const target of run.targets || []) assertSafeTargetId(target.id);
  // Reject an invalid timeout once, before a browser starts, rather than
  // failing every target with the same contract error.
  webCaptureTimeouts(run);
  mkdirSync(run.outDir, { recursive: true });
  const viewports = run.viewports?.length ? run.viewports : DEFAULT_VIEWPORTS;
  const executablePath = process.env.AUTOREVIEW_UI_BROWSER_EXECUTABLE?.trim();
  const browser = await chromium.launch(
    executablePath ? { executablePath } : undefined,
  );
  const { navigationTimeoutMs } = webCaptureTimeouts(run);
  const manifests = [];
  let serverAnswered = false;
  try {
    for (const target of run.targets) {
      process.stderr.write(`[shoot] ${target.id} (${target.route})…\n`);
      let manifest = await shootTarget(browser, run, target);
      if (shouldRetryTarget(manifest, serverAnswered)) {
        process.stderr.write(
          `[shoot] ${target.id}: transient server fault; waiting up to ${navigationTimeoutMs} ms for ${run.baseUrl}, then retrying once\n`,
        );
        if (await waitForServer(run.baseUrl, navigationTimeoutMs)) {
          manifest = await shootTarget(browser, run, target);
        } else {
          process.stderr.write(`[shoot] ${target.id}: ${run.baseUrl} did not answer again; keeping the failure\n`);
        }
      }
      if (manifest.shots.length > 0) serverAnswered = true;
      manifests.push(manifest);
    }
  } finally {
    await browser.close();
  }
  writeFileSync(
    join(run.outDir, "manifest.json"),
    JSON.stringify(
      { baseUrl: run.baseUrl, viewports, generatedTargets: manifests.length, targets: manifests },
      null,
      2,
    ),
  );
  const totalErrors = manifests.reduce((n, m) => n + m.errors.length, 0);
  process.stderr.write(
    `[shoot] done — ${manifests.length} target(s), ${totalErrors} error(s). manifest: ${join(run.outDir, "manifest.json")}\n`,
  );
  process.exitCode = totalErrors > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { runInteraction, selectorFrameEvidence, shootTarget, webScrollAtBottom };
