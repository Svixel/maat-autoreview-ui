"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  deriveTokens,
  deriveAtoms,
  scanFileContent,
  hasHardcodedLength,
  stripParens,
} = require("../scripts/ui-scan-core.cjs");

const GLOBALS = `
:root {
  --color-navy: #001d3d;
  --color-pink: #ff5da2;
  --ink-70: color-mix(in srgb, var(--color-navy) 70%, transparent);
  --space-4: 1rem;
  --radius-sm: 10px;
  --shadow-card: 0 10px 24px rgba(0,29,61,.18);
  --font-size-md: 1rem;
}
`;
const BARREL = `
export { Button, ButtonLink } from "./atoms/Button";
export { Input } from "./atoms/Input";
export { Select } from "./atoms/Select";
export { TextArea } from "./atoms/TextArea";
export { Pill, type PillTone } from "./atoms/Pill";
`;

const tokens = deriveTokens(GLOBALS);
const atoms = deriveAtoms(BARREL);
const inv = { tokens, atoms };

const rules = (f) => f.map((x) => x.rule);
function scan(path, content, added = null) {
  return scanFileContent(path, content, added, inv);
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test("deriveTokens finds names and categories", () => {
  assert.ok(tokens.names.has("--color-navy"));
  assert.deepEqual(tokens.categories, {
    color: true,
    space: true,
    radius: true,
    shadow: true,
    fontSize: true,
  });
});

test("deriveAtoms collects components, drops type exports", () => {
  assert.ok(atoms.has("Button"));
  assert.ok(atoms.has("Input"));
  assert.ok(atoms.has("TextArea"));
  assert.ok(!atoms.has("PillTone"));
});

test("deriveAtoms follows export-star barrels", () => {
  const found = deriveAtoms(
    `export * from "./atoms/Button";\nexport * from "./atoms/Input";`,
    (specifier) => {
      if (specifier === "./atoms/Button") {
        return { source: "atoms/Button.tsx", content: "export function Button() {}" };
      }
      if (specifier === "./atoms/Input") {
        return { source: "atoms/Input.tsx", content: "export const Input = () => null;" };
      }
      return null;
    },
    "index.ts",
  );
  assert.ok(found.has("Button"));
  assert.ok(found.has("Input"));
});

test("inline-style with literals is flagged", () => {
  const f = scan("app/x/Foo.tsx", `<div style={{ padding: 16, color: '#333' }} />`);
  assert.ok(rules(f).includes("inline-style-literal"));
});

test("multiline inline-style literals are scoped to literal lines", () => {
  const content = `<div\n  style={{\n    width: pct,\n    padding: 16,\n  }}\n/>`;
  const f = scan("app/x/Foo.tsx", content, new Set([4]));
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, "inline-style-literal");
  assert.equal(f[0].line, 4);
  assert.equal(scan("app/x/Foo.tsx", content, new Set([3])).length, 0);
});

test("inline-style dynamic token passthrough is NOT flagged", () => {
  const f = scan(
    "app/x/Foo.tsx",
    "<div style={{ ['--card-padding']: `var(--space-4)`, width: pct }} />",
  );
  assert.ok(!rules(f).includes("inline-style-literal"));
});

test("inline-style with only a variable value is NOT flagged", () => {
  const f = scan("app/x/Foo.tsx", `<div style={{ width: barWidth }} />`);
  assert.equal(f.length, 0);
});

test("a cast custom-property style ends at its own brace, not at later JSX", () => {
  // The lazy `}}` match used to run past `} as React.CSSProperties}` into the
  // following markup and report its "6px" comment as a literal style value.
  const content = `<div
  style={{
    '--gem-accent': accent ?? 'var(--ink)',
  } as React.CSSProperties}
>
  {/* tight mobile padding (6px) */}
  <div className="px-1.5">{content}</div>
</div>
<Nav style={{ '--x': 1 }} />`;
  assert.deepEqual(scan("app/x/Foo.tsx", content), []);
});

test("a cast style object with a literal value is still flagged on its own line", () => {
  const content = `<div\n  style={{\n    paddingTop: '12px',\n  } as React.CSSProperties}\n/>`;
  const f = scan("app/x/Foo.tsx", content);
  assert.deepEqual(rules(f), ["inline-style-literal"]);
  assert.equal(f[0].line, 3);
});

test("single-key and trailing numeric inline-style literals are flagged", () => {
  assert.deepEqual(rules(scan("app/x/Foo.tsx", `<div style={{ padding: '12px' }} />`)), ["inline-style-literal"]);
  assert.deepEqual(rules(scan("app/x/Foo.tsx", `<div style={{\n  padding: '12px',\n}} />`)), ["inline-style-literal"]);
  assert.deepEqual(rules(scan("app/x/Foo.tsx", `<div style={{ zIndex: 4 }} />`)), ["inline-style-literal"]);
});

