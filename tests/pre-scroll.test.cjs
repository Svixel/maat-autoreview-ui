"use strict";

// Full-page shots pre-scroll the page first. A full-page screenshot captures
// beyond the viewport without scrolling, so a lazy image below the fold is
// blank in it unless the driver has scrolled through the page before.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const vm = require("node:vm");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { decodePng, encodePng } = require("../scripts/png.cjs");

// --- a model of a scrolling page with lazy images ----------------------------

/**
 * A fake Playwright page over a small model of the browser: a document of a
 * given height, a viewport, and images that start to load when a scroll brings
 * them near the viewport. One `waitForTimeout` call is one tick of page time.
 *
 * Image options: `top` and `left` (document position), `lazy` (default true),
 * `loadTicks` (ticks from the start of the request to its end), `broken` (the
 * request ends with no image), `hidden` (no layout box, so the browser never
 * starts it).
 *
 * Page options: `pageWidth` (document scroll width, default the viewport
 * width), `startScrollY` (where an earlier step left the page), `onLoad` and
 * `onScroll` (hooks that can grow the document, add images or start a request),
 * `scrollThrows` (a script that scrolls throws), `scrollHangs` (a script that
 * scrolls never returns: a stalled renderer), `lazyOnTick` (lazy loading reacts
 * on the next tick after a scroll, like an IntersectionObserver, not inside
 * the scroll call).
 */
function fakeScrollingPage({
  pageHeight,
  pageWidth = null,
  viewportHeight = 100,
  startScrollY = 0,
  images = [],
  onLoad = () => {},
  onScroll = () => {},
  scrollThrows = false,
  scrollHangs = false,
  lazyOnTick = false,
}) {
  const LAZY_MARGIN = 50;
  const handlers = { request: new Set(), requestfinished: new Set(), requestfailed: new Set() };
  const emit = (event, request) => { for (const handler of [...handlers[event]]) handler(request); };
  const doc = { height: pageHeight };
  let evaluationHangs = false;
  const window = {
    innerWidth: 200,
    innerHeight: viewportHeight,
    scrollX: 0,
    scrollY: startScrollY,
    scrollTo({ top }) {
      if (scrollThrows) throw new Error("scrolling is blocked on this page");
      if (scrollHangs) {
        evaluationHangs = true;
        return;
      }
      window.scrollY = Math.max(0, Math.min(top, doc.height - window.innerHeight));
      page.scrollPositions.push(window.scrollY);
      page.maxScrollY = Math.max(page.maxScrollY, window.scrollY);
      onScroll({ doc, window, addImage, startRequest });
      if (!lazyOnTick) startVisibleImages();
    },
  };
  const models = [];
  const timers = [];
  function addImage({ top, left = 0, src, lazy = true, loadTicks = 2, broken = false, hidden = false }) {
    const state = lazy ? "idle" : broken ? "broken" : "loaded";
    const model = { top, left, src, broken, hidden, loadTicks, state, remaining: 0, request: { src, resourceType: () => "image" } };
    models.push(model);
    return model;
  }
  /** A request other than an image (a feed fetch by default): in flight for `ticks`, then `onDone` runs. */
  function startRequest(ticks, onDone = () => {}, type = "fetch") {
    const request = { src: `(${type})`, resourceType: () => type };
    emit("request", request);
    timers.push({ remaining: ticks, run() { emit("requestfinished", request); onDone(); startVisibleImages(); } });
  }
  function startVisibleImages() {
    for (const model of models) {
      if (model.state !== "idle" || model.hidden) continue;
      const near = model.top + 20 > window.scrollY - LAZY_MARGIN
        && model.top < window.scrollY + window.innerHeight + LAZY_MARGIN;
      if (!near) continue;
      model.state = "loading";
      model.remaining = model.loadTicks;
      emit("request", model.request);
    }
  }
  function tick() {
    if (lazyOnTick) startVisibleImages();
    for (const timer of [...timers]) {
      timer.remaining -= 1;
      if (timer.remaining > 0) continue;
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }
    for (const model of models) {
      if (model.state !== "loading") continue;
      model.remaining -= 1;
      if (model.remaining > 0) continue;
      model.state = model.broken ? "broken" : "loaded";
      emit(model.broken ? "requestfailed" : "requestfinished", model.request);
    }
  }
  const element = (model) => ({
    get complete() { return model.state === "loaded" || model.state === "broken"; },
    get naturalWidth() { return model.state === "loaded" ? 50 : 0; },
    currentSrc: model.src,
    parentElement: null,
    hasAttribute: (name) => name === "src",
    getAttribute: (name) => (name === "src" ? model.src : null),
    getBoundingClientRect: () => (model.hidden
      ? { left: 0, top: 0, width: 0, height: 0 }
      : { left: model.left - window.scrollX, top: model.top - window.scrollY, width: 50, height: 20 }),
  });
  const document = {
    fonts: { ready: Promise.resolve() },
    get documentElement() { return { clientWidth: window.innerWidth, scrollWidth: pageWidth ?? window.innerWidth, scrollHeight: doc.height }; },
    get body() { return { scrollWidth: pageWidth ?? window.innerWidth, scrollHeight: doc.height }; },
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === "img" ? models.map(element) : []),
  };
  for (const image of images) addImage(image);
  startVisibleImages();

  const page = {
    ticks: 0,
    maxScrollY: 0,
    scrollPositions: [],
    screenshots: [],
    models,
    context: () => ({ newCDPSession: async () => { throw new Error("no CDP in fake page"); } }),
    addStyleTag: async () => {},
    goto: async () => { onLoad({ doc, window, addImage, startRequest }); },
    on: (event, handler) => handlers[event]?.add(handler),
    off: (event, handler) => handlers[event]?.delete(handler),
    listeners: () => Object.values(handlers).reduce((count, set) => count + set.size, 0),
    locator: () => ({
      first: () => ({
        scrollIntoViewIfNeeded: async () => {},
        boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 50 }),
      }),
    }),
    viewportSize: () => ({ width: window.innerWidth, height: window.innerHeight }),
    setViewportSize: async ({ width, height }) => { window.innerWidth = width; window.innerHeight = height; },
    waitForLoadState: async () => {},
    waitForTimeout: async () => { page.ticks += 1; tick(); },
    // Like Playwright, hand the result back as plain serialized data.
    evaluate: async (fn, input) => {
      evaluationHangs = false;
      const result = await vm.runInNewContext(`(${fn.toString()})(input)`, { document, window, input, Math });
      if (evaluationHangs) return new Promise(() => {});
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    },
    screenshot: async ({ path } = {}) => {
      page.screenshots.push({
        path,
        scrollY: window.scrollY,
        images: Object.fromEntries(models.map((model) => [model.src, model.state])),
      });
      return Buffer.from("shot");
    },
  };
  return page;
}

