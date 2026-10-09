"use strict";

/**
 * A dev server can drop its listener in the middle of a sweep: Next.js dev
 * restarts itself when its heap nears the limit, and every request in flight
 * then fails with a reset or a refused connection. That is a capture fault,
 * not a finding about the route, so the Playwright driver waits for the server
 * to answer again and shoots the target once more.
 *
 * The dev-login request can also fail with a 5xx that is not the route's own:
 * Next.js dev sometimes reads a build manifest while webpack is still writing
 * it ("Unexpected end of JSON input") and answers 500 before the handler runs.
 * Dev login is a capture precondition, not the screen under review, so its 5xx
 * gets the same single retry. A route that really fails answers 5xx again and
 * the target still fails.
 *
 * Only these faults qualify, and only after the server has already answered
 * earlier in the same sweep. A server that was never up fails fast as before,
 * and timeouts, page HTTP errors and missing selectors are results, not
 * faults, so none of them is retried.
 */

const CONNECTION_DROP =
  /\b(?:ECONNRESET|ECONNREFUSED|EPIPE)\b|socket hang up|net::ERR_(?:CONNECTION_(?:REFUSED|RESET|CLOSED)|EMPTY_RESPONSE)\b/;
// Matches the error authenticate() in shoot.mjs throws for a non-204 answer.
const DEV_LOGIN_SERVER_ERROR = /^\[shoot\] dev login for ".*" → 5\d\d\b/;

function isConnectionDrop(message) {
  return typeof message === "string" && CONNECTION_DROP.test(message);
}

function isTransientCaptureFault(message) {
  return isConnectionDrop(message) || (typeof message === "string" && DEV_LOGIN_SERVER_ERROR.test(message));
}

/**
 * Retry a target that produced no shot because of a transient fault, when an
 * earlier target in this sweep proved the server was up.
 */
function shouldRetryTarget(manifest, serverAnsweredEarlier) {
  return (
    serverAnsweredEarlier === true &&
    manifest.shots.length === 0 &&
    manifest.errors.some(isTransientCaptureFault)
  );
}

/**
 * Poll `baseUrl` until it answers below 500 or `timeoutMs` passes. A restarting
 * dev server refuses connections first, then answers once it is ready.
 */
async function waitForServer(baseUrl, timeoutMs, options = {}) {
  const {
    fetchImpl = fetch,
    intervalMs = 1000,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const remaining = Math.max(1, deadline - now());
    try {
      const res = await fetchImpl(baseUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(remaining),
      });
      if (res.status < 500) return true;
    } catch {
      // Refused or aborted: the server is not back yet.
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  return false;
}

module.exports = { isConnectionDrop, isTransientCaptureFault, shouldRetryTarget, waitForServer };
