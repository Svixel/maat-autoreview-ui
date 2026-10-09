"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  RN_RAW_ELEMENT_ATOMS,
  balancedSpan,
  deriveRnAtoms,
  deriveRnTokens,
  extractJsxTag,
  scanRnFileContent,
  styleSheetSpans,
} = require("../scripts/ui-scan-core-rn.cjs");

const UI_SCAN = join(__dirname, "..", "scripts", "ui-scan");

// Token modules shaped like a real RN theme: flat scales, a nested numeric
// scale (typography.sizes) and a nested STYLE PRESET (typography.h1) that must
// NOT be harvested as tokens.
const THEME_FILES = [
  {
    path: "spacing.ts",
    content: `export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
};
`,
  },
  {
    path: "radii.ts",
    content: `export const radii = { xs: 4, sm: 8, md: 12, lg: 16, full: 9999 };\n`,
  },
  {
    path: "typography.ts",
    content: `export const typography = {
  sizes: { xs: 12, sm: 14, md: 16 },
  weights: { normal: '400', bold: '700' },
  h1: { fontFamily: 'Lora_700Bold', fontSize: 36, lineHeight: 44 },
};
`,
  },
  {
    path: "colors.ts",
    content: `export const brown = { 500: '#7A6552', 900: '#211914' };
export const colors = { primary: '#7A6552', overlay: 'rgba(0,0,0,0.4)' };
`,
  },
];

const COMPONENTS_DOC = `# Component Inventory

| Component | Props | Usage |
|-----------|-------|-------|
| \`Button\` | \`title, onPress\` | Primary buttons |
| \`Input\` | \`value, onChangeText\` | Text inputs |
| \`Toggle\` | \`value, onValueChange\` | On/off switches |
| \`Skeleton\` | \`width?, height?\` | Loading shimmer |
| \`StickyFooter\` | \`blur\` | Bottom CTA standard |
| \`ScrollToBottomButton\` | \`onPress\` | Jump-to-latest affordance |
`;

const tokens = deriveRnTokens(THEME_FILES);
const atoms = deriveRnAtoms(COMPONENTS_DOC);
const inv = { tokens, atoms };

const rules = (findings) => findings.map((f) => f.rule);
const scan = (path, content, added = null) => scanRnFileContent(path, content, added, inv);
const find = (findings, rule) => findings.filter((f) => f.rule === rule);

// --- inventory derivation ----------------------------------------------------

test("deriveRnTokens harvests flat and nested numeric scales", () => {
  assert.deepEqual(tokens.scaleNames.get(16), [
    "spacing.md",
    "radii.lg",
    "typography.sizes.md",
  ]);
  assert.deepEqual(tokens.scaleNames.get(9999), ["radii.full"]);
  assert.ok(tokens.categories.space && tokens.categories.radius && tokens.categories.fontSize);
});

test("deriveRnTokens ignores style presets and non-numeric maps", () => {
  // typography.h1 is a preset (fontFamily string), not a scale.
  assert.equal(tokens.scaleNames.get(36), undefined, "36 came from the h1 preset");
  assert.equal(tokens.scaleNames.get(44), undefined, "44 came from the h1 preset");
  for (const names of tokens.scaleNames.values()) {
    for (const name of names) {
      assert.doesNotMatch(name, /typography\.(fontSize|lineHeight|h1)/);
    }
  }
});

test("deriveRnTokens survives apostrophes and backticks in comments", () => {
  // Regression: balancedSpan treats a quote as a string delimiter, so a single
  // apostrophe in prose used to swallow the rest of the module and drop the
  // entire scale (the real theme has "// ChannelListItem's wrapper").
  const harvested = deriveRnTokens([
    {
      path: "sizes.ts",
      content: `export const sizes = {
  // ChannelListItem's wrapper shares this with the \`avatar\` token.
  buttonHeight: 44,
  avatar: { sm: 32, list: 60 },
};
`,
    },
  ]);
  assert.deepEqual(harvested.scaleNames.get(44), ["sizes.buttonHeight"]);
  assert.deepEqual(harvested.scaleNames.get(60), ["sizes.avatar.list"]);
});