function browserFor(page) {
  return { newContext: async () => ({ newPage: async () => page, close: async () => {} }) };
}

function run(viewports = [{ name: "mobile", width: 200, height: 100 }]) {
  return {
    baseUrl: "http://fixture.test",
    outDir: mkdtempSync(join(tmpdir(), "autoreview-ui-pre-scroll-")),
    settleMs: 0,
    viewports,
  };
}

const FULL_PAGE = { id: "page", route: "/page", axe: false };

async function shoot(page, target = FULL_PAGE, viewports) {
  const { shootTarget } = await import("../scripts/shoot.mjs");
  return shootTarget(browserFor(page), run(viewports), target);
}

const fullShots = (page) => page.screenshots.filter((shot) => shot.path?.endsWith(".full.png"));

// --- the pre-scroll contract -------------------------------------------------

test("a full-page shot is taken from the top, after every lazy image below the fold has loaded", async () => {
  const page = fakeScrollingPage({
    pageHeight: 1000,
    images: [
      { top: 10, src: "/above-fold.png", lazy: false },
      { top: 450, src: "/middle.png" },
      { top: 960, src: "/bottom.png", loadTicks: 12 },
    ],
  });
  const manifest = await shoot(page);

  assert.deepEqual(manifest.errors, []);
  assert.deepEqual(fullShots(page).map((shot) => shot.scrollY), [0], "the shot starts at the top of the page");
  assert.deepEqual(fullShots(page)[0].images, {
    "/above-fold.png": "loaded",
    "/middle.png": "loaded",
    "/bottom.png": "loaded",
  });
  assert.equal(page.maxScrollY, 900, "the page was scrolled to its bottom");
  assert.deepEqual(manifest.shots[0].preScroll, {
    steps: 9,
    bottomReached: true,
    networkIdle: true,
    images: 3,
    imagesNotLoaded: [],
  });
  assert.equal(page.listeners(), 0, "the network listeners are removed again");
});

