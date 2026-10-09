/** Build the bounded, deterministic per-target judge-context slice. */

"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { isAbsolute, join } = require("node:path");
const { parseImports } = require("./route-shell-policy.cjs");

const DEFAULT_JUDGE_CONTEXT_BYTES = 8 * 1024;

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function targetSourcePath(cfg, sourceFile) {
  return isAbsolute(sourceFile) ? sourceFile : join(cfg.root, sourceFile);
}

function importedInventoryMatches(cfg, target, inventory) {
  const known = new Set(inventory?.components || inventory?.atoms || []);
  const matches = [];
  for (const sourceFile of target.sourceFiles || []) {
    const path = targetSourcePath(cfg, sourceFile);
    if (!existsSync(path)) continue;
    for (const binding of parseImports(readFileSync(path, "utf8"))) {
      if (known.has(binding.imported)) {
        matches.push({ component: binding.imported, local: binding.local, file: sourceFile });
      }
    }
  }
  return matches.sort((left, right) =>
    left.file === right.file
      ? left.component === right.component
        ? left.local.localeCompare(right.local)
        : left.component.localeCompare(right.component)
      : left.file.localeCompare(right.file),
  );
}

function routeClassTerms(routeClass) {
  const terms = String(routeClass || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3 && term !== "route" && term !== "sub");
  return [...new Set(terms)];
}

