/** Target freshness fingerprints for the durable autoreview-ui library. */

"use strict";

const { createHash } = require("node:crypto");
const { existsSync, lstatSync, readFileSync, readlinkSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { basename, isAbsolute, join, relative, resolve, sep } = require("node:path");
const { composeWebUrl } = require("./capture-contract.cjs");
const { webCaptureTimeouts } = require("./web-capture-timeouts.cjs");

const SKILL_DIR = join(__dirname, "..");
const PACKAGE_VERSION = JSON.parse(readFileSync(join(SKILL_DIR, "package.json"), "utf8")).version;
const GIT_DIFF_MAX_BUFFER = 256 * 1024 * 1024;
// Keep each backend's implementation closure beside driver selection. Adding a
// driver dependency is intentionally a one-line change here so freshness can
// never silently survive a capture-behavior change in a required module.
const DRIVER_IMPLEMENTATION_FILES = {
  "rn-sim": ["shoot-rn.mjs", "capture-contract.cjs", "png.cjs", "sim-target.cjs"],
  playwright: ["shoot.mjs", "capture-contract.cjs", "web-capture-timeouts.cjs", "web-capture-retry.cjs"],
};
const GIT_SHOW_PREFIX_CACHE = new Map();

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value != null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function relativeSourcePath(root, configuredPath) {
  if (typeof configuredPath !== "string" || !configuredPath.trim()) throw new Error("sourceFiles entries must be non-empty strings");
  const absolute = isAbsolute(configuredPath) ? resolve(configuredPath) : resolve(root, configuredPath);
  const rel = relative(resolve(root), absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`source file must be inside the project root: ${configuredPath}`);
  }
  return rel.split(sep).join("/");
}

/**
 * git show resolves treeish paths at the repository top level, whereas
 * sourceFiles are deliberately project-root-relative. Cache Git's prefix for
 * each configured root so a target set in one monorepo needs one lookup.
 */