test("deriveRnTokens harvests colour literals", () => {
  assert.ok(tokens.colors.has("#7a6552"));
  assert.ok(tokens.colors.has("<functional>"), "rgba() should register a colour source");
  assert.equal(tokens.categories.color, true);
});

test("deriveRnAtoms parses the component inventory tables", () => {
  assert.ok(atoms.has("Button") && atoms.has("Input") && atoms.has("Toggle"));
  assert.ok(atoms.has("StickyFooter"));
  assert.equal(atoms.has("Component"), false, "the table header must not become an atom");
});

// --- source-shape helpers ----------------------------------------------------

test("balancedSpan survives braces inside string literals", () => {
  const src = `const a = { label: "}{", nested: { x: 1 } };`;
  const span = balancedSpan(src, src.indexOf("{"));
  assert.equal(src.slice(span[0], span[1]), `{ label: "}{", nested: { x: 1 } }`);
});

test("extractJsxTag spans multiple lines and brace-wrapped props", () => {
  const src = `<Pressable\n  onPress={() => go({ a: 1 })}\n  style={styles.x}\n>\n  <Text/>\n</Pressable>`;
  const tag = extractJsxTag(src, 0);
  assert.match(tag, /style=\{styles\.x\}/);
  assert.ok(tag.endsWith(">"));
  assert.equal(tag.includes("<Text/>"), false, "must stop at the opening tag");
});

