/**
 * Route-shell policy resolver.
 *
 * This is intentionally a small, dependency-free static resolver. It proves a
 * shell primitive at the route boundary without pretending to understand an
 * unbounded React tree: the route itself and one rendered component hop count;
 * a primitive found farther down is reported as unresolved, never passed.
 */

"use strict";

const { existsSync, readFileSync, statSync } = require("node:fs");
const { basename, dirname, extname, isAbsolute, join, relative, resolve } = require("node:path");
const { deriveAtoms } = require("./ui-scan-core.cjs");

const MODULE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx"];

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

function globToRegExp(glob) {
  let pattern = "^";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          pattern += "(?:.*/)?";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else {
      pattern += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`);
}

function matchesAny(route, globs) {
  return globs.some((glob) => globToRegExp(glob).test(route));
}

/** Blank comments, and optionally strings, without moving source offsets. */
function maskNonCode(source, { strings = false } = {}) {
  const output = source.split("");
  const blank = (index) => {
    if (output[index] !== "\n") output[index] = " ";
  };
  let quote = null;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      blank(index);
      if (char === "\\") {
        index++;
        blank(index);
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      blank(index++);
      blank(index);
      while (++index < source.length && source[index] !== "\n") blank(index);
      continue;
    }
    if (char === "/" && next === "*") {
      blank(index++);
      blank(index);
      while (++index < source.length) {
        blank(index);
        if (source[index] === "*" && source[index + 1] === "/") {
          blank(++index);
          break;
        }
      }
      continue;
    }
    if (strings && (char === "'" || char === '"' || char === "`")) {
      quote = char;
      blank(index);
    }
  }
  return output.join("");
}

function resolveModule(root, fromFile, specifier) {
  let base;
  if (specifier.startsWith(".")) {
    base = resolve(dirname(fromFile), specifier);
  } else if (specifier.startsWith("@/")) {
    // Expo/React Native projects commonly map @/ to <root>/src/. Keeping this
    // explicit makes resolver failure loud for other custom aliases.
    base = resolve(root, "src", specifier.slice(2));
  } else {
    return null;
  }
  for (const extension of MODULE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const extension of MODULE_EXTENSIONS.slice(1)) {
    const candidate = join(base, `index${extension}`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function parseImports(source) {
  const bindings = [];
  const code = maskNonCode(source);
  const re = /\bimport\s+([\s\S]*?)\s+from\s+["']([^"']+)["']\s*;?/g;
  let match;
  while ((match = re.exec(code))) {
    const clause = match[1].trim();
    const specifier = match[2];
    if (!clause || clause.startsWith("type ")) continue;

    const namespace = /^\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(clause);
    if (namespace) {
      bindings.push({ imported: "*", local: namespace[1], specifier, namespace: true });
      continue;
    }

    const named = /\{([\s\S]*)\}/.exec(clause);
    if (named) {
      const defaultPart = clause.slice(0, named.index).replace(/,$/, "").trim();
      if (defaultPart) {
        bindings.push({ imported: "default", local: defaultPart, specifier, namespace: false });
      }
      for (const rawEntry of named[1].split(",")) {
        const entry = rawEntry.trim();
        if (!entry || entry.startsWith("type ")) continue;
        const pieces = entry.split(/\s+as\s+/);
        const imported = pieces[0].trim();
        const local = (pieces[1] || imported).trim();
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(imported) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(local)) {
          bindings.push({ imported, local, specifier, namespace: false });
        }
      }
      continue;
    }

    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(clause)) {
      bindings.push({ imported: "default", local: clause, specifier, namespace: false });
    }
  }
  return bindings;
}

function jsxTags(source, offset = 0, original = source, excludedRanges = []) {
  const tags = [];
  const code = maskNonCode(source, { strings: true });
  const re = /<([A-Z][A-Za-z0-9_$]*(?:\.[A-Z][A-Za-z0-9_$]*)?)(?=[\s/>])/g;
  let match;
  while ((match = re.exec(code))) {
    if (excludedRanges.some(([start, end]) => match.index >= start && match.index < end)) continue;
    tags.push({ name: match[1], line: lineOf(original, offset + match.index), index: match.index });
  }
  return tags;
}

function balancedBraceEnd(source, start) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) return source.length;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2);
      if (close < 0) return source.length;
      index = close + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) return index + 1;
  }
  return source.length;
}