function gitShowPrefix(root) {
  const cacheKey = resolve(root);
  if (GIT_SHOW_PREFIX_CACHE.has(cacheKey)) return GIT_SHOW_PREFIX_CACHE.get(cacheKey);
  const result = spawnSync("git", ["-C", root, "rev-parse", "--show-prefix"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const error = (result.stderr || "").trim();
    throw new Error(error || "git rev-parse --show-prefix failed");
  }
  const prefix = result.stdout.trim();
  GIT_SHOW_PREFIX_CACHE.set(cacheKey, prefix ? `${prefix.replace(/\/+$/, "")}/` : "");
  return GIT_SHOW_PREFIX_CACHE.get(cacheKey);
}

function gitShow(root, base, path) {
  const treeishPath = `${gitShowPrefix(root)}${path}`;
  const result = spawnSync("git", ["-C", root, "show", `${base}:${treeishPath}`], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const error = (result.stderr || Buffer.alloc(0)).toString("utf8").trim();
    throw new Error(error || `git show ${base}:${treeishPath} failed`);
  }
  return result.stdout;
}

function sourceContents(root, path, base) {
  const rel = relativeSourcePath(root, path);
  if (base) return { path: rel, contents: gitShow(root, base, rel) };
  const absolute = resolve(root, rel);
  if (!existsSync(absolute)) throw new Error(`source file does not exist: ${rel}`);
  return { path: rel, contents: readFileSync(absolute) };
}

function receiptIdFor(target) {
  if (typeof target.receiptId === "string" && target.receiptId) return target.receiptId;
  if (typeof target.receipt === "string" && target.receipt) return target.receipt;
  if (target.receipt && typeof target.receipt === "object" && typeof target.receipt.id === "string" && target.receipt.id) {
    return target.receipt.id;
  }
  return null;
}

function authFingerprintConfig(auth) {
  const config = auth != null && typeof auth === "object" && !Array.isArray(auth) ? auth : {};
  const account = typeof config.account === "string"
    ? config.account
    : (typeof config.accountId === "string" ? config.accountId : null);
  const alias = typeof config.alias === "string"
    ? config.alias
    : (typeof config.accountAlias === "string" ? config.accountAlias : null);
  return {
    mode: typeof config.mode === "string" ? config.mode : null,
    account,
    alias,
    // A storage-state file selects a browser session. Its basename is enough
    // to distinguish configured sessions without making a machine-specific
    // absolute path part of the fingerprint.
    storageState: typeof config.storageState === "string" && config.storageState
      ? basename(config.storageState)
      : null,
  };
}

function webTargetUrl(cfg, target) {
  if ((cfg.capture?.mode ?? "playwright") !== "playwright") return null;
  // Metro's baseUrl merely tells rn-sim where to find JavaScript; it does not
  // address the rendered native screen and therefore cannot change its pixels.
  // Playwright navigates this exact composed URL, so its web origin must be
  // fingerprinted for relative routes while absolute routes retain their own.
  return composeWebUrl(cfg.baseUrl, target.route, target.params);
}

function targetCaptureConfig(cfg, target) {
  const mode = cfg.capture?.mode ?? "playwright";
  return {
    mode,
    capture: cfg.capture ?? null,
    viewports: cfg.viewports ?? null,
    settleMs: cfg.settleMs ?? 350,
    // The effective Playwright waits, defaults applied like settleMs above.
    // rn-sim has no such keys (config validation rejects them there), so its
    // identity keeps its existing shape.
    ...(mode === "playwright" ? { webTimeouts: webCaptureTimeouts(cfg.capture) } : {}),
    target: {
      fullPage: target.fullPage ?? true,
      clip: target.clip ?? null,
      axe: target.axe ?? true,
      waitFor: target.waitFor ?? null,
      timeoutMs: target.timeoutMs ?? 15_000,
      settleMs: target.settleMs ?? cfg.settleMs ?? 350,
      interactions: target.interactions ?? [],
      captureVariants: target.captureVariants ?? ["default"],
      scrollProbe: target.scrollProbe ?? null,
      cropRequests: (cfg.cropRequests || []).filter((request) =>
        typeof request?.assetId === "string" && request.assetId.startsWith(`${target.id}/`),
      ),
      flow: target.flow ?? null,
    },
  };
}

function assetVariantIdentity(cfg, target) {
  return {
    appearances: cfg.capture?.mode === "rn-sim"
      ? (cfg.capture.appearance?.length ? cfg.capture.appearance : ["light", "dark"])
      : ["default"],
    viewports: cfg.capture?.mode === "rn-sim"
      ? null
      : (cfg.viewports ?? ["default"]),
    variants: target.captureVariants ?? ["default"],
    interactions: (target.interactions ?? []).map((interaction) => ({
      id: interaction.id,
      action: interaction.action,
      screenshot: interaction.screenshot ?? null,
    })),
    crop: target.clip ?? null,
    cropRequests: (cfg.cropRequests || []).filter((request) =>
      typeof request?.assetId === "string" && request.assetId.startsWith(`${target.id}/`),
    ),
  };
}

function driverVersion(cfg) {
  const mode = cfg.capture?.mode ?? "playwright";
  const implementationFiles = DRIVER_IMPLEMENTATION_FILES[mode];
  if (!implementationFiles) throw new Error(`unsupported capture mode for fingerprinting: ${mode}`);
  const hash = createHash("sha256");
  for (const file of implementationFiles) {
    const source = readFileSync(join(SKILL_DIR, "scripts", file));
    hash.update(`${file.length}:`);
    hash.update(file);
    hash.update("\0");
    hash.update(`${source.length}:`);
    hash.update(source);
    hash.update("\0");
  }
  return {
    package: PACKAGE_VERSION,
    mode,
    driver: implementationFiles[0],
    implementationFiles,
    sourceHash: `sha256:${hash.digest("hex")}`,
  };
}

/**
 * A missing sourceFiles declaration, a missing source file, or an unavailable
 * --base revision is deliberately unverifiable. A source-less target is never
 * silently fresh based on a timestamp or a coincidental old capture.
 */
function fingerprintTarget(cfg, target, { base = null } = {}) {
  if (!Array.isArray(target.sourceFiles) || target.sourceFiles.length === 0) {
    return {
      fingerprint: null,
      inputs: null,
      reason: "target has no sourceFiles ownership",
    };
  }
  let sourceFiles;
  try {
    sourceFiles = target.sourceFiles
      .map((path) => sourceContents(cfg.root, path, base))
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(({ path, contents }) => ({ path, hash: digest(contents) }));
  } catch (err) {
    return {
      fingerprint: null,
      inputs: null,
      reason: `sourceFiles unavailable${base ? ` at ${base}` : ""}: ${err.message}`,
    };
  }
  const effectiveWebTargetUrl = webTargetUrl(cfg, target);
  const inputs = canonicalize({
    sourceFiles,
    route: target.route,
    params: target.params ?? {},
    role: target.role ?? null,
    stateProfile: target.stateProfile ?? null,
    ...(effectiveWebTargetUrl == null ? {} : { webTargetUrl: effectiveWebTargetUrl }),
    auth: authFingerprintConfig(cfg.auth),
    receiptId: receiptIdFor(target),
    assetVariants: assetVariantIdentity(cfg, target),
    appBuild: target.appBuild ?? cfg.capture?.appBuild ?? cfg.appBuild ?? null,
    captureConfig: targetCaptureConfig(cfg, target),
    driverVersion: driverVersion(cfg),
  });
  return { fingerprint: digest(stableJson(inputs)), inputs, reason: null };
}

function equal(left, right) {
  return stableJson(left) === stableJson(right);
}

function changedFingerprintReason(previous, current) {
  if (!previous || !current) return "stored fingerprint inputs are unavailable";
  const sourceBefore = new Map((previous.sourceFiles || []).map((item) => [item.path, item.hash]));
  const sourceAfter = new Map((current.sourceFiles || []).map((item) => [item.path, item.hash]));
  const changedSources = new Set();
  for (const [path, hash] of sourceBefore) if (sourceAfter.get(path) !== hash) changedSources.add(path);
  for (const [path, hash] of sourceAfter) if (sourceBefore.get(path) !== hash) changedSources.add(path);
  if (changedSources.size) return `sourceFiles changed: ${[...changedSources].sort().join(", ")}`;
  if (!equal(previous.route, current.route)) return "route changed";
  if (!equal(previous.params, current.params)) return "params changed";
  if (!equal(previous.role, current.role)) return "role changed";
  if (!equal(previous.stateProfile, current.stateProfile)) return "state profile changed";
  if (!equal(previous.webTargetUrl, current.webTargetUrl)) return "web target URL changed";
  if (!equal(previous.auth, current.auth)) return "auth config changed";
  if (!equal(previous.receiptId, current.receiptId)) return "receipt id changed";
  if (!equal(previous.assetVariants, current.assetVariants)) return "asset variant identity changed";
  if (!equal(previous.appBuild, current.appBuild)) return "app build changed";
  if (!equal(previous.captureConfig, current.captureConfig)) return "capture config changed";
  if (!equal(previous.driverVersion, current.driverVersion)) return "driver version changed";
  return "fingerprint changed";
}

function framedHashUpdate(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  hash.update(`${bytes.length}:`);
  hash.update(bytes);
  hash.update("\0");
}

function untrackedPaths(status) {
  return status
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function untrackedPatchMaterial(root, paths) {
  const hash = createHash("sha256");
  const resolvedRoot = resolve(root);
  for (const path of paths) {
    framedHashUpdate(hash, path);
    const absolute = resolve(resolvedRoot, path);
    const rel = relative(resolvedRoot, absolute);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      framedHashUpdate(hash, "outside-project");
      continue;
    }
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        // Hash the link itself, not the bytes it might resolve to. This keeps
        // provenance inside the repository and makes broken links stable.
        framedHashUpdate(hash, `symlink:${readlinkSync(absolute)}`);
      } else if (stat.isFile()) {
        framedHashUpdate(hash, "file");
        framedHashUpdate(hash, readFileSync(absolute));
      } else {
        const type = stat.isDirectory()
          ? "directory"
          : stat.isFIFO()
            ? "fifo"
            : stat.isSocket()
              ? "socket"
              : stat.isBlockDevice()
                ? "block-device"
                : stat.isCharacterDevice()
                  ? "character-device"
                  : "other";
        // Do not open special files: a FIFO can block and a device can read
        // arbitrary host state. Their lstat-visible type is the provenance.
        framedHashUpdate(hash, `type:${type}`);
      }
    } catch (err) {
      // A capture can race a clean/build that removes an untracked file after
      // Git reported it. Preserve a deterministic record of that state rather
      // than making provenance collection fail.
      framedHashUpdate(hash, err.code === "ENOENT" ? "missing" : `unavailable:${err.code || "unknown"}`);
    }
  }
  return hash.digest();
}