test("braces inside string values do not end the style object early", () => {
  const quoted = "<div style={{ content: '}}', width: '10px' }} />";
  assert.deepEqual(rules(scan("app/x/Foo.tsx", quoted)), ["inline-style-literal"]);
  const template = "<div style={{ transform: `translate(${x}}px)`, width: '10px' }} />";
  assert.deepEqual(rules(scan("app/x/Foo.tsx", template)), ["inline-style-literal"]);
});

test("style-tag and inline-style messages do not assume CSS Modules", () => {
  // Tailwind projects get the same findings; the advice must not
  // tell them to create a .module.css file their conventions do not use.
  const f = scan("app/x/Foo.tsx", "<div style={{ padding: '12px' }}><style jsx>{`.a{}`}</style></div>");
  for (const finding of f) {
    assert.doesNotMatch(finding.message, /CSS Modules only/);
    assert.match(finding.suggestion, /Tailwind/);
  }
  assert.deepEqual(rules(f).sort(), ["inline-style-literal", "style-tag"]);
});

test("styled raw <button> (with className) flagged where Button atom exists", () => {
  const f = scan("app/x/Foo.tsx", `<button className={styles.btn}>Go</button>`);
  assert.ok(rules(f).includes("reinvented-component"));
});

test("unstyled raw <button> (no className) is NOT flagged", () => {
  const f = scan("app/x/Foo.tsx", `<button type="submit" onClick={go}>Go</button>`);
  assert.ok(!rules(f).includes("reinvented-component"));
});

test("styled raw <button> inside design-system is NOT flagged", () => {
  const f = scan(
    "components/design-system/atoms/Button.tsx",
    `<button className={styles.btn}>Go</button>`,
  );
  assert.ok(!rules(f).includes("reinvented-component"));
});

test("<style> tag flagged", () => {
  const f = scan("app/x/Foo.tsx", `<style>{".a{color:red}"}</style>`);
  assert.ok(rules(f).includes("style-tag"));
});

test("direct Hugeicons flagged outside design-system", () => {
  const f = scan(
    "app/x/Foo.tsx",
    `import { Star } from "@hugeicons/react";\n<HugeiconsIcon icon={Star} />`,
  );
  assert.ok(rules(f).includes("hugeicons-direct"));
});

test("em-dash flagged in tsx but not in content files", () => {
  assert.ok(rules(scan("app/x/Foo.tsx", `<p>One — two</p>`)).includes("em-dash"));
  assert.ok(
    !rules(scan("content/steps/intro.tsx", `<p>One — two</p>`)).includes("em-dash"),
  );
});

test("hardcoded color flagged in module css, not in globals", () => {
  assert.ok(
    rules(scan("app/x/foo.module.css", `.a { color: #738394; }`)).includes(
      "hardcoded-color",
    ),
  );
  assert.equal(scan("app/globals.css", `.a { color: #738394; }`).length, 0);
});

test("css var usage is NOT flagged as hardcoded color", () => {
  const f = scan("app/x/foo.module.css", `.a { color: var(--color-navy); }`);
  assert.equal(f.length, 0);
});

test("hardcoded spacing flagged, token spacing is not", () => {
  assert.ok(
    rules(scan("app/x/foo.module.css", `.a { padding: 16px; }`)).includes(
      "hardcoded-length",
    ),
  );
  assert.equal(
    scan("app/x/foo.module.css", `.a { padding: var(--space-4); }`).length,
    0,
  );
});

test("1px hairline border is not flagged as hardcoded length", () => {
  assert.equal(scan("app/x/foo.module.css", `.a { border: 1px solid; }`).length, 0);
});

test("stacked shadow flagged, single token shadow is not", () => {
  assert.ok(
    rules(
      scan(
        "app/x/foo.module.css",
        `.a { box-shadow: 0 1px 2px rgba(0,0,0,.1), 0 2px 4px rgba(0,0,0,.1); }`,
      ),
    ).includes("stacked-shadow"),
  );
  assert.equal(
    scan("app/x/foo.module.css", `.a { box-shadow: var(--shadow-card); }`).length,
    0,
  );
});

test("addedLines scoping limits findings to the changed line", () => {
  const content = `.a { color: #111; }\n.b { color: #222; }`;
  const onlyLine2 = scan("app/x/foo.module.css", content, new Set([2]));
  assert.equal(onlyLine2.length, 1);
  assert.equal(onlyLine2[0].line, 2);
});

test("stripParens removes nested commas", () => {
  assert.equal(stripParens("a, rgba(0,0,0,1), b").split(",").length, 3);
});

