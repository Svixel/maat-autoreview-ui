"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { schemas, validateConfig } = require("../schemas/validator.cjs");

function config(scan) {
  return {
    configVersion: 2,
    name: "fixture",
    root: "/tmp/fixture",
    baseUrl: "http://127.0.0.1:9",
    routes: [{ id: "screen", route: "/screen", sourceFiles: ["app/Screen.tsx"] }],
    scan,
  };
}

test("config schema declares barrels and shell-policy rule shape", () => {
  const scan = schemas()["config.v2.json"].$defs.scan;
  const rule = schemas()["config.v2.json"].$defs.shellPolicyRule;
  assert.equal(scan.properties.barrels.minItems, 1);
  assert.deepEqual(rule.required, ["routeClass", "match", "require", "exceptions"]);
  assert.equal(rule.properties.match.minItems, 1);
  assert.equal(rule.properties.require.minItems, 1);
});

test("config validation accepts shell-policy value and rejects empty match or require lists", () => {
  const good = config({
    barrels: ["src/ui/atoms/index.ts"],
    shellPolicy: [{
      routeClass: "sub-screen",
      match: ["/screen"],
      require: ["ScreenHeader", "ScrollViewHeader"],
      exceptions: [],
    }],
  });
  assert.equal(validateConfig(good).valid, true);

  const badMatch = structuredClone(good);
  badMatch.scan.shellPolicy[0].match = [];
  assert.match(validateConfig(badMatch).errors.join("\n"), /shellPolicy\[0\]\.match: must be a non-empty array/);

  const badRequire = structuredClone(good);
  badRequire.scan.shellPolicy[0].require = [];
  assert.match(validateConfig(badRequire).errors.join("\n"), /shellPolicy\[0\]\.require: must be a non-empty array/);
});

test("config schema and validator expose bounded direct-API judge settings without storing a key", () => {
  const judge = schemas()["config.v2.json"].$defs.judge;
  assert.deepEqual(Object.keys(judge.properties).sort(), [
    "apiKeyEnv",
    "maxFindingsPerBatch",
    "maxFindingsPerRun",
    "maxImagesPerBatch",
    "maxRetries",
    "model",
    "provider",
    "reasoningEffort",
    "timeoutMs",
  ]);
  assert.deepEqual(judge.properties.reasoningEffort.enum, ["none", "minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(judge.properties.maxImagesPerBatch.minimum, 2);
  assert.equal(judge.properties.maxImagesPerBatch.maximum, 8);
  assert.equal(judge.properties.provider.enum[0], "openai");
  assert.equal(judge.properties.maxRetries.maximum, 5);
  assert.equal(judge.properties.maxFindingsPerBatch.minimum, 1);
  assert.equal(judge.properties.maxFindingsPerRun.minimum, 1);
  assert.equal(schemas()["judge-response.v1.json"].properties.findings.maxItems, 12);

  const good = { ...config(), judge: {
    provider: "openai",
    model: "gpt-5.6",
    apiKeyEnv: "FAKE_SENSITIVE_VAR_JUDGE_API_KEY",
    maxRetries: 2,
    maxFindingsPerBatch: 6,
    maxImagesPerBatch: 4,
    maxFindingsPerRun: 24,
    timeoutMs: 1000,
    reasoningEffort: "high",
  } };
  assert.equal(validateConfig(good).valid, true);
  const badEffort = { ...config(), judge: { model: "gpt-5.6-sol", reasoningEffort: "ultra" } };
  assert.equal(validateConfig(badEffort).valid, false);
  assert.match(validateConfig(badEffort).errors.join("\n"), /judge\.reasoningEffort/);
  const zeroCap = { ...config(), judge: { maxFindingsPerBatch: 0, maxFindingsPerRun: 0 } };
  assert.match(validateConfig(zeroCap).errors.join("\n"), /maxFindingsPerBatch: must be an integer within 1\.\.12/);
  assert.match(validateConfig(zeroCap).errors.join("\n"), /maxFindingsPerRun: must be a positive integer/);
  const rawKey = { ...config(), judge: { apiKey: "FAKE_CREDENTIAL_MATERIAL_MUST_NOT_BE_CONFIGURED" } };
  assert.match(validateConfig(rawKey).errors.join("\n"), /judge\.apiKey: is not allowed/);
});

test("judge batch finding cap accepts 12 and rejects 13", () => {
  const judge = schemas()["config.v2.json"].$defs.judge;
  assert.equal(judge.properties.maxFindingsPerBatch.maximum, 12);
  assert.equal(validateConfig({ ...config(), judge: { maxFindingsPerBatch: 12 } }).valid, true);

  const overLimit = validateConfig({ ...config(), judge: { maxFindingsPerBatch: 13 } });
  assert.equal(overLimit.valid, false);
  assert.match(overLimit.errors.join("\n"), /config\.judge\.maxFindingsPerBatch: must be an integer within 1\.\.12/);
});

test("every shipped project config remains valid with the Pass 2 schema", () => {
  const projects = join(__dirname, "..", "projects");
  for (const file of readdirSync(projects).filter((name) => name.endsWith(".json") && !name.endsWith(".bak"))) {
    const validation = validateConfig(JSON.parse(readFileSync(join(projects, file), "utf8")));
    assert.equal(validation.valid, true, `${file}: ${validation.errors.join("; ")}`);
  }
});