test("styleSheetSpans finds the create() body", () => {
  const src = `const styles = StyleSheet.create({ a: { color: 'red' } });`;
  const spans = styleSheetSpans(src);
  assert.equal(spans.length, 1);
  assert.match(src.slice(...spans[0]), /^\(\{ a:/);
});

// --- token drift -------------------------------------------------------------

test("hardcoded colour in a StyleSheet is flagged, theme sources are not", () => {
  const src = `const styles = StyleSheet.create({ box: { backgroundColor: '#ff0000' } });`;
  assert.deepEqual(rules(scan("src/components/Box.tsx", src)), ["rn-hardcoded-color"]);
  assert.deepEqual(rules(scan("src/theme/colors.ts", src)), []);
});

test("hardcoded colour inside an inline style array is flagged", () => {
  const src = `export const A = () => <View style={[styles.a, { borderColor: 'rgba(0,0,0,0.4)' }]} />;`;
  const findings = find(scan("src/components/A.tsx", src), "rn-hardcoded-color");
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /rgba\(0,0,0,0\.4\)/);
});

test("theme token references are NOT flagged as hardcoded colours", () => {
  const src = `const styles = StyleSheet.create({ box: { backgroundColor: colors.primary } });`;
  assert.deepEqual(rules(scan("src/components/Box.tsx", src)), []);
});

test("hardcoded size is flagged and names the same-category token", () => {
  const src = `const styles = StyleSheet.create({ box: { padding: 16, fontSize: 12 } });`;
  const findings = find(scan("src/components/Box.tsx", src), "rn-hardcoded-size");
  assert.equal(findings.length, 2);
  assert.match(findings[0].suggestion, /spacing\.md/);
  assert.match(findings[1].suggestion, /typography\.sizes\.xs/);
});

test("hardcoded size never suggests a cross-category token", () => {
  // 14 exists only in the type scale; suggesting it for padding is nonsense.
  const src = `const styles = StyleSheet.create({ box: { paddingVertical: 14 } });`;
  const findings = find(scan("src/components/Box.tsx", src), "rn-hardcoded-size");
  assert.equal(findings.length, 1);
  assert.doesNotMatch(findings[0].suggestion, /typography/);
  assert.match(findings[0].suggestion, /spacing\.\*/);
});

test("token-referencing lines and 0/1/2 literals are NOT flagged as sizes", () => {
  const src = `const styles = StyleSheet.create({
  a: { padding: spacing.md },
  b: { margin: 0, gap: 2, borderRadius: 1 },
  c: { borderWidth: StyleSheet.hairlineWidth, paddingTop: 8 },
});`;
  const findings = find(scan("src/components/Box.tsx", src), "rn-hardcoded-size");
  assert.deepEqual(
    findings.map((f) => f.message),
    ["Hardcoded paddingTop: 8 in a style object."],
  );
});

test("numbers outside style objects are NOT flagged", () => {
  const src = `const timeout = 500;\nconst limits = { padding: 40 };\n`;
  assert.deepEqual(rules(scan("src/lib/config.tsx", src)), []);
});

// --- project UI rules --------------------------------------------------------

test("ActivityIndicator is flagged in code but not in comments", () => {
  const code = `import { ActivityIndicator } from 'react-native';`;
  assert.deepEqual(rules(scan("src/screens/S.tsx", code)), ["rn-activity-indicator"]);

  const comment = `/** Loading uses Skeleton placeholders (never ActivityIndicator). */\nexport const S = () => null;`;
  assert.deepEqual(rules(scan("src/screens/S.tsx", comment)), []);
});

test("native OS UI: returnKeyType and react-native Alert are flagged", () => {
  const src = `import { Alert, TextInput } from 'react-native';
export const F = () => {
  Alert.alert('Nope');
  return <TextInput returnKeyType="done" />;
};`;
  const findings = find(scan("src/screens/F.tsx", src), "rn-native-os-ui");
  assert.equal(findings.length, 2);
});

test("an Alert not imported from react-native is NOT flagged", () => {
  const src = `import { Alert } from './ui/Alert';\nexport const F = () => { Alert.alert('hi'); };`;
  assert.deepEqual(rules(scan("src/screens/F.tsx", src)), []);
});

test("emoji is flagged in UI copy but not in comments", () => {
  const copy = `export const A = () => <Text>Booked 🎉</Text>;`;
  assert.deepEqual(rules(scan("src/components/A.tsx", copy)), ["rn-emoji"]);
  const comment = `// celebrate 🎉\nexport const A = () => null;`;
  assert.deepEqual(rules(scan("src/components/A.tsx", comment)), []);
});

test("em-dash is a low-confidence slop tell, skipped in content dirs", () => {
  const src = `export const A = () => <Text>Acme — a recipe app</Text>;`;
  assert.deepEqual(rules(scan("src/components/A.tsx", src)), ["em-dash"]);
  assert.deepEqual(rules(scan("src/content/A.tsx", src)), []);
});

// --- accessibility -----------------------------------------------------------

test("pressables missing role/label are flagged; complete ones are not", () => {
  const bad = `export const A = () => <Pressable onPress={go}><Text>Go</Text></Pressable>;`;
  assert.deepEqual(rules(scan("src/components/A.tsx", bad)), ["rn-a11y-pressable"]);

  const good = `export const A = () => (
  <Pressable onPress={go} accessibilityRole="button" accessibilityLabel="Go">
    <Text>Go</Text>
  </Pressable>
);`;
  assert.deepEqual(rules(scan("src/components/A.tsx", good)), []);
});

test("TouchableOpacity carries the same accessibility obligation", () => {
  const src = `export const A = () => <TouchableOpacity onPress={go} />;`;
  assert.deepEqual(rules(scan("src/components/A.tsx", src)), ["rn-a11y-pressable"]);
});

test("a spread-props pressable is NOT flagged (the props are unknowable)", () => {
  const src = `export const A = (props) => <Pressable {...props} onPress={go} />;`;
  assert.deepEqual(rules(scan("src/components/A.tsx", src)), []);
});

test("images need a label unless explicitly decorative", () => {
  const bad = `export const A = () => <Image source={s} style={styles.img} />;`;
  assert.deepEqual(rules(scan("src/components/A.tsx", bad)), ["rn-a11y-image"]);

  const decorative = `export const A = () => <Image source={s} accessible={false} />;`;
  assert.deepEqual(rules(scan("src/components/A.tsx", decorative)), []);

  const labelled = `export const A = () => <Image source={s} accessibilityRole="image" accessibilityLabel="Venue" />;`;
  assert.deepEqual(rules(scan("src/components/A.tsx", labelled)), []);
});

test("an element hidden from the a11y tree is not asked for a label", () => {
  // accessibilityRole="none" is the RN spelling of "this is not an
  // accessibility element" — the stop-propagation backdrop inside a dialog.
  // Demanding a label on it demands a label nothing can read.
  const roleNone = `export const A = () => (
  <Pressable onPress={(e) => e.stopPropagation()} accessibilityRole="none">
    <Text>Body</Text>
  </Pressable>
);`;
  assert.deepEqual(rules(scan("src/components/A.tsx", roleNone)), []);

  const presentation = `export const A = () => <Image source={s} accessibilityRole="presentation" />;`;
  assert.deepEqual(rules(scan("src/components/A.tsx", presentation)), []);

  const androidHidden = `export const A = () => <Image source={s} importantForAccessibility="no-hide-descendants" />;`;
  assert.deepEqual(rules(scan("src/components/A.tsx", androidHidden)), []);
});

test("an image inside a labelled ancestor is NOT flagged (one announcement)", () => {
  // RN collapses a labelled element and its subtree into a single a11y
  // element, so labelling the child too would double-announce.
  const wrapped = `export const A = () => (
  <Pressable onPress={go} accessibilityRole="button" accessibilityLabel="Open event">
    <Image source={s} style={styles.thumb} />
  </Pressable>
);`;
  assert.deepEqual(rules(scan("src/components/A.tsx", wrapped)), []);

  // Same shape, but the ancestor closes BEFORE the image: still a real finding.
  const sibling = `export const A = () => (
  <View>
    <Pressable onPress={go} accessibilityRole="button" accessibilityLabel="Open event" />
    <Image source={s} style={styles.thumb} />
  </View>
);`;
  assert.deepEqual(rules(scan("src/components/A.tsx", sibling)), ["rn-a11y-image"]);

  // The labelled ancestor itself is still subject to every other rule.
  const nestedSameTag = `export const A = () => (
  <View accessibilityLabel="Card">
    <View>
      <Image source={s} />
    </View>
  </View>
);`;
  assert.deepEqual(rules(scan("src/components/A.tsx", nestedSameTag)), []);

  // A nested PRESSABLE is its own focus target and still needs its own label.
  const nestedPressable = `export const A = () => (
  <Pressable onPress={go} accessibilityRole="button" accessibilityLabel="Row">
    <Pressable onPress={remove} />
  </Pressable>
);`;
  assert.deepEqual(rules(scan("src/components/A.tsx", nestedPressable)), ["rn-a11y-pressable"]);
});

test("switches must expose role and checked state", () => {
  const bad = `export const A = () => <Switch value={v} onValueChange={f} />;`;
  assert.ok(rules(scan("src/components/A.tsx", bad)).includes("rn-a11y-switch"));

  const good = `export const A = () => (
  <Switch value={v} onValueChange={f} accessibilityRole="switch" accessibilityState={{ checked: v }} />
);`;
  assert.deepEqual(rules(scan("src/components/A.tsx", good)), []);
});

// --- reinvented atoms --------------------------------------------------------
//
// The discriminator is button CHROME, not merely "has a style" — in RN,
// Pressable is the universal tap primitive, so "styled" describes most of an app.

test("a Pressable painting button chrome is flagged as a reinvented Button", () => {
  // The style key is deliberately NOT button-ish, so only the chrome test
  // (filled + rounded) can produce this finding.
  const src = `export const A = () => <Pressable style={styles.joinSurface}><Text>Join</Text></Pressable>;
const styles = StyleSheet.create({
  joinSurface: { backgroundColor: colors.primary, borderRadius: radii.md, padding: spacing.md },
});`;
  const findings = find(scan("src/components/A.tsx", src), "rn-reinvented-component");
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /painting its own chrome in "joinSurface"/);
});

