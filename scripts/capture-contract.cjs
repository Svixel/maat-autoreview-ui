"use strict";

const { lstatSync, realpathSync } = require("node:fs");
const { isAbsolute, join, relative, resolve, sep } = require("node:path");

// Values used as state-directory names or target-file prefixes share this
// deliberately narrow contract: no dots, slashes, or platform-specific path
// separators are ever meaningful in those names.
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const TARGET_ID_RE = SAFE_PATH_SEGMENT_RE;
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function isSafePathSegment(value) {
  return typeof value === "string" && SAFE_PATH_SEGMENT_RE.test(value);
}

function isSafeTargetId(id) {
  return isSafePathSegment(id);
}

/**
 * Serialized capture identities always use POSIX separators, including when
 * path.relative() produced native backslashes on Windows. Replacing both here
 * also lets completed-run loading canonicalize legacy Windows run.json keys on
 * every host before any lookup or evidence digest is computed.
 */
function canonicalPathKey(value) {
  return typeof value === "string" ? value.replace(/\\/g, "/") : value;
}

function pathIsWithin(candidate, parent) {
  const rel = relative(parent, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Resolve a path beneath a real directory while checking every existing path
 * component. Callers that read immutable capture bytes set
 * rejectSymlinkComponents so even an in-root symlink cannot redirect a later
 * hash/read; callers that only need resolved containment may allow symlinks
 * whose real targets remain under the root.
 */
function resolveContainedRealPath(rootDir, candidate, {
  allowRoot = false,
  rejectSymlinkComponents = false,
} = {}) {
  const root = resolve(rootDir);
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  if ((!allowRoot && !rel) || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("path escapes its root");
  }

  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`root is not a real directory: ${root}`);
  }
  const realRoot = realpathSync(root);
  let current = root;
  for (const part of rel ? rel.split(sep) : []) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (err) {
      if (err.code === "ENOENT") break;
      throw err;
    }
    if (rejectSymlinkComponents && stat.isSymbolicLink()) {
      throw new Error(`path contains a symlink component: ${current}`);
    }
    const resolved = realpathSync(current);
    if (!pathIsWithin(resolved, realRoot)) {
      throw new Error(`existing ancestor resolves outside the real root: ${current} -> ${resolved}`);
    }
  }
  return { absolute, realRoot, root };
}

function assertSafeTargetId(id) {
  if (!isSafeTargetId(id)) {
    throw new Error(
      `target.id must be a safe path segment (letters, numbers, underscores, and hyphens only): ${JSON.stringify(id)}`,
    );
  }
  return id;
}

/**
 * Build an output path for one target and prove it remains below outDir. The
 * safe-ID assertion lives here, at the filesystem boundary, as a defence in
 * depth guard for direct driver invocations which bypass config validation.
 */
function targetOutputPath(outDir, id, suffix) {
  const safeId = assertSafeTargetId(id);
  const root = resolve(outDir);
  const path = resolve(root, `${safeId}${suffix}`);
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`target output path escapes run.outDir: ${path}`);
  }
  return path;
}

function shotFile(outDir, id, parts) {
  const safeParts = parts.map((part) => String(part).replace(/[^a-z0-9_-]+/gi, "_")).join(".");
  return targetOutputPath(outDir, id, `.${safeParts}.png`);
}

function targetManifestFile(outDir, id) {
  return targetOutputPath(outDir, id, ".manifest.json");
}

/**
 * Append target.params to an already-addressed URL without overwriting route
 * query keys. Existing queries are author-controlled route syntax, so they
 * always win over the convenience params object.
 */
function mergeUrlParams(url, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return url;

  const text = String(url);
  const hashAt = text.indexOf("#");
  const beforeHash = hashAt === -1 ? text : text.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : text.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  const base = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const search = new URLSearchParams(queryAt === -1 ? "" : beforeHash.slice(queryAt + 1));
  let changed = false;

  for (const [key, value] of Object.entries(params)) {
    if (search.has(key)) continue;
    search.append(key, value === null ? "null" : String(value));
    changed = true;
  }

  return changed ? `${base}?${search.toString()}${hash}` : text;
}

function composeWebUrl(baseUrl, route, params) {
  const text = String(route);
  const addressed = ABSOLUTE_URL_RE.test(text)
    ? text
    : `${String(baseUrl).replace(/\/$/, "")}/${text.replace(/^\/+/, "")}`;
  return mergeUrlParams(addressed, params);
}

function composeDeepLinkUrl(scheme, route, params) {
  const text = String(route);
  const addressed = ABSOLUTE_URL_RE.test(text)
    ? text
    : `${scheme}://${text.replace(/^\/+/, "")}`;
  return mergeUrlParams(addressed, params);
}

module.exports = {
  SAFE_PATH_SEGMENT_RE,
  TARGET_ID_RE,
  assertSafeTargetId,
  canonicalPathKey,
  composeDeepLinkUrl,
  composeWebUrl,
  isSafePathSegment,
  isSafeTargetId,
  mergeUrlParams,
  resolveContainedRealPath,
  shotFile,
  targetManifestFile,
  targetOutputPath,
};
