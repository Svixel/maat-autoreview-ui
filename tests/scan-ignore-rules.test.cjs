"use strict";

// scan.ignoreRules: a project switches off a scan rule its documented design
// system contradicts. The contract under test: a known id is required (a typo
// is a config error, never a silent no-op), ignored hits leave the findings and
// the exit code, and every ignored rule is still reported with its hit count.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  RULE_IDS,
  deriveAtoms,
  deriveTokens,
  partitionIgnoredRules,
  scanFileContent,
} = require("../scripts/ui-scan-core.cjs");
const {
  RN_RULE_IDS,
  deriveRnAtoms,
  deriveRnTokens,
  scanRnFileContent,
} = require("../scripts/ui-scan-core-rn.cjs");
const { schemas, validateConfig } = require("../schemas/validator.cjs");

const UI_SCAN = join(__dirname, "..", "scripts", "ui-scan");
const UI_REVIEW = join(__dirname, "..", "scripts", "ui-review");

const HUGEICONS_SCREEN = `import { HugeiconsIcon } from "@hugeicons/react";
export function Screen() {
  return (
    <div>
      <HugeiconsIcon icon={SearchIcon} size={16} strokeWidth={2} />
      <HugeiconsIcon icon={CloseIcon} size={16} strokeWidth={2} />
      <button className="cta">Go</button>
    </div>
  );
}
`;

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

/** A git repo with a Button atom and one screen using direct Hugeicons. */
function webRepo() {
  const repo = mkdtempSync(join(tmpdir(), "autoreview-ui-ignore-"));
  mkdirSync(join(repo, "app", "x"), { recursive: true });
  mkdirSync(join(repo, "components", "design-system"), { recursive: true });
  writeFileSync(join(repo, "app", "globals.css"), ":root { --color-navy: #001d3d; }\n");
  writeFileSync(join(repo, "components", "design-system", "index.ts"), "export function Button() { return null; }\n");
  writeFileSync(join(repo, "app", "x", "Screen.tsx"), HUGEICONS_SCREEN);
  run("git", ["init"], repo);
  return repo;
}

function scanCli(repo, extra) {
  return spawnSync(process.execPath, [UI_SCAN, "--root", repo, "--files", "app/x/Screen.tsx", ...extra], {
    encoding: "utf8",
  });
}

function baseConfig(overrides = {}) {
  return {
    configVersion: 2,
    name: "fixture",
    root: "/tmp/fixture",
    baseUrl: "http://127.0.0.1:9",
    routes: [{ id: "screen", route: "/screen", sourceFiles: ["app/Screen.tsx"] }],
    ...overrides,
  };
}

// --- the rule inventory ------------------------------------------------------

test("RULE_IDS is exactly the set of rules the web scanner emits", () => {
  const inv = {
    tokens: deriveTokens(":root { --color-a: #000; --space-4: 1rem; --radius-sm: 4px; --shadow-card: 0 1px 2px #000; --font-size-md: 1rem; }"),
    atoms: deriveAtoms('export { Button } from "./Button";'),
  };
  const corpus = [
    ["app/x/A.tsx", `export const A = () => (
  <div style={{ padding: '12px' }}>
    <style jsx>{\`.a { color: red; }\`}</style>
    <HugeiconsIcon icon={X} />
    <button className="cta">Go</button>
    <p>Gems — rare</p>
  </div>
);`],
    ["app/x/a.module.css", `.a { color: #111; }
.b { padding: 16px; }
.c { box-shadow: 0 1px 2px var(--x), 0 2px 4px var(--y); }
.d { box-shadow: 0 1px 2px #000; }`],
  ];
  const emitted = new Set(corpus.flatMap(([path, content]) => scanFileContent(path, content, null, inv).map((f) => f.rule)));
  assert.deepEqual([...emitted].sort(), [...RULE_IDS].sort());
});

test("RN_RULE_IDS is exactly the set of rules the RN scanner emits", () => {
  const inv = {
    tokens: deriveRnTokens([
      { path: "spacing.ts", content: "export const spacing = { sm: 8, md: 16 };\n" },
      { path: "colors.ts", content: "export const colors = { primary: '#7A6552' };\n" },
    ]),
    atoms: deriveRnAtoms(`| Component | Usage |
|---|---|
| \`Button\` | buttons |
| \`Input\` | inputs |
| \`Toggle\` | switches |
| \`Skeleton\` | loading |
`),
  };
  const corpus = [
    ["src/components/Box.tsx", "const styles = StyleSheet.create({ box: { backgroundColor: '#ff0000', padding: 16 } });"],
    ["src/screens/S.tsx", "import { ActivityIndicator } from 'react-native';"],
    ["src/screens/F.tsx", 'export const F = () => <TextInput returnKeyType="done" />;'],
    ["src/components/Copy.tsx", "export const A = () => <Text>Booked 🎉 — tonight</Text>;"],
    ["src/components/P.tsx", "export const A = () => <Pressable onPress={go}><Text>Go</Text></Pressable>;"],
    ["src/components/I.tsx", "export const A = () => <Image source={s} style={styles.img} />;"],
    ["src/components/W.tsx", "export const A = () => <Switch value={v} onValueChange={f} />;"],
    ["src/components/R.tsx", `export const A = () => <Pressable style={styles.submitButton} />;
const styles = StyleSheet.create({ submitButton: { padding: spacing.sm } });`],
    ["src/components/profile/ProfileHeader.tsx", `export const ProfileHeader = () => <View style={styles.container} />;
const styles = StyleSheet.create({ container: { backgroundColor: colors.primary, paddingTop: spacing.md } });`],
  ];
  const emitted = new Set(corpus.flatMap(([path, content]) => scanRnFileContent(path, content, null, inv).map((f) => f.rule)));
  assert.deepEqual([...emitted].sort(), [...RN_RULE_IDS].sort());
});