function functionBodyStart(source, declarationIndex) {
  const open = source.indexOf("(", declarationIndex);
  if (open < 0) return -1;
  let depth = 0;
  let quote = null;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")" && --depth === 0) {
      return source.indexOf("{", index + 1);
    }
  }
  return -1;
}

/**
 * Limit JSX evidence to the exported component body. Scanning the whole module
 * lets an unrelated helper's JSX satisfy the route's policy, which is exactly
 * the false pass this resolver exists to prevent. Function declarations cover
 * the route and shared-wrapper forms used by the shipped project. An
 * unsupported component declaration deliberately produces no render evidence
 * so the caller can report it unresolved rather than pass on unrelated JSX.
 */
function blockRenderSource(source, start) {
  return { source: source.slice(start, balancedBraceEnd(source, start)), offset: start, kind: "block" };
}

function arrowRenderSource(source, declaration) {
  const start = declaration.index + declaration[0].length;
  if (source[start] === "{") {
    return blockRenderSource(source, start);
  }
  const end = source.indexOf(";", start);
  return { source: source.slice(start, end < 0 ? source.length : end), offset: start, kind: "expression" };
}

function localComponentDeclaration(source, name) {
  const escaped = name.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
  const code = maskNonCode(source);
  const functionDeclaration = new RegExp(
    `(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s+${escaped}\\s*\\(`,
  ).exec(code);
  if (functionDeclaration) {
    return {
      kind: "function",
      functionIndex: functionDeclaration.index + functionDeclaration[0].lastIndexOf("function"),
    };
  }
  const arrowDeclaration = new RegExp(
    `(?:export\\s+)?(?:const|let|var)\\s+${escaped}(?:\\s*:[^=]+)?\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][A-Za-z0-9_$]*)\\s*=>\\s*`,
  ).exec(code);
  if (arrowDeclaration) return { kind: "arrow", declaration: arrowDeclaration };

  const functionExpression = new RegExp(
    `(?:export\\s+)?(?:const|let|var)\\s+${escaped}(?:\\s*:[^=;]+)?\\s*=\\s*(?:async\\s+)?function(?:\\s+[A-Za-z_$][A-Za-z0-9_$]*)?\\s*\\(`,
  ).exec(code);
  if (functionExpression) {
    return {
      kind: "function",
      functionIndex: functionExpression.index + functionExpression[0].lastIndexOf("function"),
    };
  }

  const variableDeclaration = new RegExp(
    `(?:export\\s+)?(?:const|let|var)\\s+${escaped}(?:\\s*:[^=;]+)?\\s*=`,
  ).exec(code);
  return variableDeclaration ? { kind: "unresolved" } : null;
}

function namedComponentRenderSource(source, name) {
  const declaration = localComponentDeclaration(source, name);
  if (!declaration) return { source: null, offset: 0, kind: null };
  if (declaration.kind === "arrow") return arrowRenderSource(source, declaration.declaration);
  if (declaration.kind === "function") {
    const start = functionBodyStart(source, declaration.functionIndex);
    if (start >= 0) return blockRenderSource(source, start);
  }
  return { source: null, offset: 0, kind: null };
}

