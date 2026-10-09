/**
 * ui-scan core (React Native) — the static "laziness tells" detectors for RN
 * codebases, the rn-stylesheet sibling of ui-scan-core.cjs.
 *
 * Same contract as the web core: pure, dependency-free, one `Finding` shape, so
 * the CLI, the JSON output, and the vision pass are identical across platforms.
 * Only the substrate differs — there is no CSS and no DOM here, so:
 *
 *   globals.css custom properties  → TypeScript token modules (theme/*.ts)
 *   design-system barrel exports   → the component inventory doc's tables
 *   raw <button>/<input> elements  → raw <Pressable>/<TextInput>/<Switch>
 *   :hover / :focus omissions      → missing accessibility props
 *
 * Project-aware in the same way: token values are harvested from the real theme
 * modules and the atom list from the real inventory doc, so a suggestion names
 * the actual token ("use spacing.md") instead of guessing.
 */

"use strict";

const { CONFIDENCE, balancedSpan } = require("./ui-scan-core.cjs");

/**
 * Every rule id scanRnFileContent can emit. Config validation checks
 * `scan.ignoreRules` against this list when `scan.ruleset` is rn-stylesheet;
 * a new rule must be added here to be ignorable.
 */
const RN_RULE_IDS = Object.freeze([
  "rn-hardcoded-color",
  "rn-hardcoded-size",
  "rn-activity-indicator",
  "rn-native-os-ui",
  "rn-emoji",
  "em-dash",
  "rn-a11y-pressable",
  "rn-a11y-image",
  "rn-a11y-switch",
  "rn-reinvented-component",
  "rn-solid-chrome",
]);

/**
 * Raw React Native primitives and the design-system atom that should replace a
 * *styled* use of them. ActivityIndicator is in the map because it names the
 * right replacement, but the dedicated rn-activity-indicator rule owns it (at
 * higher confidence), so rn-reinvented-component skips it to avoid reporting
 * one line twice.
 */
const RN_RAW_ELEMENT_ATOMS = {
  Pressable: "Button",
  TextInput: "Input",
  Switch: "Toggle",
  ActivityIndicator: "Skeleton",
};

const REINVENTABLE = ["Pressable", "TextInput", "Switch"];

/** Touchables that carry the same accessibility obligations as Pressable. */
const PRESSABLE_TAGS = [
  "Pressable",
  "TouchableOpacity",
  "TouchableHighlight",
  "TouchableWithoutFeedback",
];

const HEX_LITERAL_G = /#[0-9a-f]{3,8}\b/gi;

/** Style properties whose literal numbers should come from the scale tokens. */
const SIZE_PROPS =
  /\b(padding|paddingTop|paddingBottom|paddingLeft|paddingRight|paddingHorizontal|paddingVertical|margin|marginTop|marginBottom|marginLeft|marginRight|marginHorizontal|marginVertical|gap|rowGap|columnGap|borderRadius|fontSize)\s*:\s*(-?\d+(?:\.\d+)?)\s*[,}\n]/g;

/**
 * Which token namespace owns each style property. Without this a value lookup
 * is cross-category nonsense — 14 exists in the type scale, but suggesting
 * `typography.sm` for a paddingVertical is worse than suggesting nothing.
 */
function namespaceForSizeProp(prop) {
  if (/^(padding|margin)/.test(prop) || /gap$/i.test(prop) || prop === "gap") return "spacing";
  if (prop === "borderRadius") return "radii";
  if (prop === "fontSize") return "typography.sizes";
  return null;
}

/** Numbers too idiomatic to be token drift (hairlines, zero, 2pt nudges). */
const FREE_NUMBERS = new Set([0, 1, 2]);

// ---------------------------------------------------------------------------
// Inventory derivation
// ---------------------------------------------------------------------------