test("partitionIgnoredRules drops ignored findings and counts every ignored rule, zero hits included", () => {
  const findings = [
    { rule: "hugeicons-direct", line: 1 },
    { rule: "reinvented-component", line: 2 },
    { rule: "hugeicons-direct", line: 3 },
  ];
  const { kept, ignoredByRule } = partitionIgnoredRules(findings, ["style-tag", "hugeicons-direct"]);
  assert.deepEqual(kept, [{ rule: "reinvented-component", line: 2 }]);
  assert.deepEqual(ignoredByRule, { "hugeicons-direct": 2, "style-tag": 0 });
  assert.deepEqual(partitionIgnoredRules(findings), { kept: findings, ignoredByRule: {} });
});

// --- config validation -------------------------------------------------------

test("config validation accepts known ids for the configured ruleset", () => {
  assert.deepEqual(validateConfig(baseConfig({ scan: { ignoreRules: ["hugeicons-direct", "style-tag"] } })).errors, []);
  assert.deepEqual(
    validateConfig(baseConfig({ scan: { ruleset: "rn-stylesheet", ignoreRules: ["rn-solid-chrome", "em-dash"] } })).errors,
    [],
  );
});

test("config validation rejects an unknown or cross-ruleset rule id instead of ignoring nothing", () => {
  const typo = validateConfig(baseConfig({ scan: { ignoreRules: ["hugeicon-direct"] } }));
  assert.equal(typo.valid, false);
  assert.match(typo.errors.join("\n"), /config\.scan\.ignoreRules: unknown rule id "hugeicon-direct" for ruleset web-css \(known: .*hugeicons-direct/);

  const webIdOnRn = validateConfig(baseConfig({ scan: { ruleset: "rn-stylesheet", ignoreRules: ["hugeicons-direct"] } }));
  assert.match(webIdOnRn.errors.join("\n"), /unknown rule id "hugeicons-direct" for ruleset rn-stylesheet/);

  const rnIdOnWeb = validateConfig(baseConfig({ scan: { ignoreRules: ["rn-emoji"] } }));
  assert.match(rnIdOnWeb.errors.join("\n"), /unknown rule id "rn-emoji" for ruleset web-css/);
});

test("config validation rejects a malformed ignoreRules list", () => {
  for (const ignoreRules of [[], "hugeicons-direct", [""], [42]]) {
    const result = validateConfig(baseConfig({ scan: { ignoreRules } }));
    assert.match(result.errors.join("\n"), /config\.scan\.ignoreRules: must be a non-empty array of strings/, JSON.stringify(ignoreRules));
  }
  const duplicate = validateConfig(baseConfig({ scan: { ignoreRules: ["style-tag", "style-tag"] } }));
  assert.match(duplicate.errors.join("\n"), /config\.scan\.ignoreRules: must not contain duplicates/);
});

test("config schema documents ignoreRules with the same per-ruleset ids as the scanners", () => {
  const scan = schemas()["config.v2.json"].$defs.scan;
  assert.equal(scan.properties.ignoreRules.minItems, 1);
  assert.equal(scan.properties.ignoreRules.uniqueItems, true);
  const [rulesetCondition] = scan.allOf;
  assert.equal(rulesetCondition.if.properties.ruleset.const, "rn-stylesheet");
  assert.deepEqual(rulesetCondition.then.properties.ignoreRules.items.enum, [...RN_RULE_IDS]);
  assert.deepEqual(rulesetCondition.else.properties.ignoreRules.items.enum, [...RULE_IDS]);
});

// --- ui-scan CLI -------------------------------------------------------------

test("ui-scan --ignore-rules excludes the rule from findings and exit code but reports its hits", () => {
  const repo = webRepo();
  const baseline = scanCli(repo, ["--json"]);
  assert.equal(baseline.status, 1, baseline.stderr);
  assert.deepEqual(JSON.parse(baseline.stdout).summary.byRule, { "hugeicons-direct": 3, "reinvented-component": 1 });

  const ignored = scanCli(repo, ["--json", "--ignore-rules", "hugeicons-direct"]);
  assert.equal(ignored.status, 1, "the reinvented button is still a finding");
  const report = JSON.parse(ignored.stdout);
  assert.equal(report.summary.findings, 1);
  assert.deepEqual(report.summary.byRule, { "reinvented-component": 1 });
  assert.deepEqual(report.summary.ignoredByRule, { "hugeicons-direct": 3 });
  assert.ok(report.findings.every((finding) => finding.rule !== "hugeicons-direct"));

  const clean = scanCli(repo, ["--json", "--ignore-rules", "hugeicons-direct,reinvented-component"]);
  assert.equal(clean.status, 0, "only ignored rules fired, so nothing is actionable");
  assert.deepEqual(JSON.parse(clean.stdout).summary.ignoredByRule, { "hugeicons-direct": 3, "reinvented-component": 1 });

  const text = scanCli(repo, ["--ignore-rules", "hugeicons-direct,style-tag"]);
  assert.match(text.stdout, /Ignored by --ignore-rules, not counted: hugeicons-direct \(3 hits\), style-tag \(0 hits\)\./);
});

test("ui-scan counts ignored hits at the same confidence floor as findings", () => {
  const repo = webRepo();
  writeFileSync(join(repo, "app", "x", "Screen.tsx"), "export const A = () => <p>Gems — rare — old</p>;\n");
  const hidden = JSON.parse(scanCli(repo, ["--json", "--ignore-rules", "em-dash"]).stdout);
  assert.deepEqual(hidden.summary.ignoredByRule, { "em-dash": 0 }, "em-dash is below the default 0.5 floor");
  const lowered = JSON.parse(scanCli(repo, ["--json", "--min-confidence", "0.3", "--ignore-rules", "em-dash"]).stdout);
  assert.deepEqual(lowered.summary.ignoredByRule, { "em-dash": 2 });
});

test("ui-scan rejects an --ignore-rules id the selected ruleset does not have", () => {
  const repo = webRepo();
  const typo = scanCli(repo, ["--ignore-rules", "hugeicon-direct"]);
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /unknown --ignore-rules id\(s\) for ruleset web-css: hugeicon-direct \(known: .*hugeicons-direct/);

  const crossRuleset = scanCli(repo, ["--ruleset", "rn-stylesheet", "--ignore-rules", "hugeicons-direct"]);
  assert.equal(crossRuleset.status, 2);
  assert.match(crossRuleset.stderr, /for ruleset rn-stylesheet: hugeicons-direct/);

  const empty = scanCli(repo, ["--ignore-rules"]);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /--ignore-rules requires a comma-separated list of rule ids/);
});