test("each viewport gets its own pre-scroll, and each shot starts at the top", async () => {
  const page = fakeScrollingPage({ pageHeight: 600, images: [{ top: 560, src: "/bottom.png" }] });
  const manifest = await shoot(page, FULL_PAGE, [
    { name: "mobile", width: 200, height: 100 },
    { name: "desktop", width: 400, height: 200 },
  ]);

  assert.deepEqual(fullShots(page).map((shot) => shot.scrollY), [0, 0]);
  assert.deepEqual(manifest.shots.map((shot) => [shot.viewport, shot.preScroll.steps]), [["mobile", 5], ["desktop", 2]]);
});

test("content that a scroll adds to the page is scrolled through as well", async () => {
  let grown = false;
  const page = fakeScrollingPage({
    pageHeight: 300,
    onScroll({ doc, window, addImage }) {
      if (grown || window.scrollY < 200) return;
      grown = true;
      doc.height = 700;
      addImage({ top: 660, src: "/deferred.png" });
    },
  });
  const manifest = await shoot(page);

  assert.equal(page.maxScrollY, 600, "the scroll continued to the new bottom");
  assert.equal(fullShots(page)[0].images["/deferred.png"], "loaded");
  assert.equal(manifest.shots[0].preScroll.bottomReached, true);
});

test("content that a request brings in after the bottom was reached is scrolled through as well", async () => {
  let fetched = false;
  const page = fakeScrollingPage({
    pageHeight: 300,
    onScroll({ doc, window, addImage, startRequest }) {
      if (fetched || window.scrollY < 200) return;
      fetched = true;
      // A feed request that outlasts the pause between two scroll steps.
      startRequest(8, () => {
        doc.height = 700;
        addImage({ top: 660, src: "/fetched-later.png" });
      });
    },
  });
  const manifest = await shoot(page);
  const { preScroll } = manifest.shots[0];

  assert.equal(page.maxScrollY, 600, "the scroll went on to the new bottom");
  assert.equal(fullShots(page)[0].images["/fetched-later.png"], "loaded");
  assert.deepEqual(preScroll, { steps: 6, bottomReached: true, networkIdle: true, images: 1, imagesNotLoaded: [] });
  assert.deepEqual(fullShots(page).map((shot) => shot.scrollY), [0]);
});

test("a request that is already in flight when the pre-scroll starts is waited for", async () => {
  // A page that fits the viewport until a fetch started on load brings in more.
  const page = fakeScrollingPage({
    pageHeight: 100,
    onLoad({ doc, addImage, startRequest }) {
      startRequest(12, () => {
        doc.height = 500;
        addImage({ top: 460, src: "/from-load-fetch.png" });
      });
    },
  });
  const manifest = await shoot(page);
  const { preScroll } = manifest.shots[0];

  assert.equal(fullShots(page)[0].images["/from-load-fetch.png"], "loaded");
  assert.deepEqual(preScroll, { steps: 4, bottomReached: true, networkIdle: true, images: 1, imagesNotLoaded: [] });
});

test("an open event stream does not keep the network from counting as quiet", async () => {
  const page = fakeScrollingPage({
    pageHeight: 300,
    onLoad({ startRequest }) {
      startRequest(Number.POSITIVE_INFINITY, () => {}, "eventsource");
    },
  });
  const manifest = await shoot(page);

  assert.equal(manifest.shots[0].preScroll.networkIdle, true);
  assert.ok(page.ticks < 40, `expected no wait for the bound, got ${page.ticks} ticks`);
});

