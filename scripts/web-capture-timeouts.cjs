"use strict";

/**
 * Playwright capture waits, configurable per project as `capture.<key>`.
 *
 *   navigationTimeoutMs  bounds each dev-server round trip: page.goto (to the
 *                        `load` event) and the dev-login request.
 *   waitForTimeoutMs     bounds a target's `waitFor` visibility wait.
 *
 * A dev server that compiles a route on its first request (Next.js dev) can
 * need far more than the defaults. This module belongs to the Playwright
 * driver's fingerprint closure only (fingerprint.cjs), so web-only capture
 * settings never change the identity of rn-sim captures.
 */

const DEFAULT_WEB_CAPTURE_TIMEOUTS = Object.freeze({
  navigationTimeoutMs: 30_000,
  waitForTimeoutMs: 15_000,
});
const WEB_CAPTURE_TIMEOUT_KEYS = Object.freeze(Object.keys(DEFAULT_WEB_CAPTURE_TIMEOUTS));
// Node timers overflow above 2^31-1 ms and then fire after 1 ms, which would
// turn a generous timeout into an instant failure. Reject it instead.
const MAX_TIMEOUT_MS = 2_147_483_647;

function isValidTimeoutMs(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;
}

/**
 * Resolve the Playwright driver's timeouts from `config.capture` or run.json.
 * An absent key takes its default; a present key must be a valid timeout, so a
 * hand-written run.json cannot hand Playwright NaN, 0 (no timeout) or a value
 * that overflows the timer.
 */
function webCaptureTimeouts(source) {
  const resolved = {};
  for (const key of WEB_CAPTURE_TIMEOUT_KEYS) {
    const value = source?.[key];
    if (value === undefined) {
      resolved[key] = DEFAULT_WEB_CAPTURE_TIMEOUTS[key];
      continue;
    }
    if (!isValidTimeoutMs(value)) {
      throw new Error(
        `${key} must be a positive integer of milliseconds no greater than ${MAX_TIMEOUT_MS}, got ${JSON.stringify(value)}`,
      );
    }
    resolved[key] = value;
  }
  return resolved;
}

module.exports = {
  DEFAULT_WEB_CAPTURE_TIMEOUTS,
  MAX_TIMEOUT_MS,
  WEB_CAPTURE_TIMEOUT_KEYS,
  isValidTimeoutMs,
  webCaptureTimeouts,
};