test("a Pressable with a button-ish style name is flagged", () => {
  const src = `export const A = () => <Pressable style={styles.submitButton} />;
const styles = StyleSheet.create({ submitButton: { padding: spacing.sm } });`;
  const findings = find(scan("src/components/A.tsx", src), "rn-reinvented-component");
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /styled as "submitButton"/);
});

test("a styled list row Pressable is NOT a reinvented Button", () => {
  // The regression that made this rule useful: rows, cards and tiles are all
  // styled Pressables and must stay silent.
  const src = `export const Row = () => <Pressable style={styles.row} onPress={open} />;
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm },
});`;
  assert.deepEqual(find(scan("src/components/Row.tsx", src), "rn-reinvented-component"), []);
});

test("reinvention is not reported inside the atom source folder", () => {
  const src = `export const A = () => <Pressable style={styles.button} />;
const styles = StyleSheet.create({ button: { backgroundColor: c, borderRadius: 8 } });`;
  assert.deepEqual(
    find(scan("src/components/common/Button.tsx", src), "rn-reinvented-component"),
    [],
  );
});

test("a catalogued button atom outside components/common is not told to reuse Button", () => {
  // Atoms come from a components DOC, so they routinely live in feature
  // folders. Building a button out of a raw Pressable is what a button atom
  // does — flagging it reports the design system for being the design system.
  const src = `const ScrollToBottomButtonComponent = () => <Pressable style={styles.button} />;
export const ScrollToBottomButton = memo(ScrollToBottomButtonComponent);
const styles = StyleSheet.create({ button: { backgroundColor: c, borderRadius: 20 } });`;
  assert.deepEqual(
    find(scan("src/components/chat/ScrollToBottomButton.tsx", src), "rn-reinvented-component"),
    [],
  );

  // The exemption is keyed on the atom CLASS, not on mere presence in the
  // catalogue — a catalogued NON-button that hand-rolls a button still reports.
  const sheet = `export const StickyFooter = () => <Pressable style={styles.submitButton} />;
const styles = StyleSheet.create({ submitButton: { backgroundColor: c, borderRadius: 20 } });`;
  assert.deepEqual(
    rules(find(scan("src/components/chat/StickyFooter.tsx", sheet), "rn-reinvented-component")),
    ["rn-reinvented-component"],
  );
});

