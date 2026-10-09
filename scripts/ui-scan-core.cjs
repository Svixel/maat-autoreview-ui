/**
 * ui-scan core — the static "laziness tells" detectors for autoreview-ui.
 *
 * Pure, dependency-free functions so they can be unit-tested in isolation and
 * reused by the CLI (./ui-scan). The scanner is the CODE half of the skill's
 * "vision finds the symptom, code finds the cause" fusion: it flags the
 * machine-detectable shortcuts an LLM takes — inline styles, hardcoded values
 * where a token exists, raw elements where a design-system atom exists, stacked
 * shadows, style tags, direct Hugeicons, em-dashes — and hands those sites to
 * the vision pass so it knows where to look.
 *
 * Project-aware: token namespaces are derived from the project's globals.css
 * and the atom inventory from the design-system barrel, so suggestions name the
 * real token/atom instead of a guess. Where a rule encodes a convention that a
 * project's documented design system contradicts (e.g. hugeicons-direct in a
 * project whose convention is to render <HugeiconsIcon> directly), the project
 * config lists it in `scan.ignoreRules`; see partitionIgnoredRules.
 */

"use strict";

const CONFIDENCE = { high: 0.9, medium: 0.6, low: 0.3 };

/**
 * Every rule id scanFileContent can emit. Config validation checks
 * `scan.ignoreRules` against this list, so a typo is a config error rather than
 * a silent no-op; a new rule must be added here to be ignorable.
 */
const RULE_IDS = Object.freeze([
  "inline-style-literal",
  "reinvented-component",
  "style-tag",
  "hugeicons-direct",
  "em-dash",
  "hardcoded-color",
  "hardcoded-length",
  "stacked-shadow",
  "hardcoded-shadow",
]);

/**
 * Split findings into the reported ones and those a project's config ignores.
 * Ruleset-agnostic (the RN scanner's findings have the same shape). Every
 * ignored rule is counted, including rules with zero hits, so a report always
 * shows which rules were switched off and how many hits each would have had.
 */
function partitionIgnoredRules(findings, ignoreRules = []) {
  const ignored = new Set(ignoreRules);
  const ignoredByRule = Object.fromEntries([...ignored].sort().map((rule) => [rule, 0]));
  const kept = [];
  for (const finding of findings) {
    if (ignored.has(finding.rule)) ignoredByRule[finding.rule]++;
    else kept.push(finding);
  }
  return { kept, ignoredByRule };
}

/**
 * Return [start, end) of the balanced bracket span that begins at `openIndex`.
 * Skips over string and template literals so a `"}"` inside copy cannot end the
 * span early. Returns null when the source is unbalanced. Shared with the RN
 * scanner.
 */
function balancedSpan(content, openIndex) {
  const pairs = { "{": "}", "(": ")", "[": "]" };
  const open = content[openIndex];
  if (!pairs[open]) return null;
  let depth = 0;
  for (let i = openIndex; i < content.length; i++) {
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
    if (pairs[ch]) depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      if (depth === 0) return [openIndex, i + 1];
    }
  }
  return null;
}

/** Map a raw HTML element to the design-system atom that should replace it. */
const RAW_ELEMENT_ATOMS = {
  button: "Button",
  input: "Input",
  select: "Select",
  textarea: "TextArea",
};

/** Parse `--name:` custom-property declarations out of a globals.css string. */
function deriveTokens(globalsCss) {
  const names = new Set();
  const re = /--([a-z0-9-]+)\s*:/gi;
  let m;
  while ((m = re.exec(globalsCss))) names.add(`--${m[1]}`);
  const has = (prefix) => [...names].some((n) => n.startsWith(prefix));
  return {
    names,
    categories: {
      color: has("--color") || has("--ink") || has("--r4c"),
      space: has("--space") || has("--rhythm"),
      radius: has("--radius"),
      shadow: has("--shadow"),
      fontSize: has("--font-size") || has("--t-"),
    },
  };
}

/**
 * Parse value exports out of a TypeScript/JavaScript barrel.
 *
 * Despite its historic name, this is deliberately a general value-export
 * parser rather than a PascalCase component-name matcher: barrels also expose
 * constants and hooks which are part of the design-system inventory. Type-only
 * exports are excluded, including `type Foo` entries mixed into a value block.
 */
function deriveAtoms(indexTs, resolveExport = null, source = "<inline>", seen = new Set()) {
  const atoms = new Set();
  if (seen.has(source)) return atoms;
  seen.add(source);

  const re = /export\s*\{([^}]*)\}/g;
  let block;
  while ((block = re.exec(indexTs))) {
    for (let entry of block[1].split(",")) {
      entry = entry.trim();
      if (!entry || entry.startsWith("type ")) continue;
      // Handle `Foo as Bar` → exported name is the alias.
      const name = entry.split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) atoms.add(name);
    }
  }

  const directRe = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  let direct;
  while ((direct = directRe.exec(indexTs))) atoms.add(direct[1]);

  const starRe = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
  let star;
  while ((star = starRe.exec(indexTs))) {
    const resolved = resolveExport?.(star[1], source);
    if (!resolved) continue;
    const child =
      typeof resolved === "string"
        ? { content: resolved, source: `${source}:${star[1]}` }
        : resolved;
    for (const atom of deriveAtoms(child.content, resolveExport, child.source, seen)) {
      atoms.add(atom);
    }
  }
  return atoms;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/** Strip `(...)` groups so we can count top-level commas in a CSS value. */
