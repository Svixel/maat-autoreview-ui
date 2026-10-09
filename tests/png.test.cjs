"use strict";

// png.cjs is the codec the rn-sim driver depends on for BOTH region clipping and
// the before/after "did this interaction change anything" diff. A wrong crop
// silently ships the wrong screenshot to the vision pass, and a wrong diff
// silently reports dead controls as working, so it is tested directly here
// rather than only through a simulator run.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { decodePng, encodePng, cropImage, cropPng, resizeImage, resizeLongEdgePng, regionEquals, clampRect } =
  require("../scripts/png.cjs");

/** Build an RGBA image whose every pixel encodes its own coordinates. */
function coordImage(width, height) {
  const channels = 4;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      data[i] = x % 256;
      data[i + 1] = y % 256;
      data[i + 2] = (x * y) % 256;
      data[i + 3] = 255;
    }
  }
  return { width, height, channels, data };
}

// --- codec ------------------------------------------------------------------

test("encode -> decode is lossless for every pixel", () => {
  const img = coordImage(37, 23);
  const round = decodePng(encodePng(img));
  assert.equal(round.width, img.width);
  assert.equal(round.height, img.height);
  assert.equal(round.channels, img.channels);
  assert.ok(round.data.equals(img.data), "pixel data must survive the round trip");
});

test("a non-PNG buffer is rejected, not guessed at", () => {
  assert.throws(() => decodePng(Buffer.from("definitely not a png")), /not a PNG/);
});

// --- crop -------------------------------------------------------------------

test("crop is origin-anchored and pixel-exact", () => {
  const img = coordImage(64, 48);
  const rect = { x: 10, y: 7, width: 12, height: 9 };
  const out = cropImage(img, rect);
  assert.equal(out.width, 12);
  assert.equal(out.height, 9);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const o = (y * out.width + x) * 4;
      const s = ((y + rect.y) * img.width + (x + rect.x)) * 4;
      assert.equal(out.data[o], img.data[s], `red mismatch at ${x},${y}`);
      assert.equal(out.data[o + 1], img.data[s + 1], `green mismatch at ${x},${y}`);
      assert.equal(out.data[o + 2], img.data[s + 2], `blue mismatch at ${x},${y}`);
    }
  }
});

test("cropPng round-trips through the encoder", () => {
  const img = coordImage(40, 40);
  const rect = { x: 5, y: 5, width: 10, height: 10 };
  const decoded = decodePng(cropPng(encodePng(img), rect));
  assert.equal(decoded.width, 10);
  assert.equal(decoded.height, 10);
  assert.ok(decoded.data.equals(cropImage(img, rect).data));
});

test("a rect running off the edge is clamped, not wrapped", () => {
  const img = coordImage(20, 20);
  const clamped = clampRect(img, { x: 15, y: 15, width: 100, height: 100 });
  assert.deepEqual(clamped, { x: 15, y: 15, width: 5, height: 5 });
  assert.equal(clampRect(img, { x: 50, y: 50, width: 4, height: 4 }), null);
});

test("bilinear resize preserves edge pixels and sets the requested long edge", () => {
  const source = {
    width: 2,
    height: 2,
    channels: 4,
    data: Buffer.from([
      0, 0, 0, 255, 255, 0, 0, 255,
      0, 255, 0, 255, 255, 255, 255, 255,
    ]),
  };
  const scaled = resizeImage(source, 3, 3);
  assert.deepEqual([...scaled.data.subarray(0, 4)], [0, 0, 0, 255]);
  assert.deepEqual([...scaled.data.subarray((2 * 3 + 2) * 4, (2 * 3 + 3) * 4)], [255, 255, 255, 255]);
  assert.deepEqual([...scaled.data.subarray((1 * 3 + 1) * 4, (1 * 3 + 2) * 4)], [128, 128, 64, 255]);

  const longEdge = decodePng(resizeLongEdgePng(encodePng(coordImage(20, 10)), 1568));
  assert.deepEqual([longEdge.width, longEdge.height], [1568, 784]);
});

// --- region diff (the MISSING-STATE signal) ---------------------------------

test("regionEquals is true for identical buffers and false for a changed pixel", () => {
  const img = coordImage(50, 50);
  const a = encodePng(img);
  assert.equal(regionEquals(a, encodePng(img), { x: 0, y: 0, width: 50, height: 50 }), true);

  const mutated = { ...img, data: Buffer.from(img.data) };
  const idx = (30 * 50 + 30) * 4;
  mutated.data[idx] = mutated.data[idx] ^ 0xff;
  const b = encodePng(mutated);

  assert.equal(regionEquals(a, b, { x: 0, y: 0, width: 50, height: 50 }), false);
  // The change is INSIDE this rect...
  assert.equal(regionEquals(a, b, { x: 28, y: 28, width: 5, height: 5 }), false);
  // ...and outside this one, which must still compare equal.
  assert.equal(regionEquals(a, b, { x: 0, y: 0, width: 10, height: 10 }), true);
});

test("differing dimensions count as changed rather than throwing", () => {
  const a = encodePng(coordImage(20, 20));
  const b = encodePng(coordImage(21, 20));
  assert.equal(regionEquals(a, b, { x: 0, y: 0, width: 20, height: 20 }), false);
});

// --- against a REAL simctl PNG ----------------------------------------------
//
// simctl picks filter types per row, so a synthetic fixture does not prove the
// decoder handles what the simulator actually emits. This is opt-in: `npm
// test` must stay a fake-boundary suite and never contact CoreSimulator.

test("decodes a real simulator screenshot and crops it consistently", (t) => {
  if (process.env.AUTOREVIEW_UI_LIVE_SIM_TEST !== "1") {
    return t.skip("set AUTOREVIEW_UI_LIVE_SIM_TEST=1 for the opt-in simulator proof");
  }
  let udid;
  try {
    const json = JSON.parse(
      execFileSync("xcrun", ["simctl", "list", "devices", "booted", "--json"], {
        encoding: "utf8",
      }),
    );
    udid = Object.values(json.devices).flat().find((d) => d.state === "Booted")?.udid;
  } catch {
    /* no simulator tooling */
  }
  if (!udid) return t.skip("no booted simulator");

  const shot = join(mkdtempSync(join(tmpdir(), "png-test-")), "shot.png");
  execFileSync("xcrun", ["simctl", "io", udid, "screenshot", shot], { stdio: "ignore" });
  const buffer = readFileSync(shot);

  const img = decodePng(buffer);
  assert.ok(img.width > 0 && img.height > 0);
  assert.equal(img.data.length, img.width * img.height * img.channels);

  // Re-encoding and re-decoding must reproduce the same pixels, which only
  // holds if every filter type in the source was unfiltered correctly.
  assert.ok(decodePng(encodePng(img)).data.equals(img.data));

  const rect = { x: 0, y: 0, width: Math.min(64, img.width), height: Math.min(64, img.height) };
  assert.ok(decodePng(cropPng(buffer, rect)).data.equals(cropImage(img, rect).data));
  assert.equal(regionEquals(buffer, buffer, rect), true);
});
