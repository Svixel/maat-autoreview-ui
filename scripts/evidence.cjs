/**
 * Capture-evidence helpers shared by ui-review and the durable library.
 *
 * A crop is deliberately derived only from a completed capture PNG. It never
 * asks a backend to render a second, special-purpose frame: the crop is a
 * first-class view of evidence that already exists in the run.
 */

"use strict";

const { existsSync, lstatSync, readFileSync, writeFileSync } = require("node:fs");
const { isAbsolute, join, relative, resolve, sep } = require("node:path");
const { cropPng, decodePng } = require("./png.cjs");
const { assetIdentity } = require("./library.cjs");
const { shotFile } = require("./capture-contract.cjs");

function assetIdFor(target, asset, captureManifest, cfg, interaction = false) {
  const identity = assetIdentity(target, asset, captureManifest, cfg, interaction);
  return [
    identity.targetId,
    identity.appearance,
    identity.variant,
    identity.interaction ?? "base",
  ].join("/");
}

/** Attach the stable, logical asset id used by crop requests to every PNG. */
function assignAssetIds(captureManifest, cfg) {
  const targets = new Map((cfg.routes || []).map((target) => [target.id, target]));
  for (const manifestTarget of captureManifest.targets || []) {
    const target = targets.get(manifestTarget.id) || manifestTarget;
    for (const shot of manifestTarget.shots || []) {
      shot.assetId ??= assetIdFor(target, shot, captureManifest, cfg);
    }
    for (const interaction of manifestTarget.interactions || []) {
      interaction.assetId ??= assetIdFor(target, interaction, captureManifest, cfg, true);
    }
  }
  return captureManifest;
}

function captureAssets(captureManifest) {
  const assets = [];
  for (const target of captureManifest.targets || []) {
    for (const shot of target.shots || []) {
      if (shot.path && shot.assetId) assets.push({ target, asset: shot, interaction: false, pathKey: "path" });
    }
    for (const interaction of target.interactions || []) {
      if (interaction.statePath && interaction.assetId) {
        assets.push({ target, asset: interaction, interaction: true, pathKey: "statePath" });
      }
    }
  }
  return assets;
}

function safeCaptureAssetPath(shotsDir, candidate) {
  const root = resolve(shotsDir);
  const path = resolve(candidate);
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !rel.toLowerCase().endsWith(".png")) {
    throw new Error(`crop source is not a PNG inside shots/: ${candidate}`);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`crop source is missing or unsafe: ${candidate}`);
  return path;
}

function normalizedRectToPixels(rect, image) {
  return {
    x: rect.x * image.width,
    y: rect.y * image.height,
    width: rect.w * image.width,
    height: rect.h * image.height,
  };
}

function requestRect(request, source, image) {
  if (request.rect) return normalizedRectToPixels(request.rect, image);
  const frame = source.selectorFrames?.[request.axSelector];
  if (!frame) {
    if (source.selectorOutsideClip?.includes(request.axSelector)) {
      throw new Error(
        `crop request ${request.assetId}/${request.purpose}: selector outside clipped area (${JSON.stringify(request.axSelector)})`,
      );
    }
    throw new Error(
      `crop request ${request.assetId}/${request.purpose} cannot resolve axSelector ${JSON.stringify(request.axSelector)} on its captured asset`,
    );
  }
  return normalizedRectToPixels(frame, image);
}

function cropOutputParts(source, purpose) {
  // `shotFile` sanitizes its parts for filesystem safety. Encode the complete
  // logical identity first so distinct variants, interactions, and purposes
  // cannot collapse to the same sanitized filename.
  const encode = (value) => Buffer.from(String(value), "utf8").toString("base64url");
  return [
    source.asset.viewport ?? "default",
    "crop",
    `asset-${encode(source.asset.assetId)}`,
    `purpose-${encode(purpose)}`,
  ];
}

/**
 * Materialize declared crops in shots/. Errors are kept target-scoped so a
 * malformed request cannot erase a successful base capture from a partial run.
 */
function produceCrops({ captureManifest, cfg, shotsDir, outputShotsDir = shotsDir, cropRequests = [] }) {
  assignAssetIds(captureManifest, cfg);
  const assets = new Map(captureAssets(captureManifest).map((entry) => [entry.asset.assetId, entry]));
  const errors = [];
  const produced = [];
  const requests = [...cropRequests].sort((left, right) =>
    left.assetId === right.assetId
      ? left.purpose.localeCompare(right.purpose)
      : left.assetId.localeCompare(right.assetId),
  );

  for (const request of requests) {
    const source = assets.get(request.assetId);
    const targetId = request.assetId.split("/", 1)[0] || null;
    try {
      if (!source) throw new Error(`crop request references no captured asset: ${request.assetId}`);
      const sourcePath = safeCaptureAssetPath(shotsDir, source.asset[source.pathKey]);
      const buffer = readFileSync(sourcePath);
      const image = decodePng(buffer);
      const rect = requestRect(request, source.asset, image);
      const cropped = cropPng(buffer, rect);
      if (!cropped) throw new Error(`crop request ${request.assetId}/${request.purpose} is outside the captured PNG`);
      const cropId = request.purpose;
      const outputPath = shotFile(outputShotsDir, source.target.id, cropOutputParts(source, cropId));
      if (existsSync(outputPath)) throw new Error(`crop output already exists for ${request.assetId}/${cropId}`);
      writeFileSync(outputPath, cropped);
      const crop = {
        viewport: source.asset.viewport ?? "default",
        path: outputPath,
        kind: "crop",
        // Preserve the underlying sweep identity. `cropId` is the extra axis
        // that makes this a distinct durable-library asset.
        variant: assetIdentity(source.target, source.asset, captureManifest, cfg, source.interaction).variant,
        cropId,
        assetId: `${source.asset.assetId}/crop/${cropId}`,
        sourceAssetId: source.asset.assetId,
        interactionId: source.interaction ? source.asset.id : null,
        purpose: request.purpose,
        rect: request.rect ?? source.asset.selectorFrames?.[request.axSelector] ?? null,
      };
      source.target.shots.push(crop);
      assets.set(crop.assetId, { target: source.target, asset: crop, interaction: false, pathKey: "path" });
      produced.push(crop);
    } catch (err) {
      const target = (captureManifest.targets || []).find((candidate) => candidate.id === targetId);
      const message = `crop ${request.assetId}/${request.purpose}: ${err.message}`;
      if (target) target.errors = [...(target.errors || []), message];
      else errors.push(message);
    }
  }
  return { produced, errors };
}

module.exports = {
  assetIdFor,
  assignAssetIds,
  captureAssets,
  cropOutputParts,
  produceCrops,
};
