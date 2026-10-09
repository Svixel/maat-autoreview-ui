"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { deriveAtoms } = require("../scripts/ui-scan-core.cjs");

const FIXTURE_ROOT = join(__dirname, "fixtures", "example-app", "src", "components", "ui");

test("Example checked-in atom barrel fixture has 89 parser-derived value exports", () => {
  const exports = deriveAtoms(readFileSync(join(FIXTURE_ROOT, "atoms", "index.ts"), "utf8"));
  assert.equal(exports.size, 89);
  assert.ok(exports.has("ScreenHeader"));
  assert.equal(exports.has("AppBlurViewProps"), false, "type-only exports stay out of inventory");
});

test("Example checked-in molecule barrel fixture has 100 parser-derived value exports", () => {
  const exports = deriveAtoms(readFileSync(join(FIXTURE_ROOT, "molecules", "index.ts"), "utf8"));
  assert.equal(exports.size, 100);
  assert.ok(exports.has("SheetScreen"));
  assert.ok(exports.has("useSheetScrollHandler"), "value hooks remain in the inventory");
  assert.equal(exports.has("SheetScreenProps"), false, "type-only exports stay out of inventory");
});