/** Parse `key: <number>` / `key: { … }` entries out of one object-literal body. */
function objectEntries(body) {
  const entries = [];
  const re = /(^|[{,\s])([A-Za-z_$][A-Za-z0-9_$]*|'[^']+'|"[^"]+"|\d+)\s*:\s*/g;
  let m;
  while ((m = re.exec(body))) {
    const key = m[2].replace(/^['"]|['"]$/g, "");
    const rest = body.slice(re.lastIndex);
    const nested = /^\{/.test(rest.trimStart());
    if (nested) {
      const openAt = re.lastIndex + (rest.length - rest.trimStart().length);
      const span = balancedSpan(body, openAt);
      if (span) {
        entries.push({ key, object: body.slice(span[0] + 1, span[1] - 1) });
        re.lastIndex = span[1];
      }
      continue;
    }
    // `$` matters: callers pass brace-stripped bodies, so the LAST entry of a
    // single-line object has no trailing delimiter (`{ xs: 4, full: 9999 }`).
    const num = /^\s*(-?\d+(?:\.\d+)?)\s*([,}\n]|$)/.exec(rest);
    // Non-numeric entries are recorded WITHOUT a value rather than skipped:
    // isNumericScale needs to see them, otherwise a style preset whose string
    // props were invisible would pass "every entry is numeric" trivially.
    entries.push(num ? { key, value: parseFloat(num[1]) } : { key });
  }
  return entries;
}

/**
 * A nested object counts as a scale only when every entry is numeric. That is
 * what separates `typography.sizes` (a real scale) from `typography.h1` (a
 * style preset carrying fontFamily strings) — harvesting the latter would
 * invent token names like `typography.fontSize` that nobody can import.
 */
function isNumericScale(entries) {
  return entries.length > 0 && entries.every((e) => typeof e.value === "number");
}

/**
 * Harvest the design tokens from the project's theme modules.
 * @param {Array<{path:string,content:string}>} themeFiles
 */
function deriveRnTokens(themeFiles = []) {
  const colors = new Set();
  const scaleNames = new Map();
  const names = new Set();

  const noteScale = (value, name) => {
    if (!Number.isFinite(value)) return;
    if (!scaleNames.has(value)) scaleNames.set(value, []);
    if (!scaleNames.get(value).includes(name)) scaleNames.get(value).push(name);
  };

  for (const file of themeFiles) {
    for (const hex of file.content.match(HEX_LITERAL_G) || []) colors.add(hex.toLowerCase());
    if (/\brgba?\(|\bhsla?\(/i.test(file.content)) colors.add("<functional>");

    // Comments must go before parsing: balancedSpan treats quotes as string
    // delimiters, so one apostrophe in prose ("ChannelListItem's wrapper")
    // swallows the rest of the module and the whole scale is lost.
    const source = maskComments(file.content);

    // Only exported object literals are token namespaces; screens import them
    // by that exact name (`spacing.md`, `typography.sizes.lg`).
    const exportRe = /export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)[^=]*=\s*\{/g;
    let m;
    while ((m = exportRe.exec(source))) {
      const namespace = m[1];
      const span = balancedSpan(source, exportRe.lastIndex - 1);
      if (!span) continue;
      exportRe.lastIndex = span[1];
      for (const entry of objectEntries(source.slice(span[0] + 1, span[1] - 1))) {
        names.add(entry.key);
        if (typeof entry.value === "number") {
          noteScale(entry.value, `${namespace}.${entry.key}`);
          continue;
        }
        if (typeof entry.object !== "string") continue;
        const nested = objectEntries(entry.object);
        if (!isNumericScale(nested)) continue;
        for (const sub of nested) {
          names.add(sub.key);
          noteScale(sub.value, `${namespace}.${entry.key}.${sub.key}`);
        }
      }
    }
  }

  const hasNamespace = (prefix) =>
    [...scaleNames.values()].some((n) => n.some((x) => x.startsWith(prefix)));

  return {
    colors,
    scaleNames,
    names,
    categories: {
      color: colors.size > 0,
      space: hasNamespace("spacing."),
      radius: hasNamespace("radii."),
      fontSize: hasNamespace("typography.sizes."),
    },
  };
}

/**
 * Parse the component-inventory doc's markdown tables into an atom set.
 * Rows look like: `| \`Button\` | props | usage |`.
 */
function deriveRnAtoms(componentsDoc = "") {
  const atoms = new Set();
  const rowRe = /^\s*\|\s*`([A-Z][A-Za-z0-9]*)`\s*\|/gm;
  let m;
  while ((m = rowRe.exec(componentsDoc))) atoms.add(m[1]);
  return atoms;
}

// ---------------------------------------------------------------------------
// Source-shape helpers
// ---------------------------------------------------------------------------

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * Blank out `//` and block comments, preserving every offset and newline so
 * line numbers still match the original file.
 *
 * Every detector runs against the masked text. Without this, prose that merely
 * NAMES a rule trips it — the reference codebase has a doc comment reading
 * "compliant with the no-ActivityIndicator rule", which reported itself as a
 * violation. String literals are deliberately left intact: emoji and em-dashes
 * in UI copy are real findings, the same words in a comment are not.
 */
function maskComments(content) {
  const out = content.split("");
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch !== "/") continue;
    if (content[i + 1] === "/") {
      const end = content.indexOf("\n", i);
      blank(i, end === -1 ? content.length : end);
      i = end === -1 ? content.length : end;
    } else if (content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      const stop = end === -1 ? content.length : end + 2;
      blank(i, stop);
      i = stop - 1;
    }
  }
  return out.join("");
}

/** Every `StyleSheet.create({...})` body in the file, as [start, end) spans. */
function styleSheetSpans(content) {
  const spans = [];
  const re = /StyleSheet\s*\.\s*create\s*\(/g;
  let m;
  while ((m = re.exec(content))) {
    const span = balancedSpan(content, re.lastIndex - 1);
    if (span) spans.push(span);
  }
  return spans;
}

/** Every `style={...}` / `contentContainerStyle={...}` prop value span. */
function inlineStyleSpans(content) {
  const spans = [];
  const re = /\b(?:[a-zA-Z]*[sS]tyle)\s*=\s*\{/g;
  let m;
  while ((m = re.exec(content))) {
    const span = balancedSpan(content, re.lastIndex - 1);
    if (span) spans.push(span);
  }
  return spans;
}

const inSpans = (spans, index) => spans.some(([start, end]) => index >= start && index < end);

/**
 * Extract a whole JSX opening tag starting at `<`, even across many lines.
 * Brace- and quote-aware so `{cond ? ">" : "<"}` inside a prop cannot end it.
 */
function extractJsxTag(content, startIndex) {
  let depth = 0;
  for (let i = startIndex; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return content.slice(startIndex, i + 1);
  }
  return null;
}

/** Every occurrence of `<Tag` in the file, with its full opening tag text. */
function jsxTags(content, tagNames) {
  const out = [];
  const re = new RegExp(`<(${tagNames.join("|")})(?=[\\s/>])`, "g");
  let m;
  while ((m = re.exec(content))) {
    const text = extractJsxTag(content, m.index);
    if (text) out.push({ name: m[1], index: m.index, text });
  }
  return out;
}

/** Escape a JSX element name (may contain dots, e.g. `Animated.View`) for a regex. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * [start, end) of an element's CHILDREN — from just after its opening tag to
 * its matching close tag. Returns null for a self-closing tag (no children) or
 * an unbalanced element.
 */
function elementChildrenSpan(content, openIndex, name, openText) {
  if (/\/>\s*$/.test(openText)) return null;
  const start = openIndex + openText.length;
  const re = new RegExp(`<(/?)${escapeRe(name)}(?=[\\s/>])`, "g");
  re.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = re.exec(content))) {
    if (m[1] === "/") {
      if (--depth === 0) return [start, m.index];
      continue;
    }
    const nested = extractJsxTag(content, m.index);
    if (nested && !/\/>\s*$/.test(nested)) depth++;
  }
  return null;
}

/**
 * Children-spans of every element that carries an `accessibilityLabel`.
 *
 * React Native collapses a labelled element and its subtree into ONE
 * accessibility element, so a decorative child inside it is never announced
 * separately — labelling the child too would double-announce. Without this,
 * the correct pattern (a labelled <Pressable> wrapping an <Image>) is reported
 * as a missing-label defect; measured on the reference codebase, 5 of 9
 * rn-a11y-image findings were exactly that shape.
 *
 * The span deliberately starts AFTER the opening tag, so the labelled element
 * itself is still subject to every other rule.
 */
function labelledAncestorSpans(content) {
  const spans = [];
  const re = /<([A-Z][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)*)(?=[\s/>])/g;
  let m;
  while ((m = re.exec(content))) {
    const text = extractJsxTag(content, m.index);
    if (!text || !/\baccessibilityLabel\s*=/.test(text)) continue;
    const span = elementChildrenSpan(content, m.index, m[1], text);
    if (span) spans.push(span);
  }
  return spans;
}

/** Style keys inside a StyleSheet whose name reads as a screen-chrome surface. */
const CHROME_KEYS = /^(container|wrapper|root|header|footer|bar|tabBar|safeArea|inner)$/i;

/** Does any chrome-ish style key in this file declare a solid backgroundColor? */
function hasSolidChromeSurface(content) {
  for (const [start, end] of styleSheetSpans(content)) {
    const body = content.slice(start, end);
    const keyRe = /(^|[{,\s])([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{/g;
    let m;
    while ((m = keyRe.exec(body))) {
      if (!CHROME_KEYS.test(m[2])) continue;
      const span = balancedSpan(body, keyRe.lastIndex - 1);
      if (span && /\bbackgroundColor\s*:/.test(body.slice(span[0], span[1]))) return m[2];
    }
  }
  return null;
}

/** Map every `StyleSheet.create` key to its own declaration body. */
function styleKeyBodies(content) {
  const bodies = new Map();
  for (const [start, end] of styleSheetSpans(content)) {
    const body = content.slice(start, end);
    const keyRe = /(^|[{,\s])([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*\{/g;
    let m;
    while ((m = keyRe.exec(body))) {
      const span = balancedSpan(body, keyRe.lastIndex - 1);
      if (!span) continue;
      bodies.set(m[2], body.slice(span[0], span[1]));
      keyRe.lastIndex = span[1];
    }
  }
  return bodies;
}

/** Per-primitive test for "this is a rebuild of the atom", not merely styled. */
const REBUILD_TESTS = {
  Pressable: {
    namePattern: /button|btn|cta|submit|action/i,
    // A filled, rounded surface is button chrome; a row or tile is not.
    chrome: (body) => /\bbackgroundColor\s*:/.test(body) && /\bborderRadius\s*:/.test(body),
  },
  TextInput: {
    namePattern: /input|field|textbox/i,
    chrome: (body) => /\b(borderWidth|borderColor|backgroundColor)\s*:/.test(body),
  },
  // Switch is never a generic primitive: any styled use is a rebuilt Toggle.
  Switch: { namePattern: /./, chrome: () => true },
};

/**
 * Does this tag rebuild its atom? Returns a human reason, or null.
 * Resolves every `styles.<key>` the tag references back to its declaration.
 */
function rebuildsAtom(tag, keyBodies) {
  const test = REBUILD_TESTS[tag.name];
  if (!test) return null;
  if (!/\bstyle\s*=/.test(tag.text)) return null;
  const keys = [...tag.text.matchAll(/\bstyles\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)].map(
    (m) => m[1],
  );
  for (const key of keys) {
    if (test.namePattern.test(key)) return `styled as "${key}"`;
    const body = keyBodies.get(key);
    if (body && test.chrome(body)) return `painting its own chrome in "${key}"`;
  }
  // An inline object on the tag itself gets the same chrome test.
  const inline = tag.text.match(/\bstyle\s*=\s*\{[\s\S]*\}/);
  if (inline && test.chrome(inline[0])) return "painting its own chrome inline";
  return null;
}

/** Component names this module exports (const, function, or default function). */
function exportedComponentNames(content) {
  const names = new Set();
  const re =
    /export\s+(?:default\s+)?(?:const|let|var|function|class)\s+([A-Z][A-Za-z0-9]*)/g;
  let m;
  while ((m = re.exec(content))) names.add(m[1]);
  return names;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Scan one React Native source file.
 *
 * @param filePath   repo-relative path (drives the exemptions)
 * @param content    full file text
 * @param addedLines Set of new-side line numbers, or null to scan the whole file
 * @param inv        { tokens, atoms } from deriveRnTokens / deriveRnAtoms
 */
function scanRnFileContent(filePath, source, addedLines, inv = {}) {
  // Every detector below reads `content`, the comment-masked view. Offsets and
  // line numbers are identical to `source`, so findings still point at the file.
  const content = maskComments(source);
  const tokens = inv.tokens || { colors: new Set(), scaleNames: new Map(), categories: {} };
  const atoms = inv.atoms || new Set();
  const findings = [];

  const inScope = (line) => addedLines == null || addedLines.has(line);
  const isThemeSource = /(^|\/)(theme|tokens)\//.test(filePath);
  const isTest = /\.test\.[tj]sx?$|__tests__\//.test(filePath);
  const isAtomSource = /(^|\/)components\/common\//.test(filePath);
  const isContent = /(^|\/)(content|i18n|locale|locales|messages)\//.test(filePath);

  const pushAtLine = (line, f) => {
    if (inScope(line)) findings.push({ file: filePath, line, ...f });
  };
  const push = (index, f) => pushAtLine(lineOf(content, index), f);

  if (isTest) return findings;

  const lines = content.split("\n");
  const styleSpans = [...styleSheetSpans(content), ...inlineStyleSpans(content)];

  // 1. Hardcoded colours inside a style object where a colour token exists.
  if (!isThemeSource && tokens.categories.color) {
    const re = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/gi;
    let m;
    while ((m = re.exec(content))) {
      if (!inSpans(styleSpans, m.index)) continue;
      push(m.index, {
        rule: "rn-hardcoded-color",
        category: "token-drift",
        confidence: CONFIDENCE.high,
        message: `Hardcoded colour "${m[0].replace(/\s+/g, " ")}" in a style object.`,
        suggestion: "Use a colours token from the theme (colors.*), read via useTheme().",
      });
    }
  }

  // 2. Hardcoded spacing / radius / font-size numbers where a scale token exists.
  if (!isThemeSource) {
    SIZE_PROPS.lastIndex = 0;
    let m;
    while ((m = SIZE_PROPS.exec(content))) {
      if (!inSpans(styleSpans, m.index)) continue;
      const value = parseFloat(m[2]);
      if (FREE_NUMBERS.has(Math.abs(value))) continue;
      // No "does this line mention a token?" guard: SIZE_PROPS only ever
      // matches a bare numeric literal, so a tokenised value (`padding:
      // spacing.md`) cannot reach here anyway — while a line-level guard DOES
      // silently drop real drift when one line carries two properties
      // (`{ borderWidth: StyleSheet.hairlineWidth, paddingTop: 8 }`).
      const line = lineOf(content, m.index);
      const namespace = namespaceForSizeProp(m[1]);
      const named = (tokens.scaleNames?.get(value) || []).filter(
        (name) => namespace && name.startsWith(`${namespace}.`),
      );
      pushAtLine(line, {
        rule: "rn-hardcoded-size",
        category: "token-drift",
        confidence: CONFIDENCE.medium,
        message: `Hardcoded ${m[1]}: ${m[2]} in a style object.`,
        suggestion: named.length
          ? `${value} is ${named.join(" / ")} — use the token.`
          : `Use a ${namespace ? `${namespace}.*` : "scale"} token, or add one if the value is new.`,
      });
    }
  }

  // 3. ActivityIndicator — the project standard is a skeleton/animated loader.
  {
    const re = /\bActivityIndicator\b/g;
    let m;
    while ((m = re.exec(content))) {
      push(m.index, {
        rule: "rn-activity-indicator",
        category: "reinvented-component",
        confidence: CONFIDENCE.high,
        message: "ActivityIndicator is the platform spinner, not this design system's loader.",
        suggestion: `Use <${RN_RAW_ELEMENT_ATOMS.ActivityIndicator}> or an animated loader.`,
      });
    }
  }

  // 4. Native OS UI: system alerts and the native return-key affordance.
  {
    const re = /\breturnKeyType\s*=/g;
    let m;
    while ((m = re.exec(content))) {
      push(m.index, {
        rule: "rn-native-os-ui",
        category: "inconsistency",
        confidence: CONFIDENCE.high,
        message: "returnKeyType renders native OS keyboard chrome.",
        suggestion: "Drive submission from the app's own UI instead.",
      });
    }
    const importsAlert = /import\s*\{[^}]*\bAlert\b[^}]*\}\s*from\s*['"]react-native['"]/.test(
      content,
    );
    if (importsAlert) {
      const alertRe = /\bAlert\s*\.\s*alert\s*\(/g;
      let a;
      while ((a = alertRe.exec(content))) {
        push(a.index, {
          rule: "rn-native-os-ui",
          category: "inconsistency",
          confidence: CONFIDENCE.high,
          message: "Native Alert dialog. This project uses its own dialog UI.",
          suggestion: "Use the custom dialog components (useDialog) instead.",
        });
      }
    }
  }

  // 5. Emoji in source — the system uses an icon library, never emoji.
  if (!isContent) {
    const re = /\p{Extended_Pictographic}/gu;
    let m;
    while ((m = re.exec(content))) {
      push(m.index, {
        rule: "rn-emoji",
        category: "slop-tell",
        confidence: CONFIDENCE.high,
        message: `Emoji "${m[0]}" in source.`,
        suggestion: "Use a HugeIcons glyph via <HugeiconsIcon icon={...} />.",
      });
    }
  }

  // 6. Em-dash slop-tell (same rule and confidence as the web core).
  if (!isContent) {
    const re = /—/g;
    let m;
    while ((m = re.exec(content))) {
      push(m.index, {
        rule: "em-dash",
        category: "slop-tell",
        confidence: CONFIDENCE.low,
        message: "Em-dash in UI copy (a common LLM tell).",
        suggestion: "Prefer a comma, period, or restructured sentence.",
      });
    }
  }

  // 7. Accessibility props on touchables, images, and switches.
  //
  //    HIDDEN means the author has deliberately taken the element OUT of the
  //    accessibility tree; demanding a label on it is demanding a label nothing
  //    can read. `accessibilityRole="none"`/`"presentation"` is the RN spelling
  //    of that intent and must be honoured alongside accessible={false} — a
  //    stop-propagation backdrop that declares role="none" is correct code.
  const HIDDEN_FROM_A11Y =
    /\{\.\.\.|accessible\s*=\s*\{\s*false|accessibilityElementsHidden|importantForAccessibility\s*=\s*["'](?:no|no-hide-descendants)["']|accessibilityRole\s*=\s*["'](?:none|presentation)["']/;
  const labelledSpans = labelledAncestorSpans(content);

  for (const tag of jsxTags(content, PRESSABLE_TAGS)) {
    if (HIDDEN_FROM_A11Y.test(tag.text)) continue;
    const missing = [];
    if (!/\baccessibilityRole\s*=/.test(tag.text)) missing.push('accessibilityRole="button"');
    if (!/\baccessibilityLabel\s*=/.test(tag.text)) missing.push("accessibilityLabel");
    if (!missing.length) continue;
    push(tag.index, {
      rule: "rn-a11y-pressable",
      category: "a11y",
      confidence: CONFIDENCE.medium,
      message: `<${tag.name}> is missing ${missing.join(" and ")}.`,
      suggestion: "Every pressable needs a role and a label so VoiceOver can announce it.",
    });
  }

  for (const tag of jsxTags(content, ["Image", "ImageBackground"])) {
    if (HIDDEN_FROM_A11Y.test(tag.text)) continue;
    // Absorbed into a labelled ancestor's single announcement — see
    // labelledAncestorSpans. Only passive elements get this pass: a NESTED
    // pressable is still its own focus target and still needs its own label.
    if (inSpans(labelledSpans, tag.index)) continue;
    const missing = [];
    if (!/\baccessibilityRole\s*=/.test(tag.text)) missing.push('accessibilityRole="image"');
    if (!/\baccessibilityLabel\s*=/.test(tag.text)) missing.push("accessibilityLabel");
    if (!missing.length) continue;
    push(tag.index, {
      rule: "rn-a11y-image",
      category: "a11y",
      confidence: CONFIDENCE.medium,
      message: `<${tag.name}> is missing ${missing.join(" and ")}.`,
      suggestion:
        "Add a descriptive label, or mark the image decorative with accessible={false}.",
    });
  }

  for (const tag of jsxTags(content, ["Switch"])) {
    if (/\{\.\.\./.test(tag.text)) continue;
    const missing = [];
    if (!/accessibilityRole\s*=\s*["']switch["']/.test(tag.text)) {
      missing.push('accessibilityRole="switch"');
    }
    if (!/\baccessibilityState\s*=/.test(tag.text)) missing.push("accessibilityState={{ checked }}");
    if (!missing.length) continue;
    push(tag.index, {
      rule: "rn-a11y-switch",
      category: "a11y",
      confidence: CONFIDENCE.medium,
      message: `<Switch> is missing ${missing.join(" and ")}.`,
      suggestion: "Switches must expose their checked state to assistive tech.",
    });
  }

  // 8. A raw primitive that is REBUILDING an atom the design system exports.
  //
  //    Calibration note: the web core keys this off "raw <button> carrying a
  //    className", because in a DOM app a styled <button> almost always means a
  //    hand-rolled button. That inference does NOT transfer. In React Native,
  //    Pressable is the universal tap primitive — list rows, cards, tiles,
  //    avatars and backdrops are all styled Pressables — so "styled" flags most
  //    of an app (measured: 80 hits, all false, on the reference codebase).
  //    The real tell is a Pressable painting BUTTON CHROME: a filled, rounded
  //    surface, or a style key literally named like a button.
  if (!isAtomSource) {
    const keyBodies = styleKeyBodies(content);
    // Building a button out of a raw Pressable IS what a button atom does, so a
    // file that ships one must not be told to "reuse <Button>". The
    // components/common/ path test misses atoms catalogued from a components
    // doc that live in feature folders (measured: chat/ImagePickerButton.tsx
    // and chat/ScrollToBottomButton.tsx were both reported for reinventing
    // <Button>). Match on the atom CLASS, not mere presence in the catalogue:
    // that doc lists every component, so exempting any catalogued export would
    // silence the rule almost everywhere (measured: 22 findings -> 10, taking
    // real ones like ReportSheet's "submitButton" with it).
    const exportedAtoms = [...exportedComponentNames(content)].filter((n) => atoms.has(n));
    const shipsAtomOfClass = (atom) => exportedAtoms.some((n) => n.endsWith(atom));
    for (const tag of jsxTags(content, REINVENTABLE)) {
      const atom = RN_RAW_ELEMENT_ATOMS[tag.name];
      if (!atom || !atoms.has(atom)) continue;
      if (shipsAtomOfClass(atom)) continue;
      const reason = rebuildsAtom(tag, keyBodies);
      if (!reason) continue;
      push(tag.index, {
        rule: "rn-reinvented-component",
        category: "reinvented-component",
        confidence: CONFIDENCE.medium,
        message: `Raw <${tag.name}> ${reason} where the design system exports <${atom}>.`,
        suggestion: `Reuse <${atom}> (extend its props/variants before hand-rolling).`,
      });
    }
  }

  // 9. Solid screen chrome. Headers, footers and tab bars in this system sit on
  //    a progressive blur so content scrolls under them; a flat backgroundColor
  //    is the tell that the shared chrome treatment was skipped.
  if (/(^|\/)components\//.test(filePath) && !isAtomSourceChromePrimitive(filePath)) {
    const chromeNames = [...exportedComponentNames(content)].filter((n) =>
      /(Header|Footer|TabBar)$/.test(n),
    );
    const usesBlur = /ProgressiveBlurBackdrop|StickyFooter|BlurView/.test(content);
    if (chromeNames.length && !usesBlur) {
      const key = hasSolidChromeSurface(content);
      if (key) {
        const inContent = chromeNames.every((n) => /^Section/.test(n));
        const index = content.indexOf(`${key}:`);
        push(index < 0 ? 0 : index, {
          rule: "rn-solid-chrome",
          category: "inconsistency",
          confidence: inContent ? CONFIDENCE.low : CONFIDENCE.medium,
          message:
            `${chromeNames.join("/")} paints a solid backgroundColor on "${key}" and uses ` +
            "no blur backdrop.",
          suggestion:
            "Use <StickyFooter blur> or <ProgressiveBlurBackdrop variant=\"header|footer|tabBar\"> " +
            "so content scrolls under the chrome.",
        });
      }
    }
  }

  return findings;
}

/** The blur primitives themselves are allowed to define their own surfaces. */
function isAtomSourceChromePrimitive(filePath) {
  return /(ProgressiveBlurBackdrop|StickyFooter)/.test(filePath);
}

module.exports = {
  RN_RAW_ELEMENT_ATOMS,
  RN_RULE_IDS,
  // Re-exported: the helper now lives in ui-scan-core.cjs so both rulesets
  // bound JSX expressions the same way.
  balancedSpan,
  deriveRnAtoms,
  deriveRnTokens,
  extractJsxTag,
  scanRnFileContent,
  styleSheetSpans,
};