function intentExcerpts(intentPath, routeClasses) {
  if (!intentPath || !existsSync(intentPath)) return [];
  const terms = [...new Set(routeClasses.flatMap(routeClassTerms))];
  if (!terms.length) return [];
  const sections = readFileSync(intentPath, "utf8")
    .split(/\n(?=#{1,6}\s)/)
    .map((section) => section.trim())
    .filter(Boolean);
  const result = [];
  for (const section of sections) {
    const heading = /^(#{1,6})\s+(.+)$/m.exec(section)?.[2] ?? "";
    const normalized = heading.toLowerCase();
    if (!terms.some((term) => normalized.includes(term))) continue;
    // A heading plus its first non-empty paragraph is enough context; the full
    // intent document is specifically forbidden in a judge slice.
    const lines = section.split("\n").filter((line) => line.trim());
    result.push({ heading, excerpt: lines.slice(0, 2).join("\n") });
  }
  return result.sort((left, right) => left.heading.localeCompare(right.heading));
}

function normalizedScrollFacts(scroll) {
  if (!scroll) {
    return {
      scrollable: null,
      scrollExtentPt: null,
      viewportPt: null,
      bottomReached: null,
      revealed: null,
      containerSelector: null,
      frames: { container: null, content: null, viewport: null, footer: null },
      sliverScroll: null,
      inert: null,
      swipeCount: null,
      maxSwipes: null,
      layoutEconomy: { verdict: "not-judged", reason: "scroll probe was not captured" },
    };
  }
  return {
    scrollable: scroll.scrollable ?? null,
    scrollExtentPt: scroll.scrollExtentPt ?? null,
    viewportPt: scroll.viewportPt ?? null,
    bottomReached: scroll.bottomReached ?? null,
    revealed: scroll.revealed ?? null,
    containerSelector: scroll.containerSelector ?? null,
    frames: scroll.frames ?? { container: null, content: null, viewport: null, footer: null },
    sliverScroll: scroll.sliverScroll ?? null,
    inert: scroll.inert ?? null,
    swipeCount: scroll.swipeCount ?? null,
    maxSwipes: scroll.maxSwipes ?? null,
    layoutEconomy: scroll.layoutEconomy ?? { verdict: "not-judged", reason: "scroll geometry unavailable" },
  };
}

function normalizedScrollProbes(target) {
  const probes = target?.scrollProbes;
  if (Array.isArray(probes) && probes.length) {
    return probes
      .map((probe, index) => ({
        viewport: typeof probe?.viewport === "string" && probe.viewport ? probe.viewport : `probe-${index + 1}`,
        facts: normalizedScrollFacts(probe),
      }))
      .sort((left, right) => left.viewport.localeCompare(right.viewport));
  }
  // Capture manifests written before the per-viewport array retained only this
  // first probe. Keep them interpretable without pretending it belongs to a
  // known viewport; current captures always provide scrollProbes.
  return [{ viewport: "default", facts: normalizedScrollFacts(target?.scroll) }];
}

function omittedItem(section, count) {
  // Compact but still explicit: the smallest supported cap is 256 bytes, so a
  // verbose object per omitted section could make a valid config impossible to
  // represent. The stable `section:count:cap` form records both what and why.
  return `${section}:${count}:cap`;
}

/**
 * Deterministic truncation order is contractual: retain shell-policy verdicts,
 * then imported inventory matches, then viewport-keyed scroll probes, then
 * intent excerpts.
 * Once a higher-priority section is truncated, lower-priority sections are
 * represented only in `omitted`, never allowed to leapfrog it.
 */
function boundedSlice({ target, shellPolicy, inventoryMatches, scrollProbes, scroll, excerpts, maxBytes }) {
  // `scroll` remains accepted for callers constructing a slice directly; the
  // production path always supplies the complete per-viewport collection.
  const probes = scrollProbes ?? [{ viewport: "default", facts: scroll ?? normalizedScrollFacts(null) }];
  const envelope = {
    version: "judge-context.v1",
    targetId: target.id,
    capBytes: maxBytes,
    shellPolicy: [],
    inventoryMatches: [],
    scrollProbes: {},
    intentExcerpts: [],
    omitted: [],
  };
  if (byteLength(envelope) > maxBytes) throw new Error(`judgeContext.maxBytes (${maxBytes}) is too small for its envelope`);

  const sections = [
    ["shellPolicy", shellPolicy],
    ["inventoryMatches", inventoryMatches],
    ["scrollProbes", probes],
    ["intentExcerpts", excerpts],
  ];
  const retained = sections.map(() => 0);
  const candidateFor = (counts) => {
    const candidate = structuredClone(envelope);
    for (let index = 0; index < sections.length; index++) {
      const [section, values] = sections[index];
      const retainedCount = counts[index];
      if (section === "scrollProbes") {
        candidate.scrollProbes = Object.fromEntries(
          values.slice(0, retainedCount).map((probe) => [probe.viewport, probe.facts]),
        );
      } else candidate[section] = values.slice(0, retainedCount);
      if (retainedCount < values.length) {
        candidate.omitted.push(omittedItem(section, values.length - retainedCount));
      }
    }
    return candidate;
  };

  // Account for the complete omission notice while deciding what to retain.
  // This avoids a late tail trim that would otherwise leave stale counts in
  // `omitted` and falsely imply that removed entries were retained.
  const empty = candidateFor(retained);
  if (byteLength(empty) > maxBytes) {
    throw new Error(`judgeContext.maxBytes (${maxBytes}) cannot represent its truncation notice`);
  }

  let stopped = false;
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
    const [section, values] = sections[sectionIndex];
    if (stopped) continue;
    for (let index = 0; index < values.length; index++) {
      const counts = [...retained];
      counts[sectionIndex]++;
      const candidate = candidateFor(counts);
      if (byteLength(candidate) <= maxBytes) {
        retained[sectionIndex]++;
        continue;
      }
      stopped = true;
      break;
    }
  }
  return candidateFor(retained);
}

function buildJudgeContexts({ cfg, targets, scan, shots, intentPath }) {
  const maxBytes = cfg.judgeContext?.maxBytes ?? DEFAULT_JUDGE_CONTEXT_BYTES;
  const byShot = new Map((shots?.targets || []).map((target) => [target.id, target]));
  const contexts = {};
  for (const target of [...targets].sort((left, right) => left.id.localeCompare(right.id))) {
    const shellPolicy = [...(scan?.shellPolicy || [])]
      .filter((verdict) => verdict.targetId === target.id)
      .sort((left, right) => left.routeClass.localeCompare(right.routeClass));
    const routeClasses = shellPolicy.map((verdict) => verdict.routeClass);
    contexts[target.id] = boundedSlice({
      target,
      shellPolicy,
      inventoryMatches: importedInventoryMatches(cfg, target, scan?.inventory),
      scrollProbes: normalizedScrollProbes(byShot.get(target.id)),
      excerpts: intentExcerpts(intentPath, routeClasses),
      maxBytes,
    });
  }
  return contexts;
}

module.exports = {
  DEFAULT_JUDGE_CONTEXT_BYTES,
  boundedSlice,
  buildJudgeContexts,
  importedInventoryMatches,
  intentExcerpts,
  normalizedScrollFacts,
  normalizedScrollProbes,
};