test("hasHardcodedLength ignores 0/1/2px and var()", () => {
  assert.equal(hasHardcodedLength("0"), false);
  assert.equal(hasHardcodedLength("1px solid"), false);
  assert.equal(hasHardcodedLength("var(--space-4)"), false);
  assert.equal(hasHardcodedLength("16px"), true);
  assert.equal(hasHardcodedLength("1.5rem"), true);
});

test("ui-scan default includes staged tracked changes", () => {
  const repo = mkdtempSync(join(tmpdir(), "autoreview-ui-scan-"));
  mkdirSync(join(repo, "app", "x"), { recursive: true });
  writeFileSync(join(repo, "app", "globals.css"), ":root { --color-navy: #001d3d; }\n");
  writeFileSync(join(repo, "app", "x", "foo.module.css"), ".a { color: var(--color-navy); }\n");
  run("git", ["init"], repo);
  run("git", ["config", "user.email", "test@example.invalid"], repo);
  run("git", ["config", "user.name", "Autoreview Test"], repo);
  run("git", ["add", "app"], repo);
  run("git", ["commit", "-m", "baseline"], repo);

  writeFileSync(join(repo, "app", "x", "foo.module.css"), ".a { color: #111; }\n");
  run("git", ["add", "app/x/foo.module.css"], repo);

  const result = spawnSync(
    process.execPath,
    [join(__dirname, "..", "scripts", "ui-scan"), "--root", repo, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.findings, 1);
  assert.equal(report.findings[0].rule, "hardcoded-color");
});

test("ui-scan resolves export-star design-system barrels", () => {
  const repo = mkdtempSync(join(tmpdir(), "autoreview-ui-scan-"));
  mkdirSync(join(repo, "app", "x"), { recursive: true });
  mkdirSync(join(repo, "components", "design-system", "atoms"), { recursive: true });
  writeFileSync(join(repo, "app", "globals.css"), ":root { --color-navy: #001d3d; }\n");
  writeFileSync(join(repo, "components", "design-system", "index.ts"), 'export * from "./atoms/Button";\n');
  writeFileSync(
    join(repo, "components", "design-system", "atoms", "Button.tsx"),
    "export function Button() { return null; }\n",
  );
  writeFileSync(join(repo, "app", "x", "Foo.tsx"), '<button className="cta">Go</button>\n');
  run("git", ["init"], repo);
  run("git", ["config", "user.email", "test@example.invalid"], repo);
  run("git", ["config", "user.name", "Autoreview Test"], repo);

  const result = spawnSync(
    process.execPath,
    [join(__dirname, "..", "scripts", "ui-scan"), "--root", repo, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.ok(report.inventory.atoms.includes("Button"));
  assert.equal(report.findings[0].rule, "reinvented-component");
});

test("ui-scan exits nonzero when git diff scope fails", () => {
  const repo = mkdtempSync(join(tmpdir(), "autoreview-ui-scan-"));
  run("git", ["init"], repo);
  const result = spawnSync(
    process.execPath,
    [join(__dirname, "..", "scripts", "ui-scan"), "--root", repo, "--base", "origin/main", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /origin\/main|git diff/);
});

test("ui-scan --base includes staged and untracked local changes", () => {
  const repo = mkdtempSync(join(tmpdir(), "autoreview-ui-scan-"));
  mkdirSync(join(repo, "app", "x"), { recursive: true });
  mkdirSync(join(repo, "components", "design-system", "atoms"), { recursive: true });
  writeFileSync(join(repo, "app", "globals.css"), ":root { --color-navy: #001d3d; }\n");
  writeFileSync(join(repo, "components", "design-system", "index.ts"), 'export * from "./atoms/Button";\n');
  writeFileSync(
    join(repo, "components", "design-system", "atoms", "Button.tsx"),
    "export function Button() { return null; }\n",
  );
  writeFileSync(join(repo, "app", "x", "foo.module.css"), ".a { color: var(--color-navy); }\n");
  run("git", ["init"], repo);
  run("git", ["config", "user.email", "test@example.invalid"], repo);
  run("git", ["config", "user.name", "Autoreview Test"], repo);
  run("git", ["add", "app", "components"], repo);
  run("git", ["commit", "-m", "baseline"], repo);
  run("git", ["branch", "base"], repo);

  writeFileSync(join(repo, "app", "x", "foo.module.css"), ".a { color: #111; }\n");
  writeFileSync(join(repo, "app", "x", "NewButton.tsx"), '<button className="cta">Go</button>\n');
  run("git", ["add", "app/x/foo.module.css"], repo);

  const result = spawnSync(
    process.execPath,
    [join(__dirname, "..", "scripts", "ui-scan"), "--root", repo, "--base", "base", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.ok(rules(report.findings).includes("hardcoded-color"));
  assert.ok(rules(report.findings).includes("reinvented-component"));
});