test("any styled raw Switch is a reinvented Toggle", () => {
  const src = `export const A = () => (
  <Switch style={styles.s} accessibilityRole="switch" accessibilityState={{ checked: v }} />
);
const styles = StyleSheet.create({ s: { margin: spacing.xs } });`;
  const findings = find(scan("src/components/A.tsx", src), "rn-reinvented-component");
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /<Toggle>/);
});

test("RN_RAW_ELEMENT_ATOMS maps the primitives to their atoms", () => {
  assert.equal(RN_RAW_ELEMENT_ATOMS.Pressable, "Button");
  assert.equal(RN_RAW_ELEMENT_ATOMS.TextInput, "Input");
  assert.equal(RN_RAW_ELEMENT_ATOMS.Switch, "Toggle");
  assert.equal(RN_RAW_ELEMENT_ATOMS.ActivityIndicator, "Skeleton");
});

// --- solid chrome ------------------------------------------------------------

test("a header painting a solid background with no blur backdrop is flagged", () => {
  const src = `export const ProfileHeader = () => <View style={styles.container} />;
const styles = StyleSheet.create({
  container: { backgroundColor: colors.background, paddingTop: spacing.md },
});`;
  const findings = find(scan("src/components/profile/ProfileHeader.tsx", src), "rn-solid-chrome");
  assert.equal(findings.length, 1);
  assert.match(findings[0].suggestion, /ProgressiveBlurBackdrop|StickyFooter/);
});

test("chrome using the blur primitives is NOT flagged", () => {
  const src = `import { StickyFooter } from '../common/StickyFooter';
export const CheckoutFooter = () => <StickyFooter blur><View style={styles.container} /></StickyFooter>;
const styles = StyleSheet.create({ container: { backgroundColor: colors.background } });`;
  assert.deepEqual(
    find(scan("src/components/checkout/CheckoutFooter.tsx", src), "rn-solid-chrome"),
    [],
  );
});

test("a header with no background colour is NOT flagged", () => {
  // Matches how the reference codebase's real headers are written.
  const src = `export const EventHeader = () => <View style={styles.container} />;
const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.md, gap: spacing.sm },
});`;
  assert.deepEqual(find(scan("src/components/event/EventHeader.tsx", src), "rn-solid-chrome"), []);
});