function componentRenderSource(source, exportName = "default") {
  if (exportName !== "default") return namedComponentRenderSource(source, exportName);

  const defaultIdentifier = /\bexport\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*;/.exec(source)?.[1];
  if (defaultIdentifier) return namedComponentRenderSource(source, defaultIdentifier);

  const defaultFunction = /export\s+default\s+(?:async\s+)?function(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\(/.exec(source);
  if (defaultFunction) {
    const start = functionBodyStart(source, defaultFunction.index);
    if (start >= 0) return blockRenderSource(source, start);
  }
  const defaultArrow = /export\s+default\s+(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*/.exec(source);
  return defaultArrow ? arrowRenderSource(source, defaultArrow) : { source: null, offset: 0, kind: null };
}

function nestedCallbackRanges(source) {
  const code = maskNonCode(source, { strings: true });
  const ranges = [];
  const functionRe = /\bfunction(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\(/g;
  let match;
  while ((match = functionRe.exec(code))) {
    const start = functionBodyStart(code, match.index);
    if (start >= 0) ranges.push([start, balancedBraceEnd(code, start)]);
  }
  const arrowRe = /=>\s*\{/g;
  while ((match = arrowRe.exec(code))) {
    const start = code.indexOf("{", match.index);
    ranges.push([start, balancedBraceEnd(code, start)]);
  }
  return ranges;
}

function inRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function returnExpressionEnd(code, start) {
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  for (let index = start; index < code.length; index++) {
    const char = code[index];
    if (char === "{") braces++;
    else if (char === "}") {
      if (!braces && !brackets && !parentheses) return index;
      braces--;
    } else if (char === "[") brackets++;
    else if (char === "]") brackets--;
    else if (char === "(") parentheses++;
    else if (char === ")") parentheses--;
    else if (char === ";" && !braces && !brackets && !parentheses) return index;
  }
  return code.length;
}

function braceDepthAt(code, index) {
  let depth = 0;
  for (let cursor = 0; cursor < index; cursor++) {
    if (code[cursor] === "{") depth++;
    else if (code[cursor] === "}") depth--;
  }
  return depth;
}

function isUnconditionalReturn(code, index) {
  if (braceDepthAt(code, index) !== 1) return false;
  const statementStart = Math.max(code.lastIndexOf(";", index - 1), code.lastIndexOf("{", index - 1), code.lastIndexOf("}", index - 1)) + 1;
  return !/\b(?:if|for|while)\s*\([^{};]*\)\s*$|\belse\s*$/.test(code.slice(statementStart, index));
}

function returnExpressions(render) {
  if (render.kind === "expression") {
    return [{ source: render.source, offset: render.offset, unconditional: true }];
  }
  const code = maskNonCode(render.source, { strings: true });
  const callbacks = nestedCallbackRanges(render.source);
  const expressions = [];
  const returnRe = /\breturn\b/g;
  let match;
  while ((match = returnRe.exec(code))) {
    if (inRanges(match.index, callbacks)) continue;
    const start = match.index + match[0].length;
    const end = returnExpressionEnd(code, start);
    expressions.push({
      source: render.source.slice(start, end),
      offset: render.offset + start,
      unconditional: isUnconditionalReturn(code, match.index),
    });
  }
  return expressions;
}

function expressionCallbackRanges(source) {
  const code = maskNonCode(source, { strings: true });
  const ranges = nestedCallbackRanges(source);
  const arrowExpressionRe = /=>\s*(?!\{)/g;
  let match;
  while ((match = arrowExpressionRe.exec(code))) {
    const start = match.index + match[0].length;
    let end = start;
    let braces = 0;
    let brackets = 0;
    let parentheses = 0;
    for (; end < code.length; end++) {
      const char = code[end];
      if (char === "{") braces++;
      else if (char === "}") {
        if (!braces && !brackets && !parentheses) break;
        braces--;
      } else if (char === "[") brackets++;
      else if (char === "]") brackets--;
      else if (char === "(") {
        parentheses++;
      } else if (char === ")") {
        if (!parentheses && !braces && !brackets) break;
        parentheses--;
      } else if ((char === "," || char === ";" || char === ":") && !braces && !brackets && !parentheses) {
        break;
      }
    }
    ranges.push([start, end]);
  }
  return ranges;
}

function tagIsConditional(source, index) {
  const code = maskNonCode(source, { strings: true });
  let jsxExpressionDepth = 0;
  let rootConditional = false;
  for (let cursor = 0; cursor < index; cursor++) {
    const char = code[cursor];
    if (char === "{") jsxExpressionDepth++;
    else if (char === "}") jsxExpressionDepth--;
    else if (!jsxExpressionDepth && (char === "?" || (char === "&" && code[cursor + 1] === "&") || (char === "|" && code[cursor + 1] === "|"))) {
      rootConditional = true;
    }
  }
  return rootConditional || jsxExpressionDepth > 0;
}

function renderedTags(render) {
  const expressions = returnExpressions(render);
  const tags = expressions.flatMap((expression) => jsxTags(
    expression.source,
    expression.offset,
    render.original,
    expressionCallbackRanges(expression.source),
  ).map((tag) => ({
    ...tag,
    unconditional: expression.unconditional && !tagIsConditional(expression.source, tag.index),
  })));
  return { expressions, tags };
}

function readAnalysis(root, file, cache, exportName = "default") {
  const cacheKey = `${file}\u0000${exportName}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  if (!existsSync(file)) {
    const missing = { file, source: null, imports: [], tags: [] };
    cache.set(cacheKey, missing);
    return missing;
  }
  const source = readFileSync(file, "utf8");
  const render = componentRenderSource(source, exportName);
  render.original = source;
  const rendered = render.source == null ? { expressions: [], tags: [] } : renderedTags(render);
  const analysis = {
    file,
    source,
    renderSource: render.source,
    renderOffset: render.offset,
    renderExpressions: rendered.expressions,
    imports: parseImports(source),
    tags: rendered.tags,
  };
  cache.set(cacheKey, analysis);
  return analysis;
}

function exportedEntries(block) {
  const entries = [];
  for (const rawEntry of block.split(",")) {
    const entry = rawEntry.trim();
    if (!entry || entry.startsWith("type ")) continue;
    const pieces = entry.split(/\s+as\s+/);
    const imported = pieces[0].trim();
    const exported = (pieces[1] || imported).trim();
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(imported) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exported)) {
      entries.push({ imported, exported });
    }
  }
  return entries;
}

/** Locate a named value's implementation behind a configured barrel. */
function resolveBarrelExport(root, barrel, name, seen = new Set()) {
  if (seen.has(barrel) || !existsSync(barrel)) return null;
  seen.add(barrel);
  const source = readFileSync(barrel, "utf8");
  const namedRe = /export\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g;
  let named;
  while ((named = namedRe.exec(source))) {
    const entry = exportedEntries(named[1]).find((candidate) => candidate.exported === name);
    if (!entry) continue;
    const file = resolveModule(root, barrel, named[2]);
    return file ? { file, exportName: entry.imported } : null;
  }
  const starRe = /export\s+\*\s+from\s*["']([^"']+)["']/g;
  let star;
  while ((star = starRe.exec(source))) {
    const child = resolveModule(root, barrel, star[1]);
    const resolved = child && resolveBarrelExport(root, child, name, seen);
    if (resolved) return resolved;
  }
  return null;
}

function barrelInventory(root, barrelPaths) {
  const inventory = new Map();
  for (const configuredPath of barrelPaths || []) {
    const barrel = isAbsolute(configuredPath) ? configuredPath : join(root, configuredPath);
    if (!existsSync(barrel)) continue;
    const exports = deriveAtoms(
      readFileSync(barrel, "utf8"),
      (specifier, source) => {
        const from = isAbsolute(source) ? source : join(root, source);
        const resolved = resolveModule(root, from, specifier);
        return resolved
          ? { source: relative(root, resolved), content: readFileSync(resolved, "utf8") }
          : null;
      },
      relative(root, barrel),
    );
    const implementations = new Map();
    for (const value of exports) {
      const implementation = resolveBarrelExport(root, barrel, value);
      if (implementation) implementations.set(value, implementation);
    }
    inventory.set(resolve(barrel), { names: exports, implementations });
  }
  return inventory;
}

function isDirectComponentFile(file) {
  return !/[/\\]index\.[cm]?[jt]sx?$/.test(file);
}

function requiredBindingComponent(binding, required, root, fromFile, barrels) {
  const resolved = resolveModule(root, fromFile, binding.specifier);
  if (!resolved) return null;
  const barrel = barrels.get(resolve(resolved));
  if (barrel) return required.has(binding.imported) && barrel.names.has(binding.imported) ? binding.imported : null;
  if (!isDirectComponentFile(resolved)) return null;
  if (required.has(binding.imported)) return binding.imported;
  if (binding.imported !== "default") return null;
  const fileName = basename(resolved, extname(resolved));
  return [...required].find((component) => component === binding.local || component === fileName) || null;
}

function renderedRequirement(analysis, required, root, barrels, { unconditionalOnly = false } = {}) {
  for (const tag of analysis.tags) {
    if (unconditionalOnly && !tag.unconditional) continue;
    const [local, member] = tag.name.split(".");
    const binding = analysis.imports.find((candidate) => candidate.local === local);
    if (!binding) continue;
    if (member && binding.namespace) {
      const resolved = resolveModule(root, analysis.file, binding.specifier);
      const barrel = resolved && barrels.get(resolve(resolved));
      if (barrel && required.has(member) && barrel.names.has(member)) {
        return { component: member, file: analysis.file, line: tag.line };
      }
      continue;
    }
    const component = !member && requiredBindingComponent(binding, required, root, analysis.file, barrels);
    if (component) {
      return { component, file: analysis.file, line: tag.line };
    }
  }
  return null;
}

/**
 * A shared route root can establish chrome for every route it owns, but only
 * when one unconditional root render produces it. Branch evidence remains
 * target-scoped and is resolved through each target's declared child source.
 */
function commonRootRequirement(analysis, required, root, barrels) {
  if (analysis.renderExpressions.length !== 1 || !analysis.renderExpressions[0].unconditional) return null;
  return renderedRequirement(analysis, required, root, barrels, { unconditionalOnly: true });
}

function renderedChildFiles(analysis, root, barrels, allowedFiles = null, { includeLocal = false } = {}) {
  const children = [];
  const unresolved = [];
  for (const tag of analysis.tags) {
    const local = tag.name.split(".")[0];
    const binding = analysis.imports.find((candidate) => candidate.local === local && !candidate.namespace);
    if (!binding) {
      if (includeLocal && localComponentDeclaration(analysis.source, local)) {
        const childFile = analysis.file;
        if (allowedFiles && !allowedFiles.has(resolve(childFile))) continue;
        children.push({
          file: childFile,
          line: tag.line,
          component: local,
          exportName: local,
        });
      }
      continue;
    }
    const resolved = resolveModule(root, analysis.file, binding.specifier);
    if (resolved) {
      const barrel = barrels.get(resolve(resolved));
      const implementation = barrel?.implementations.get(binding.imported);
      if (barrel && !implementation) {
        unresolved.push({ line: tag.line, component: local, specifier: binding.specifier });
      } else {
        const childFile = implementation?.file || resolved;
        if (allowedFiles && !allowedFiles.has(resolve(childFile))) continue;
        children.push({
          file: childFile,
          line: tag.line,
          component: local,
          exportName: implementation?.exportName || binding.imported,
        });
      }
    }
    else if (binding.specifier.startsWith(".") || binding.specifier.startsWith("@/")) {
      unresolved.push({ line: tag.line, component: local, specifier: binding.specifier });
    }
  }
  return { children, unresolved };
}

function unresolvedVerdict(base, root, routeFile, line, issues) {
  const unresolvedComponents = [...new Set(issues.map((issue) => issue.component))];
  const reason = issues.length === 1
    ? issues[0].reason
    : `could not resolve rendered components ${unresolvedComponents.join(", ")}: ${issues.map((issue) => issue.reason).join("; ")}`;
  return {
    ...base,
    verdict: "unresolved",
    file: relativeFile(root, routeFile),
    line,
    unresolvedComponents,
    reason,
  };
}

function rootRenderLine(analysis) {
  if (analysis.tags.length) return analysis.tags[0].line;
  if (analysis.renderExpressions?.length) return lineOf(analysis.source, analysis.renderExpressions[0].offset);
  const returnAt = analysis.source ? analysis.source.indexOf("return") : -1;
  return returnAt >= 0 ? lineOf(analysis.source, returnAt) : 1;
}

function relativeFile(root, file) {
  const result = relative(root, file);
  return result && !result.startsWith("..") ? result.replaceAll("\\", "/") : file;
}

function resolveRuleForTarget(root, target, rule, barrels, cache, sharedRouteRoots) {
  const routeFile = target.sourceFiles?.[0];
  const base = {
    targetId: target.id,
    route: target.route,
    routeClass: rule.routeClass,
    require: [...rule.require],
  };
  if (matchesAny(target.route, rule.exceptions)) {
    return { ...base, verdict: "exempt", reason: "route matches an explicit policy exception" };
  }
  if (!routeFile) {
    return { ...base, verdict: "unresolved", reason: "target has no sourceFiles route root" };
  }

  const rootFile = isAbsolute(routeFile) ? routeFile : join(root, routeFile);
  const route = readAnalysis(root, rootFile, cache, "default");
  if (!route.source) {
    return {
      ...base,
      verdict: "unresolved",
      file: relativeFile(root, rootFile),
      line: 1,
      reason: "route source file is unavailable",
    };
  }
  if (route.renderSource == null) {
    return {
      ...base,
      verdict: "unresolved",
      file: relativeFile(root, rootFile),
      line: 1,
      reason: "could not determine the route component render boundary",
    };
  }

  const rootLine = rootRenderLine(route);
  const sharedRouteRoot = sharedRouteRoots.has(resolve(rootFile));
  const ownedChildFiles = new Set(
    (target.sourceFiles || []).slice(1).map((file) => resolve(isAbsolute(file) ? file : join(root, file))),
  );
  const required = new Set(rule.require);
  const direct = sharedRouteRoot
    ? commonRootRequirement(route, required, root, barrels)
    : renderedRequirement(route, required, root, barrels);
  if (direct) {
    return {
      ...base,
      verdict: "satisfied",
      file: relativeFile(root, direct.file),
      line: direct.line,
      component: direct.component,
    };
  }

  if (sharedRouteRoot && ownedChildFiles.size === 0) {
    return {
      ...base,
      verdict: "unresolved",
      file: relativeFile(root, rootFile),
      line: rootLine,
      reason: "route root is shared by multiple targets without a target-owned child source",
    };
  }

  const first = renderedChildFiles(route, root, barrels, sharedRouteRoot ? ownedChildFiles : null, { includeLocal: true });
  const unresolved = first.unresolved.map((entry) => ({
    component: entry.component,
    reason: `could not resolve rendered component ${entry.component} from ${entry.specifier}`,
  }));
  let satisfied = null;

  const visited = new Set([`${rootFile}\u0000default`]);
  let queue = first.children.map((child) => ({ ...child, depth: 1 }));
  while (queue.length) {
    const current = queue.shift();
    const identity = `${current.file}\u0000${current.exportName}`;
    if (visited.has(identity)) continue;
    visited.add(identity);
    const child = readAnalysis(root, current.file, cache, current.exportName);
    if (!child.source) {
      unresolved.push({
        component: current.component,
        reason: `rendered component source is unavailable: ${relativeFile(root, current.file)}`,
      });
      continue;
    }
    if (child.renderSource == null) {
      unresolved.push({
        component: current.component,
        reason: `could not determine the rendered component boundary: ${relativeFile(root, current.file)}`,
      });
      continue;
    }
    const found = renderedRequirement(child, required, root, barrels);
    if (found) {
      if (current.depth === 1) {
        satisfied = {
          ...base,
          verdict: "satisfied",
          file: relativeFile(root, found.file),
          line: found.line,
          component: found.component,
        };
        continue;
      }
      unresolved.push({
        component: current.component,
        reason: `${found.component} is rendered ${current.depth} component hops below the route; policy resolution stops after one hop`,
      });
      continue;
    }
    const next = renderedChildFiles(child, root, barrels);
    unresolved.push(...next.unresolved.map((entry) => ({
      component: entry.component,
      reason: `could not resolve rendered component ${entry.component} from ${entry.specifier}`,
    })));
    queue = queue.concat(next.children.map((entry) => ({ ...entry, depth: current.depth + 1 })));
  }

  if (satisfied) return satisfied;
  if (unresolved.length) return unresolvedVerdict(base, root, rootFile, rootLine, unresolved);

  if (sharedRouteRoot) {
    return {
      ...base,
      verdict: "unresolved",
      file: relativeFile(root, rootFile),
      line: rootLine,
      reason: "target-owned branch does not render a required component within one hop",
    };
  }
  return {
    ...base,
    verdict: "violated",
    file: relativeFile(root, rootFile),
    line: rootLine,
    missing: [...rule.require],
  };
}

/** Resolve every shell-policy rule that matches each supplied target. */
function resolveShellPolicy({ root, targets, allTargets = targets, barrels, shellPolicy }) {
  const barrelMap = barrelInventory(root, barrels);
  const cache = new Map();
  const rootCounts = new Map();
  for (const target of allTargets || []) {
    const routeFile = target.sourceFiles?.[0];
    if (!routeFile) continue;
    const absolute = resolve(isAbsolute(routeFile) ? routeFile : join(root, routeFile));
    rootCounts.set(absolute, (rootCounts.get(absolute) || 0) + 1);
  }
  const sharedRouteRoots = new Set([...rootCounts].filter(([, count]) => count > 1).map(([file]) => file));
  const verdicts = [];
  for (const target of targets) {
    for (const rule of shellPolicy || []) {
      if (!matchesAny(target.route, rule.match)) continue;
      verdicts.push(resolveRuleForTarget(root, target, rule, barrelMap, cache, sharedRouteRoots));
    }
  }
  return verdicts;
}

module.exports = {
  globToRegExp,
  parseImports,
  resolveShellPolicy,
};