function gitProvenance(root, { maxBuffer = GIT_DIFF_MAX_BUFFER } = {}) {
  const run = (args, encoding = "utf8") => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding, maxBuffer });
    if (result.status !== 0) return null;
    return encoding === null ? result.stdout : result.stdout.trim();
  };
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = run(["rev-parse", "HEAD"]);
  const status = run(["status", "--porcelain=v1", "--untracked-files=all", "-z"], null);
  if (branch == null || commit == null || status == null) return { branch: null, commit: null, patchHash: null };
  if (status.length === 0) return { branch, commit, patchHash: null };
  const patch = run(["diff", "--no-ext-diff", "--binary", "HEAD"]);
  // A failed or oversized diff is unknown provenance. Hashing it as an empty
  // patch would make distinct edits look identical and falsely fresh later.
  if (patch == null) return { branch, commit, patchHash: null };
  const patchMaterial = createHash("sha256");
  framedHashUpdate(patchMaterial, status);
  framedHashUpdate(patchMaterial, patch);
  // git diff HEAD excludes untracked files. Include each reported file's bytes
  // so edits to an untracked asset cannot collide with the previous capture.
  framedHashUpdate(patchMaterial, untrackedPatchMaterial(root, untrackedPaths(status)));
  return { branch, commit, patchHash: `sha256:${patchMaterial.digest("hex")}` };
}

function captureProvenance(cfg, captureManifest) {
  const git = gitProvenance(cfg.root);
  return {
    ...git,
    appBuild: cfg.capture?.appBuild ?? cfg.appBuild ?? null,
    device: captureManifest.device ?? (
      cfg.capture?.mode === "rn-sim"
        ? { name: cfg.capture?.simulator?.deviceName ?? cfg.capture?.udid ?? null, bundleId: cfg.capture?.bundleId ?? null }
        : { mode: "playwright", viewports: cfg.viewports ?? null }
    ),
  };
}

module.exports = {
  assetVariantIdentity,
  authFingerprintConfig,
  captureProvenance,
  changedFingerprintReason,
  driverVersion,
  fingerprintTarget,
  gitProvenance,
  receiptIdFor,
  stableJson,
  untrackedPatchMaterial,
};