test("the traversal starts at the top, wherever an earlier step left the page", async () => {
  const page = fakeScrollingPage({
    pageHeight: 1000,
    startScrollY: 900,
    images: [{ top: 300, src: "/middle.png" }],
  });
  const manifest = await shoot(page);

  assert.equal(page.scrollPositions[0], 0, "the first move is to the top");
  assert.equal(fullShots(page)[0].images["/middle.png"], "loaded");
  assert.equal(manifest.shots[0].preScroll.steps, 9);
});

test("lazy content in the top viewport loads when the page was left scrolled down and loaders react after the scroll", async () => {
  const page = fakeScrollingPage({
    pageHeight: 1000,
    startScrollY: 900,
    lazyOnTick: true,
    images: [{ top: 10, src: "/top-of-page.png" }],
  });
  const manifest = await shoot(page);

  assert.equal(fullShots(page)[0].images["/top-of-page.png"], "loaded");
  assert.deepEqual(manifest.shots[0].preScroll.imagesNotLoaded, []);
});

test("an image in the document's horizontal overflow is part of the shot and is counted", async () => {
  const page = fakeScrollingPage({
    pageHeight: 300,
    pageWidth: 600,
    images: [{ top: 10, left: 450, src: "/overflow-broken.png", lazy: false, broken: true }],
  });
  const manifest = await shoot(page);
  const { preScroll } = manifest.shots[0];

  assert.equal(preScroll.images, 1);
  assert.deepEqual(preScroll.imagesNotLoaded, ["/overflow-broken.png"]);
});

test("a viewport shot and a clip shot are not scrolled", async () => {
  for (const target of [{ ...FULL_PAGE, fullPage: false }, { ...FULL_PAGE, clip: "#card" }]) {
    const page = fakeScrollingPage({ pageHeight: 1000, images: [{ top: 960, src: "/bottom.png" }] });
    const manifest = await shoot(page, target);

    assert.deepEqual(manifest.errors, []);
    assert.equal(manifest.shots.length, 1);
    assert.equal(page.maxScrollY, 0, "the page stays where the target put it");
    assert.equal("preScroll" in manifest.shots[0], false);
  }
});

test("a broken image and a lazy image with no layout box are reported or skipped without waiting for the bound", async () => {
  const page = fakeScrollingPage({
    pageHeight: 600,
    images: [
      { top: 450, src: "/broken.png", broken: true },
      { top: 450, src: "/in-hidden-menu.png", hidden: true },
      { top: 500, src: "/ok.png" },
    ],
  });
  const manifest = await shoot(page);
  const { preScroll } = manifest.shots[0];

  assert.equal(preScroll.images, 2, "the image without a layout box is not counted");
  assert.deepEqual(preScroll.imagesNotLoaded, ["/broken.png"]);
  assert.equal(fullShots(page)[0].images["/ok.png"], "loaded");
  assert.ok(page.ticks < 40, `expected no wait for the bound, got ${page.ticks} ticks`);
});

test("an image that never finishes loading ends the waits at their bound and is named on the shot", async () => {
  const page = fakeScrollingPage({
    pageHeight: 300,
    images: [{ top: 260, src: "/hung.png", loadTicks: Number.POSITIVE_INFINITY }],
  });
  const manifest = await shoot(page);
  const { preScroll } = manifest.shots[0];

  assert.deepEqual(manifest.errors, [], "a slow asset is a fact on the shot, not a failed target");
  assert.equal(preScroll.networkIdle, false);
  assert.deepEqual(preScroll.imagesNotLoaded, ["/hung.png"]);
  assert.deepEqual(fullShots(page).map((shot) => shot.scrollY), [0]);
});

test("a page that grows on every scroll stops at the step bound and is still shot from the top", async () => {
  const page = fakeScrollingPage({
    pageHeight: 300,
    onScroll({ doc }) { doc.height += 100; },
  });
  const manifest = await shoot(page);
  const { preScroll } = manifest.shots[0];

  assert.equal(preScroll.steps, 100);
  assert.equal(preScroll.bottomReached, false);
  assert.deepEqual(fullShots(page).map((shot) => shot.scrollY), [0]);
});