function stripParens(value) {
  let out = "";
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

const SPACING_PROPS =
  /(^|[\s;{])(padding|margin|gap|row-gap|column-gap|border-radius|font-size)(-[a-z]+)?\s*:\s*([^;]+)/gi;

/** Does a CSS value carry a hardcoded length that should be a token? */
function hasHardcodedLength(value) {
  const cleaned = value.replace(/var\([^)]*\)/g, "");
  const lengths = cleaned.match(/-?\d*\.?\d+(px|rem)/gi) || [];
  return lengths.some((l) => {
    const n = parseFloat(l);
    const unit = l.replace(/[-\d.]/g, "").toLowerCase();
    // Idiomatic hairlines / zero are fine.
    if (unit === "px" && (n === 0 || n === 1 || n === 2)) return false;
    if (n === 0) return false;
    return true;
  });
}

/**
 * Scan a single file's full content. `addedLines` (a Set of new-side line
 * numbers) scopes findings to the change; pass null to scan the whole file.
 * `inv` is { tokens, atoms } from deriveTokens/deriveAtoms (optional).
 */
function scanFileContent(filePath, content, addedLines, inv = {}) {
  const atoms = inv.atoms || new Set();
  const tokens = inv.tokens || { categories: {} };
  const findings = [];
  const inScope = (line) => addedLines == null || addedLines.has(line);
  const isDesignSystem = /components\/design-system\//.test(filePath);
  const isTokenSource = /globals\.css$|render\/editorial\.css$|editorial\.css$/.test(
    filePath,
  );
  const isContent = /(^|\/)(content|i18n|locale|locales|messages)\//.test(filePath);
  const pushAtLine = (line, f) => {
    if (inScope(line)) findings.push({ file: filePath, line, ...f });
  };
  const push = (index, f) => {
    const line = lineOf(content, index);
    pushAtLine(line, f);
  };

  const isTsx = /\.(tsx|jsx)$/.test(filePath);
  const isCss = /\.css$/.test(filePath);

  if (isTsx) {
    // 1. Inline style objects with literal values (not pure --custom-prop maps).
    //    The object literal is bounded by bracket balance, not by the next
    //    `}}`: a cast such as `style={{ '--x': v } as React.CSSProperties}` has
    //    no `}}`, and a lazy regex then swallowed the JSX after it.
    const styleRe = /style=\{\{/g;
    let s;
    while ((s = styleRe.exec(content))) {
      const objectStart = s.index + s[0].length - 1;
      const span = balancedSpan(content, objectStart);
      if (!span) continue;
      const bodyStart = objectStart + 1;
      // Keep the closing `}` so a numeric last value (`{ padding: 4 }`) still
      // ends in the `[,}]` the literal pattern expects.
      const body = content.slice(bodyStart, span[1]);
      const literalLines = [];
      const literalRe =
        /#[0-9a-f]{3,8}\b|\b\d+(\.\d+)?px\b|:\s*-?\d+(\.\d+)?\s*[,}]|\brgba?\(|\bhsla?\(/gi;
      let literal;
      while ((literal = literalRe.exec(body))) {
        literalLines.push(lineOf(content, bodyStart + literal.index));
      }
      const literalLine = literalLines.find((line) => inScope(line));
      // A non-custom key is a bare `prop:` not starting with a quote/bracket
      // (which would be a `'--token'` / `['--token']` dynamic passthrough).
      // Whitespace may precede the first key too (`{{ padding: '12px' }}`).
      const hasNonCustomKey = /(^|[,{])\s*(?!['"`[])[a-zA-Z][a-zA-Z0-9]*\s*:/.test(
        body,
      );
      if (literalLine && hasNonCustomKey) {
        pushAtLine(literalLine, {
          rule: "inline-style-literal",
          category: "inline-style",
          confidence: CONFIDENCE.high,
          message: "Inline style with hardcoded values instead of design tokens.",
          suggestion:
            "Move the value into the project's styling layer (a CSS Module class, or a token utility class on Tailwind projects) and use a design token.",
        });
      }
    }

    // 2. Raw interactive elements where a design-system atom exists.
    //    Only flag elements carrying a className — a styled raw element is the
    //    real "reinvented the atom" signal; an unstyled <button onClick> is
    //    usually a legitimate behavior-only control.
    if (!isDesignSystem) {
      const rawRe = /<(button|input|select|textarea)\b([^>]*)>/gi;
      let r;
      while ((r = rawRe.exec(content))) {
        const tag = r[1].toLowerCase();
        const atom = RAW_ELEMENT_ATOMS[tag];
        if (atom && atoms.has(atom) && /\bclassName\b/.test(r[2])) {
          push(r.index, {
            rule: "reinvented-component",
            category: "reinvented-component",
            confidence: CONFIDENCE.medium,
            message: `Styled raw <${tag}> where the design system exports <${atom}>.`,
            suggestion: `Reuse <${atom}> (extend its props/variants before hand-rolling).`,
          });
        }
      }
    }

    // 3. <style> tags / styled-jsx: CSS outside the project's stylesheet layer.
    const tagRe = /<style[\s>]/g;
    let t;
    while ((t = tagRe.exec(content))) {
      push(t.index, {
        rule: "style-tag",
        category: "css-architecture",
        confidence: CONFIDENCE.high,
        message: "Inline <style> tag: CSS written outside the project's stylesheet layer and its tokens.",
        suggestion:
          "Move the rules into the project's stylesheet layer (a co-located CSS Module, or globals.css / token utility classes on Tailwind projects).",
      });
    }

    // 4. Direct Hugeicons instead of the Icon atom.
    const hugeRe = /<HugeiconsIcon\b|from\s+['"]@hugeicons\/react['"]/g;
    let h;
    while ((h = hugeRe.exec(content))) {
      if (isDesignSystem) continue; // the Icon atom itself is allowed.
      push(h.index, {
        rule: "hugeicons-direct",
        category: "reinvented-component",
        confidence: CONFIDENCE.medium,
        message: "Direct Hugeicons usage instead of the project Icon atom.",
        suggestion: "Use the <Icon> atom (keeps currentColor + a11y conventions).",
      });
    }

    // 5. Em-dash slop-tell in JSX (low confidence; skip content/i18n files).
    if (!isContent) {
      const emRe = /—/g;
      let e;
      while ((e = emRe.exec(content))) {
        push(e.index, {
          rule: "em-dash",
          category: "slop-tell",
          confidence: CONFIDENCE.low,
          message: "Em-dash in UI copy (a common LLM tell).",
          suggestion: "Prefer a comma, period, or restructured sentence.",
        });
      }
    }
  }

  if (isCss && !isTokenSource) {
    // 6. Hardcoded colors → token drift.
    const lines = content.split("\n");
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;
      const startIndex = offset;
      offset += line.length + 1;
      if (!inScope(lineNo)) continue;
      const noUrl = line.replace(/url\([^)]*\)/g, "");
      const isShadow = /box-shadow\s*:/.test(line);
      if (
        !isShadow &&
        tokens.categories.color &&
        /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(noUrl) &&
        !/^\s*--/.test(line)
      ) {
        findings.push({
          file: filePath,
          line: lineNo,
          rule: "hardcoded-color",
          category: "token-drift",
          confidence: CONFIDENCE.high,
          message: "Hardcoded color in a component stylesheet.",
          suggestion: "Use a --color-*/--ink-* token.",
        });
      }

      // 7. Hardcoded spacing/radius/font-size lengths.
      SPACING_PROPS.lastIndex = 0;
      let sp;
      while ((sp = SPACING_PROPS.exec(line))) {
        const value = sp[4];
        if (hasHardcodedLength(value)) {
          findings.push({
            file: filePath,
            line: lineNo,
            rule: "hardcoded-length",
            category: "token-drift",
            confidence: CONFIDENCE.medium,
            message: `Hardcoded length in "${sp[2]}${sp[3] || ""}".`,
            suggestion: "Use a --space-*/--radius-*/--font-size-* token.",
          });
          break;
        }
      }

      // 8. Stacked shadows + literal-color shadows.
      const shadowMatch = line.match(/box-shadow\s*:\s*([^;]+)/i);
      if (shadowMatch) {
        const raw = shadowMatch[1];
        if (stripParens(raw).includes(",")) {
          findings.push({
            file: filePath,
            line: lineNo,
            rule: "stacked-shadow",
            category: "stacked-shadow",
            confidence: CONFIDENCE.medium,
            message: "Stacked box-shadow. The system forbids shadow strips.",
            suggestion: "Use a single --shadow-* token; prefer borders/spacing.",
          });
        } else if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(raw) && tokens.categories.shadow) {
          findings.push({
            file: filePath,
            line: lineNo,
            rule: "hardcoded-shadow",
            category: "token-drift",
            confidence: CONFIDENCE.medium,
            message: "Hardcoded shadow color/values.",
            suggestion: "Use a --shadow-* token.",
          });
        }
      }
      void startIndex;
    }
  }

  return findings;
}

module.exports = {
  CONFIDENCE,
  RULE_IDS,
  balancedSpan,
  deriveTokens,
  deriveAtoms,
  partitionIgnoredRules,
  scanFileContent,
  hasHardcodedLength,
  stripParens,
};
