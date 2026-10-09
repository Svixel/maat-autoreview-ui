"use strict";

// A dev server that restarts mid-sweep (Next.js dev at its heap limit) drops the
// connections in flight. The Playwright driver waits for it and retries that
// target once, but only after the server answered earlier in the sweep.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { isConnectionDrop, isTransientCaptureFault, shouldRetryTarget, waitForServer } = require("../scripts/web-capture-retry.cjs");

test("dropped connections are recognised; timeouts and HTTP failures are not", () => {
  for (const message of [
    "apiRequestContext.post: read ECONNRESET",
    "apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3001",
    "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3001/admin",
    "page.goto: net::ERR_CONNECTION_RESET at http://127.0.0.1:3001/",
    "page.goto: net::ERR_EMPTY_RESPONSE at http://127.0.0.1:3001/",
    "apiRequestContext.post: socket hang up",
  ]) {
    assert.equal(isConnectionDrop(message), true, message);
  }
  for (const message of [
    "page.goto: Timeout 30000ms exceeded.",
    '[shoot] dev login for "admin" → 401 (is the server up and fixtures seeded?)',
    'clip ".hero" not found at mobile',
    undefined,
  ]) {
    assert.equal(isConnectionDrop(message), false, String(message));
  }
});

test("a dev-login 5xx is a transient fault; a 4xx and a page error are not", () => {
  assert.equal(
    isTransientCaptureFault('[shoot] dev login for "advertiser-suspended" → 500 (is the server up and fixtures seeded?)'),
    true,
  );
  assert.equal(isTransientCaptureFault('[shoot] dev login for "admin" → 503 (is the server up and fixtures seeded?)'), true);
  assert.equal(isTransientCaptureFault('[shoot] dev login for "admin" → 401 (is the server up and fixtures seeded?)'), false);
  assert.equal(isTransientCaptureFault('[shoot] dev login for "admin" → 404 (is the server up and fixtures seeded?)'), false);
  assert.equal(isTransientCaptureFault("page.goto: Timeout 30000ms exceeded."), false);
  assert.equal(isTransientCaptureFault("apiRequestContext.post: read ECONNRESET"), true);
  assert.equal(
    shouldRetryTarget({ shots: [], errors: ['[shoot] dev login for "user" → 500 (is the server up and fixtures seeded?)'] }, true),
    true,
  );
});

test("only a shotless target that lost its connection after the server was up is retried", () => {
  const dropped = { shots: [], errors: ["apiRequestContext.post: read ECONNRESET"] };
  assert.equal(shouldRetryTarget(dropped, true), true);
  assert.equal(shouldRetryTarget(dropped, false), false, "a server that was never up fails fast");
  assert.equal(
    shouldRetryTarget({ shots: [], errors: ["page.goto: Timeout 30000ms exceeded."] }, true),
    false,
    "a timeout is a result, not a fault",
  );
  assert.equal(
    shouldRetryTarget({ shots: [{ viewport: "mobile" }], errors: ["axe: read ECONNRESET"] }, true),
    false,
    "a target that already has shots keeps them",
  );
});

test("waitForServer returns once the server answers below 500", async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 307;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    assert.equal(await waitForServer(`http://127.0.0.1:${port}/`, 5_000), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("waitForServer keeps polling through refusals and 5xx, then gives up at the deadline", async () => {
  let clock = 0;
  const answers = [new Error("ECONNREFUSED"), { status: 503 }, new Error("ECONNREFUSED")];
  let calls = 0;
  const fetchImpl = async () => {
    const answer = answers[calls++ % answers.length];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const ok = await waitForServer("http://127.0.0.1:9/", 10_000, {
    fetchImpl,
    intervalMs: 1_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(ok, false);
  assert.equal(calls, 10);

  clock = 0;
  calls = 0;
  const recovering = [new Error("ECONNREFUSED"), new Error("ECONNRESET"), { status: 200 }];
  const back = await waitForServer("http://127.0.0.1:9/", 10_000, {
    fetchImpl: async () => {
      const answer = recovering[calls++];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(back, true);
  assert.equal(calls, 3);
});