test("a pre-scroll failure is recorded on the shot and never costs the screenshot", async () => {
  const page = fakeScrollingPage({ pageHeight: 600, scrollThrows: true });
  const manifest = await shoot(page);

  assert.deepEqual(manifest.errors, []);
  assert.equal(fullShots(page).length, 1);
  assert.match(manifest.shots[0].preScroll.error, /scrolling is blocked/);
  assert.equal(page.listeners(), 0);
});

test("a page script that never returns ends the pre-scroll at its deadline, and the shot is still taken", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = fakeScrollingPage({ pageHeight: 600, scrollHangs: true });
  const pending = shoot(page);
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  // Each turn lets the driver reach its next wait, then moves the clock past one deadline.
  for (let turn = 0; turn < 50 && !settled; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(10_000);
  }
  assert.equal(settled, true, "the capture did not hang");
  const manifest = await pending;

  assert.deepEqual(manifest.errors, []);
  assert.equal(fullShots(page).length, 1);
  assert.match(manifest.shots[0].preScroll.error, /did not return within 10000 ms/);
  assert.equal(page.listeners(), 0);
});

// --- a real browser ----------------------------------------------------------

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const IMAGE_TOP = 6000; // far past any lazy-load distance from an 800 px viewport

function solidPng(width, height, [r, g, b]) {
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) data.set([r, g, b], i * 3);
  return encodePng({ width, height, channels: 3, data });
}

function lazyImageFixtureServer() {
  const html = `<!doctype html><html><head><style>
    html, body { margin: 0; background: #fff; }
    #bar { position: fixed; top: 0; left: 0; width: 100%; height: 20px; background: rgb(0, 0, 255); }
    #spacer { height: ${IMAGE_TOP}px; }
    img { display: block; }
  </style></head><body>
    <div id="bar"></div>
    <div id="spacer"></div>
    <img loading="lazy" src="/red.png" width="200" height="100" alt="">
  </body></html>`;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/red.png") {
      // A slow image: the shot must wait for it, not only for the scroll.
      setTimeout(() => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(solidPng(200, 100, RED));
      }, 300);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

function pixel(image, x, y) {
  const offset = (y * image.width + x) * image.channels;
  return [...image.data.subarray(offset, offset + 3)];
}

test("in Chromium, a lazy image far below the fold is painted in the full-page shot", async (t) => {
  const { chromium } = require("@playwright/test");
  const { shootTarget } = await import("../scripts/shoot.mjs");
  const executablePath = process.env.AUTOREVIEW_UI_BROWSER_EXECUTABLE?.trim();
  let browser;
  try {
    browser = await chromium.launch(executablePath ? { executablePath } : undefined);
  } catch (err) {
    return t.skip(`no Chromium to launch: ${err.message.split("\n")[0]}`);
  }
  const { server, requests, baseUrl } = await lazyImageFixtureServer();
  try {
    const outDir = mkdtempSync(join(tmpdir(), "autoreview-ui-pre-scroll-live-"));
    const manifest = await shootTarget(
      browser,
      { baseUrl, outDir, settleMs: 0, viewports: [{ name: "desktop", width: 800, height: 600 }] },
      { id: "lazy", route: "/", axe: false },
    );

    assert.deepEqual(manifest.errors, []);
    const [shot] = manifest.shots;
    assert.deepEqual(shot.preScroll, {
      steps: Math.ceil((IMAGE_TOP + 100 - 600) / 600),
      bottomReached: true,
      networkIdle: true,
      images: 1,
      imagesNotLoaded: [],
    });
    assert.ok(requests.includes("/red.png"), "the lazy image was requested");

    const image = decodePng(readFileSync(shot.path));
    assert.equal(image.height, IMAGE_TOP + 100, "the shot covers the whole page");
    assert.deepEqual(pixel(image, 100, IMAGE_TOP + 50), RED, "the lazy image is painted, not blank");
    assert.deepEqual(pixel(image, 700, IMAGE_TOP + 50), [255, 255, 255], "beside the image is the page background");
    // The fixed bar is drawn where the viewport is. At the top of the shot it
    // proves the page was scrolled back before the screenshot.
    assert.deepEqual(pixel(image, 400, 10), BLUE);
    assert.deepEqual(pixel(image, 400, IMAGE_TOP + 90), [255, 255, 255]);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