// --- ui-review ---------------------------------------------------------------

function writeReviewConfig(root, scan) {
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({
    configVersion: 2,
    name: "fixture",
    root,
    baseUrl: "http://127.0.0.1:9",
    intentDoc: "skill:projects/intent/.gitkeep",
    auth: { mode: "none" },
    viewports: [{ name: "mobile", width: 375, height: 812 }],
    scan,
    routes: [{ id: "screen", route: "/screen", sourceFiles: ["app/x/Screen.tsx"] }],
  }, null, 2));
  return configPath;
}

test("ui-review forwards scan.ignoreRules and states the ignored hits in the bundle and summary", () => {
  const root = webRepo();
  const configPath = writeReviewConfig(root, {
    barrels: ["components/design-system/index.ts"],
    ignoreRules: ["hugeicons-direct"],
  });
  const args = [UI_REVIEW, "--config", configPath, "--no-shots", "--scan-scope", "targets"];

  const json = spawnSync(process.execPath, [...args, "--json"], { encoding: "utf8" });
  assert.equal(json.status, 1, json.stderr || json.stdout);
  const bundle = JSON.parse(json.stdout);
  assert.equal(bundle.scan.summary.findings, 1);
  assert.deepEqual(bundle.scan.summary.byRule, { "reinvented-component": 1 });
  assert.deepEqual(bundle.scan.summary.ignoredByRule, { "hugeicons-direct": 3 });

  const text = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.match(text.stdout, /SCAN {2}1 laziness tell\(s\): \{"reinvented-component":1\}/);
  assert.match(text.stdout, /SCAN {2}ignored by config \(scan\.ignoreRules\), not counted: \{"hugeicons-direct":3\}/);
});

test("ui-review exits 0 when every scan hit belongs to an ignored rule", () => {
  const root = webRepo();
  writeFileSync(join(root, "app", "x", "Screen.tsx"), '<HugeiconsIcon icon={SearchIcon} size={16} />\n');
  const configPath = writeReviewConfig(root, { ignoreRules: ["hugeicons-direct"] });
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--no-shots", "--scan-scope", "targets", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const bundle = JSON.parse(result.stdout);
  assert.equal(bundle.scan.summary.findings, 0);
  assert.deepEqual(bundle.scan.summary.ignoredByRule, { "hugeicons-direct": 1 });
});

test("ui-review refuses a config whose ignoreRules names an unknown rule", () => {
  const root = webRepo();
  const configPath = writeReviewConfig(root, { ignoreRules: ["hugeicon-direct"] });
  const result = spawnSync(
    process.execPath,
    [UI_REVIEW, "--config", configPath, "--no-shots", "--scan-scope", "targets"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /config\.scan\.ignoreRules: unknown rule id "hugeicon-direct"/);
});