test("an in-content Section header is reported at low confidence", () => {
  const src = `export const SectionHeader = () => <View style={styles.container} />;
const styles = StyleSheet.create({ container: { backgroundColor: colors.surface } });`;
  const findings = find(scan("src/components/common/SectionHeader.tsx", src), "rn-solid-chrome");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].confidence, 0.3);
});

test("non-chrome components are never flagged as solid chrome", () => {
  const src = `export const EventCard = () => <View style={styles.container} />;
const styles = StyleSheet.create({ container: { backgroundColor: colors.surface } });`;
  assert.deepEqual(find(scan("src/components/event/EventCard.tsx", src), "rn-solid-chrome"), []);
});

// --- diff scoping ------------------------------------------------------------

test("addedLines scoping limits findings to the changed line", () => {
  const src = `const styles = StyleSheet.create({
  a: { backgroundColor: '#111111' },
  b: { backgroundColor: '#222222' },
});`;
  const all = scan("src/components/A.tsx", src);
  assert.equal(all.length, 2);
  const scoped = scan("src/components/A.tsx", src, new Set([3]));
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].line, 3);
});

test("test files are skipped entirely", () => {
  const src = `import { ActivityIndicator } from 'react-native';`;
  assert.deepEqual(scan("src/components/__tests__/A.test.tsx", src), []);
});

// --- CLI integration ---------------------------------------------------------

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "ui-scan-rn-"));
  mkdirSync(join(root, "theme"), { recursive: true });
  mkdirSync(join(root, "mobile", "components"), { recursive: true });
  mkdirSync(join(root, "web"), { recursive: true });
  for (const file of THEME_FILES) {
    writeFileSync(join(root, "theme", file.path), file.content);
  }
  writeFileSync(join(root, "COMPONENTS.md"), COMPONENTS_DOC);
  writeFileSync(
    join(root, "mobile", "components", "Box.tsx"),
    `const styles = StyleSheet.create({ box: { backgroundColor: '#ff0000' } });\n`,
  );
  writeFileSync(
    join(root, "web", "Widget.tsx"),
    `const styles = StyleSheet.create({ box: { backgroundColor: '#00ff00' } });\n`,
  );
  return root;
}

function scanCli(root, args) {
  const result = spawnSync(process.execPath, [UI_SCAN, "--root", root, "--json", ...args], {
    encoding: "utf8",
  });
  return JSON.parse(result.stdout);
}

test("ui-scan --ruleset rn-stylesheet uses the RN inventory and rules", () => {
  const root = makeRepo();
  const report = scanCli(root, [
    "--ruleset",
    "rn-stylesheet",
    "--tokens-dir",
    "theme",
    "--components-doc",
    "COMPONENTS.md",
    "--all",
  ]);
  assert.equal(report.ruleset, "rn-stylesheet");
  assert.ok(report.inventory.atoms.includes("Button"));
  assert.deepEqual(Object.keys(report.summary.byRule), ["rn-hardcoded-color"]);
  assert.equal(report.summary.findings, 2, "both mobile and web tsx are RN files without --include");
});

test("ui-scan --include restricts the scan to path prefixes", () => {
  const root = makeRepo();
  const report = scanCli(root, [
    "--ruleset",
    "rn-stylesheet",
    "--tokens-dir",
    "theme",
    "--components-doc",
    "COMPONENTS.md",
    "--include",
    "mobile",
    "--all",
  ]);
  assert.equal(report.summary.findings, 1);
  assert.equal(report.findings[0].file, "mobile/components/Box.tsx");
});

test("ui-scan rejects an unknown ruleset", () => {
  const root = makeRepo();
  const result = spawnSync(process.execPath, [UI_SCAN, "--root", root, "--ruleset", "nope"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown --ruleset "nope"/);
});

test("the web ruleset stays the default and ignores RN flags", () => {
  const root = makeRepo();
  const report = scanCli(root, ["--all"]);
  assert.equal(report.ruleset, "web-css");
});
