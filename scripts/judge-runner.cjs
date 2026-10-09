/**
 * Automated judge executor. It is intentionally separate from pack building:
 * the builder is deterministic, while this module is the only place an engine
 * adapter is allowed to run. Recording always goes back through ui-review's
 * existing --record --run command rather than opening a second log writer.
 */

"use strict";

const { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { homedir, tmpdir } = require("node:os");
const { basename, delimiter: hostPathDelimiter, dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { produceCrops, assignAssetIds } = require("./evidence.cjs");
const { isSafeTargetId, resolveContainedRealPath, targetManifestFile } = require("./capture-contract.cjs");
const {
  assertPackAssetHashesMatchCapture,
  initialExemplarPlan,
  loadChecklistRubric,
  renderInitialPrompt,
  resolveExemplarScreenshot,
  targetEvidenceWithPromptDigests,
} = require("./judge-pack.cjs");
const { JUDGE_LOCK_OWNER_ENV, acquireJudgeLock, assertJudgeLock, releaseJudgeLock } = require("./judge-lock.cjs");
const { readLog, resolveReviewPath } = require("./review-record.cjs");
const { finalizeCaptureRun, loadCompletedCaptureRun } = require("./ui-review");
const { CHECKLIST_PHASES, normalizeConfig, recordCompleteness, validateFinding, validateJudgePack, validateJudgeResponse, validateReviewEvents } = require("../schemas/validator.cjs");

const SKILL_DIR = dirname(__dirname);
const UI_REVIEW = join(SKILL_DIR, "scripts", "ui-review");
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const DEFAULT_ENGINE_TIMEOUT_MS = 10 * 60 * 1000;
const ENGINE_TIMEOUT_ENV = "AUTOREVIEW_UI_JUDGE_TIMEOUT_MS";
const ENGINE_TIMEOUT_KILL_SIGNAL = "SIGTERM";
const CLI_OPT_IN_ENV = "AUTOREVIEW_UI_ALLOW_UNCONFINED_JUDGE";
const DEFAULT_API_PROVIDER = "openai";
const DEFAULT_API_MODEL = "gpt-5.6";
const REASONING_EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Validate the optional judge model + reasoning effort the config may set. */
function resolveJudgeModelSelection(judge = {}) {
  const model = judge.model ?? null;
  if (model !== null && (typeof model !== "string" || !MODEL_NAME_PATTERN.test(model))) {
    throw new JudgeExecutorError(`judge.model must be a bare model name (letters, digits, ".", "_", ":" or "-"); got ${JSON.stringify(model)}`, "config");
  }
  const reasoningEffort = judge.reasoningEffort ?? null;
  if (reasoningEffort !== null && !REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new JudgeExecutorError(`judge.reasoningEffort must be one of ${REASONING_EFFORTS.join(", ")}; got ${JSON.stringify(reasoningEffort)}`, "config");
  }
  return { model, reasoningEffort };
}
const DEFAULT_API_RETRIES = 2;
const DEFAULT_MAX_FINDINGS_PER_BATCH = 12;
const DEFAULT_MAX_FINDINGS_PER_RUN = 48;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const PROVIDER_API_KEY_ENVS = Object.freeze({ openai: "OPENAI_API_KEY" });
// OpenAI Structured Outputs accepts a documented subset of JSON Schema. Keep
// this list explicit so adding a keyword to a published local schema cannot
// silently add an unsupported transport constraint. Type-specific constraints
// listed here are supported for the non-fine-tuned models used by this adapter;
// the full published schemas are still applied locally after parsing.
const OPENAI_STRICT_SCHEMA_KEYWORDS = Object.freeze(new Set([
  "$defs",
  "$ref",
  "additionalProperties",
  "anyOf",
  "const",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maximum",
  "maxItems",
  "minimum",
  "minItems",
  "multipleOf",
  "pattern",
  "properties",
  "required",
  "type",
]));
const VERIFICATION_CROP_JOURNAL = "judge/verification-crop.journal.json";
const VERIFICATION_CROP_STAGE_PREFIX = ".crop-staging-";
const VERIFICATION_CROP_ID = /^verify-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[a-f0-9]{16})?$/i;
const SYSTEM_READ_PATHS = [
  "/System/Library",
  // dyld's shared cache lives inside the OS cryptex on modern macOS; without
  // these two, every sandboxed binary aborts inside dyld before main().
  "/System/Volumes/Preboot/Cryptexes/OS",
  "/System/Cryptexes/OS",
  "/usr/lib",
  "/usr/share",
  "/private/var/db/timezone",
];

// DNS resolution (getaddrinfo), TLS trust evaluation, and proxy discovery on
// macOS are brokered through these system services over mach IPC. Verified
// live 2026-08-12: without them a sandboxed Codex reaches "Reconnecting…"
// exhaustion on every request; with only these seven (no extra file reads)
// it completes an API round-trip.
const NETWORK_MACH_SERVICES = [
  "com.apple.dnssd.service",
  "com.apple.trustd.agent",
  "com.apple.trustd",
  "com.apple.SecurityServer",
  "com.apple.networkd",
  "com.apple.nehelper",
  "com.apple.SystemConfiguration.configd",
];

class JudgeExecutorError extends Error {
  constructor(message, phase = "executor") {
    super(message);
    this.name = "JudgeExecutorError";
    this.phase = phase;
  }
}

function judgeEngineTimeoutMs(configuredTimeoutMs, environment = process.env) {
  const override = environment?.[ENGINE_TIMEOUT_ENV];
  const value = override === undefined ? configuredTimeoutMs ?? DEFAULT_ENGINE_TIMEOUT_MS : override;
  if (typeof value === "string" && !/^[1-9]\d*$/.test(value)) {
    throw new JudgeExecutorError(`${ENGINE_TIMEOUT_ENV} must be a positive integer number of milliseconds`, "engine");
  }
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new JudgeExecutorError("judge engine timeout must be a positive integer number of milliseconds", "engine");
  }
  return timeoutMs;
}

function openAiStrictWireSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new JudgeExecutorError("OpenAI strict response schema nodes must be objects", "config");
  }
  const wire = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (!OPENAI_STRICT_SCHEMA_KEYWORDS.has(keyword)) continue;
    if (keyword === "properties" || keyword === "$defs") {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      wire[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, openAiStrictWireSchema(child)]),
      );
      continue;
    }
    if (keyword === "items") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        wire.items = openAiStrictWireSchema(value);
      }
      continue;
    }
    if (keyword === "anyOf") {
      if (Array.isArray(value)) wire.anyOf = value.map(openAiStrictWireSchema);
      continue;
    }
    if (keyword === "additionalProperties") {
      if (value === false) wire.additionalProperties = false;
      continue;
    }
    wire[keyword] = structuredClone(value);
  }
  return wire;
}

function apiInitialResponseSchema(maxFindingsPerBatch = DEFAULT_MAX_FINDINGS_PER_BATCH) {
  const finding = readJson(join(SKILL_DIR, "schemas", "finding.v2.json"), "finding schema");
  const response = readJson(join(SKILL_DIR, "schemas", "judge-response.v1.json"), "judge-response schema");
  // Verification-only and optional storage fields are intentionally absent
  // from the API wire schema. The runner still applies the full published
  // judge-response.v1/finding.v2 validators to the returned JSON.
  for (const key of ["cropId", "cropDigest", "exemplarRefs"]) delete finding.properties[key];
  response.properties.findings.items = finding;
  response.properties.findings.maxItems = maxFindingsPerBatch;
  return openAiStrictWireSchema(response);
}

function apiVerificationResponseSchema() {
  return openAiStrictWireSchema({
    type: "object",
    additionalProperties: false,
    required: ["verifierVerdict", "evidence"],
    properties: {
      verifierVerdict: { enum: ["confirmed", "rejected", "not-judged"] },
      evidence: { type: "string", minLength: 1 },
    },
  });
}

function resolveApiJudgeConfig(config, environment = process.env) {
  const judge = config?.judge || {};
  const provider = judge.provider ?? DEFAULT_API_PROVIDER;
  if (provider !== "openai") {
    throw new JudgeExecutorError(`unsupported judge API provider ${JSON.stringify(provider)}`, "config");
  }
  const apiKeyEnvCandidates = [
    judge.apiKeyEnv,
    "AUTOREVIEW_UI_JUDGE_API_KEY",
    PROVIDER_API_KEY_ENVS[provider],
  ].filter((value, index, values) => typeof value === "string" && value && values.indexOf(value) === index);
  const apiKeyEnv = apiKeyEnvCandidates.find((name) => typeof environment?.[name] === "string" && environment[name].trim());
  if (!apiKeyEnv) {
    throw new JudgeExecutorError(
      `automated ui-judge has no API credential; set AUTOREVIEW_UI_JUDGE_API_KEY (or ${PROVIDER_API_KEY_ENVS[provider]}), or explicitly select --engine codex and set ${CLI_OPT_IN_ENV}=1 to accept CLI credential exposure`,
      "engine",
    );
  }
  const selection = resolveJudgeModelSelection(judge);
  return {
    provider,
    model: selection.model ?? DEFAULT_API_MODEL,
    reasoningEffort: selection.reasoningEffort,
    maxRetries: judge.maxRetries ?? DEFAULT_API_RETRIES,
    maxFindingsPerBatch: judge.maxFindingsPerBatch ?? DEFAULT_MAX_FINDINGS_PER_BATCH,
    maxFindingsPerRun: judge.maxFindingsPerRun ?? DEFAULT_MAX_FINDINGS_PER_RUN,
    apiKey: environment[apiKeyEnv],
    apiKeyEnv,
    url: OPENAI_RESPONSES_URL,
  };
}

function imageDataUrl(path) {
  return `data:image/png;base64,${readFileSync(path).toString("base64")}`;
}

function buildApiEngineRequest({ images, prompt, phase }, { api }) {
  const schema = phase === "verification"
    ? apiVerificationResponseSchema()
    : apiInitialResponseSchema(api.maxFindingsPerBatch ?? DEFAULT_MAX_FINDINGS_PER_BATCH);
  const name = phase === "verification" ? "judge_verification_v1" : "judge_response_v1";
  const body = {
    model: api.model,
    ...(api.reasoningEffort ? { reasoning: { effort: api.reasoningEffort } } : {}),
    store: false,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        ...images.map((path) => ({ type: "input_image", image_url: imageDataUrl(path), detail: "high" })),
      ],
    }],
    text: { format: { type: "json_schema", name, strict: true, schema } },
  };
  return {
    url: api.url,
    method: "POST",
    headers: {
      authorization: `Bearer ${api.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

async function defaultApiTransport(request, { signal } = {}) {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal,
  });
  return { status: response.status, ok: response.ok, body: await response.text() };
}

function retryableApiStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function apiResponseOutputText(payload) {
  if (typeof payload?.status === "string" && payload.status !== "completed") {
    const detail = payload?.incomplete_details?.reason ? ` (${payload.incomplete_details.reason})` : "";
    throw new JudgeExecutorError(`judge API response status was ${payload.status}${detail}`, "engine");
  }
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  const parts = [];
  for (const item of payload?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") parts.push(content.text);
      if (content?.type === "refusal") throw new JudgeExecutorError("judge API refused the request", "engine");
    }
  }
  if (parts.length) return parts.join("");
  const detail = payload?.incomplete_details?.reason ? ` (${payload.incomplete_details.reason})` : "";
  throw new JudgeExecutorError(`judge API response contained no output text${detail}`, "engine");
}

async function apiTransportAttempt(transport, request, call, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => transport(request, { signal: controller.signal, call })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error(`judge API timed out after ${timeoutMs}ms`);
          error.code = "AUTOREVIEW_UI_API_TIMEOUT";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function apiEngineAdapter(call, {
  api,
  timeoutMs,
  transport = defaultApiTransport,
} = {}) {
  if (!api || typeof api.apiKey !== "string" || !api.apiKey) {
    throw new JudgeExecutorError("judge API adapter requires runner-resolved credentials", "engine");
  }
  const request = buildApiEngineRequest(call, { api });
  const attempts = api.maxRetries + 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await apiTransportAttempt(transport, request, call, timeoutMs);
      const status = Number(response?.status);
      const ok = response?.ok ?? (status >= 200 && status < 300);
      if (!ok) {
        const error = new JudgeExecutorError(`judge API returned HTTP ${Number.isFinite(status) ? status : "unknown"}`, "engine");
        error.retryable = Number.isFinite(status) && retryableApiStatus(status);
        throw error;
      }
      let payload;
      try {
        payload = typeof response?.body === "string" ? JSON.parse(response.body) : response?.body;
      } catch (err) {
        throw new JudgeExecutorError(`judge API returned malformed response JSON: ${err.message}`, "engine");
      }
      return apiResponseOutputText(payload);
    } catch (err) {
      lastError = err instanceof JudgeExecutorError
        ? err
        : new JudgeExecutorError(err?.code === "AUTOREVIEW_UI_API_TIMEOUT" ? err.message : `judge API transport failed: ${err.message}`, "engine");
      const retryable = err?.code === "AUTOREVIEW_UI_API_TIMEOUT" || err?.retryable === true || !(err instanceof JudgeExecutorError);
      if (!retryable || attempt === attempts) break;
    }
  }
  throw lastError;
}

function readJson(path, description) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new JudgeExecutorError(`could not parse ${description}: ${err.message}`, "parse");
  }
}

function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function pathIsWithin(candidate, parent) {
  const rel = relative(parent, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function unsafeRunPath(description, path, detail) {
  const error = new JudgeExecutorError(`${description} is unsafe: ${path} (${detail})`, "pack");
  error.hard = true;
  return error;
}

function containedRunPath(runDir, candidate, description, { allowRoot = false } = {}) {
  try {
    const contained = resolveContainedRealPath(runDir, candidate, { allowRoot });
    return { absolute: contained.absolute, realRunRoot: contained.realRoot, runRoot: contained.root };
  } catch (err) {
    const detail = err.message
      .replace("path escapes its root", "escapes the capture run")
      .replace("root is not a real directory", "capture run is not a real directory")
      .replace("the real root", "the real capture run");
    throw unsafeRunPath(description, resolve(runDir, candidate), detail);
  }
}

function artifactPath(runDir, path, description) {
  if (typeof path !== "string" || !path) throw new JudgeExecutorError(`${description} has no path`, "pack");
  return containedRunPath(runDir, path, description).absolute;
}

function fileArtifact(runDir, path, description) {
  const absolute = artifactPath(runDir, path, description);
  try {
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
  } catch (err) {
    throw unsafeRunPath(description, absolute, err.message);
  }
  return absolute;
}

function assertBuilderWriteDirectory(runDir, path, description, { create = false } = {}) {
  const { absolute, realRunRoot, runRoot } = containedRunPath(runDir, path, description, { allowRoot: true });
  const rel = relative(runRoot, absolute);
  let current = runRoot;
  for (const part of rel ? rel.split(sep) : []) {
    current = join(current, part);
    let stat = lstatOrNull(current);
    if (!stat) {
      if (!create) return absolute;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (err) {
        if (err.code !== "EEXIST") throw unsafeRunPath(description, absolute, `${current}: ${err.message}`);
      }
      stat = lstatOrNull(current);
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw unsafeRunPath(description, absolute, `write directory component is not a real directory: ${current}`);
    }
    let resolved;
    try {
      resolved = realpathSync(current);
    } catch (err) {
      throw unsafeRunPath(description, absolute, `${current}: ${err.message}`);
    }
    if (!pathIsWithin(resolved, realRunRoot)) {
      throw unsafeRunPath(description, absolute, `write directory escapes the real capture run: ${current} -> ${resolved}`);
    }
  }
  return absolute;
}

function assertBuilderWriteFile(runDir, path, description) {
  const absolute = artifactPath(runDir, path, description);
  assertBuilderWriteDirectory(runDir, dirname(absolute), `${description} parent`);
  const stat = lstatOrNull(absolute);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw unsafeRunPath(description, absolute, "write destination is not a real file");
  }
  return absolute;
}

function writeRunJsonAtomic(runDir, path, value, description) {
  const absolute = assertBuilderWriteFile(runDir, path, description);
  writeJsonAtomic(absolute, value);
}

function loadPack(packPath) {
  const absolute = resolve(packPath);
  const runDir = dirname(dirname(absolute));
  if (dirname(absolute) !== join(runDir, "judge") || !absolute.endsWith(`${sep}manifest.json`)) {
    throw new JudgeExecutorError("--pack must be <capture-dir>/judge/manifest.json", "pack");
  }
  const pack = readJson(absolute, "judge-pack manifest");
  const validation = validateJudgePack(pack);
  if (!validation.valid) {
    throw new JudgeExecutorError(`judge-pack manifest is invalid:\n${validation.errors.map((error) => `  - ${error}`).join("\n")}`, "pack");
  }
  return { packPath: absolute, runDir, pack };
}

function loadBoundRubric(pack) {
  let rubric;
  try {
    rubric = loadChecklistRubric();
  } catch (cause) {
    const error = new JudgeExecutorError(`could not load the checklist and verification templates: ${cause.message}`, "pack");
    error.hard = true;
    throw error;
  }
  const mismatched = (pack.targets || []).filter((targetId) =>
    pack.targetJudgmentEvidence?.[targetId]?.rubricDigest !== rubric.digest,
  );
  if (mismatched.length) {
    const error = new JudgeExecutorError(
      `judge pack rubric digest does not match the loaded checklist and verification template bytes for target(s): ${mismatched.join(", ")}`,
      "pack",
    );
    error.hard = true;
    throw error;
  }
  return rubric;
}

function createJudgeScratchDirectory() {
  // realpathSync matters: macOS tmpdir() lives under /var, a symlink to
  // /private/var, and sandbox-exec evaluates resolved vnode paths — a
  // profile written with the symlinked spelling denies every scratch write.
  return realpathSync(mkdtempSync(join(tmpdir(), "autoreview-ui-judge-")));
}

function sandboxString(value) {
  return JSON.stringify(value);
}

function executableNames(command, platform, pathExtValue) {
  if (platform !== "win32" || /\.[^\\/]+$/.test(command)) return [command];
  const pathExt = typeof pathExtValue === "string" && pathExtValue
    ? pathExtValue
    : ".COM;.EXE;.BAT;.CMD";
  const names = [command];
  for (const extension of pathExt.split(";").map((entry) => entry.trim()).filter(Boolean)) {
    const normalized = extension.startsWith(".") ? extension : `.${extension}`;
    names.push(`${command}${normalized.toLowerCase()}`, `${command}${normalized}`);
  }
  return [...new Set(names)];
}

function findExecutable(command, pathValue, { platform = process.platform, pathExtValue = process.env.PATHEXT } = {}) {
  if (isAbsolute(command)) return resolve(command);
  const delimiter = platform === "win32" ? ";" : hostPathDelimiter;
  const names = executableNames(command, platform, pathExtValue);
  for (const directory of String(pathValue || "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return resolve(candidate);
    }
  }
  throw new JudgeExecutorError(`could not resolve ${command} from the supplied PATH`, "engine");
}

function codexHomeFor(environment) {
  return resolve(environment.CODEX_HOME || join(environment.HOME || homedir(), ".codex"));
}

function codexPlatformPackage(platform = process.platform, arch = process.arch) {
  const target = {
    "darwin:x64": "x86_64-apple-darwin",
    "darwin:arm64": "aarch64-apple-darwin",
    "linux:x64": "x86_64-unknown-linux-musl",
    "linux:arm64": "aarch64-unknown-linux-musl",
    "android:x64": "x86_64-unknown-linux-musl",
    "android:arm64": "aarch64-unknown-linux-musl",
    "win32:x64": "x86_64-pc-windows-msvc",
    "win32:arm64": "aarch64-pc-windows-msvc",
  }[`${platform}:${arch}`];
  if (!target) return null;
  const suffix = target.startsWith("aarch64-apple") ? "darwin-arm64"
    : target.startsWith("x86_64-apple") ? "darwin-x64"
      : target.startsWith("aarch64-unknown-linux") ? "linux-arm64"
        : target.startsWith("x86_64-unknown-linux") ? "linux-x64"
          : target.startsWith("aarch64-pc-windows") ? "win32-arm64"
            : "win32-x64";
  return { target, packageName: `codex-${suffix}`, executable: platform === "win32" ? "codex.exe" : "codex" };
}

function codexPackageRoot(path) {
  const marker = `${sep}node_modules${sep}@openai${sep}codex${sep}`;
  const index = path.indexOf(marker);
  return index < 0 ? null : path.slice(0, index + marker.length - 1);
}

/** Resolve the native Codex binary so the profile need not permit Node. */
function nativeCodexExecutable(codexPath, platform = process.platform) {
  let realCodexPath = resolve(codexPath);
  try {
    realCodexPath = realpathSync(codexPath);
  } catch {
    return resolve(codexPath);
  }
  const packageRoot = codexPackageRoot(realCodexPath);
  const spec = codexPlatformPackage(platform);
  if (!packageRoot || !spec) return realCodexPath;
  for (const openAiRoot of [join(packageRoot, "node_modules", "@openai"), dirname(packageRoot)]) {
    const candidate = join(openAiRoot, spec.packageName, "vendor", spec.target, "bin", spec.executable);
    if (existsSync(candidate)) return resolve(candidate);
  }
  return realCodexPath;
}

function runtimePathsForCodex(codexPath) {
  const paths = new Set([resolve(codexPath)]);
  let realCodexPath = resolve(codexPath);
  try {
    realCodexPath = realpathSync(codexPath);
    paths.add(realCodexPath);
  } catch {
    // The fake adapter tests intentionally use a synthetic executable path.
  }
  const packageRoot = codexPackageRoot(realCodexPath);
  if (packageRoot) {
    // The JavaScript launcher resolves the platform binary from its sibling
    // @openai package, so permit that package family but no general npm root.
    paths.add(packageRoot);
    paths.add(dirname(packageRoot));
  }
  return [...paths];
}

function executableNeedsNode(executable) {
  try {
    return readFileSync(executable, "utf8").slice(0, 128).startsWith("#!/usr/bin/env node");
  } catch {
    return false;
  }
}

/**
 * The opted-in CLI child starts from no inherited environment. HOME is the
 * empty scratch directory and locale is the only non-path input carried from
 * the parent. This limits unrelated exposure; it does not hide auth.json from
 * the model running inside that same process.
 */
function buildJudgeEnvironment({
  scratchDir,
  codexPath,
  environment = process.env,
  codexHome,
  needsNode = executableNeedsNode(codexPath),
  platform = process.platform,
}) {
  if (typeof codexHome !== "string" || !codexHome) {
    throw new JudgeExecutorError("judge environment requires an isolated CODEX_HOME", "engine");
  }
  const pathEntries = [
    dirname(resolve(codexPath)),
    ...(needsNode ? [dirname(resolve(process.execPath))] : []),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const delimiter = platform === "win32" ? ";" : hostPathDelimiter;
  const env = {
    PATH: [...new Set(pathEntries)].join(delimiter),
    HOME: resolve(scratchDir),
    CODEX_HOME: resolve(codexHome),
    TMPDIR: resolve(scratchDir),
  };
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE"]) {
    if (typeof environment[key] === "string" && environment[key]) env[key] = environment[key];
  }
  return env;
}

/**
 * The explicitly opted-in CLI needs auth.json for exec. Copy only that file
 * instead of exposing the real CODEX_HOME, then remove the scratch tree after
 * the call. The copy is still readable by the judge process; raw output is
 * therefore scanned for its credential material before parsing or persistence.
 */
function createIsolatedCodexHome({ scratchDir, codexHome }) {
  const sourceHome = resolve(codexHome);
  const sourceAuth = join(sourceHome, "auth.json");
  let sourceStat;
  try {
    sourceStat = lstatSync(sourceAuth);
  } catch (err) {
    throw new JudgeExecutorError(`Codex auth.json is unavailable in ${sourceHome}: ${err.message}`, "engine");
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new JudgeExecutorError(`Codex auth.json is not a regular file: ${sourceAuth}`, "engine");
  }
  const isolatedHome = join(resolve(scratchDir), "codex-home");
  try {
    mkdirSync(isolatedHome, { recursive: true, mode: 0o700 });
    chmodSync(isolatedHome, 0o700);
    copyFileSync(sourceAuth, join(isolatedHome, "auth.json"));
    chmodSync(join(isolatedHome, "auth.json"), 0o600);
  } catch (err) {
    throw new JudgeExecutorError(`could not prepare isolated Codex auth home: ${err.message}`, "engine");
  }
  return isolatedHome;
}

/**
 * `sandbox-exec` applies to Codex and every shell child it creates. It starts
 * deny-by-default, admits only the immutable inputs required for inference,
 * and allows writes solely in the empty scratch directory.
 */
function buildJudgeSandboxProfile({ scratchDir, images, codexHome, runtimePaths }) {
  const readSubpaths = [
    resolve(scratchDir),
    resolve(codexHome),
    ...images.map((image) => resolve(image)),
    ...runtimePaths.map((path) => resolve(path)),
    ...SYSTEM_READ_PATHS,
  ];
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-info*)",
    "(allow sysctl-read)",
    // Codex needs outbound TLS to its API. The macOS sandbox language has no
    // stable hostname allowlist primitive, so deny-default still rules out
    // inbound listeners and all filesystem access outside the entries below.
    "(allow network-outbound)",
    // Path resolution needs ancestor metadata, and dyld's CacheFinder reads
    // the root directory itself while locating the shared cache — without
    // the "/" literal every sandboxed binary dies in dyld with SIGABRT.
    "(allow file-read-metadata)",
    `(allow file-read* (literal ${sandboxString("/")}))`,
  ];
  for (const path of [...new Set(readSubpaths)]) lines.push(`(allow file-read* (subpath ${sandboxString(path)}))`);
  for (const path of [...new Set(runtimePaths)]) lines.push(`(allow process-exec (subpath ${sandboxString(path)}))`);
  // Mapping pages executable is a distinct sandbox operation from reading
  // them; dyld needs it for the shared cache and every loaded dylib.
  for (const path of [...new Set([...runtimePaths.map((path) => resolve(path)), ...SYSTEM_READ_PATHS])]) {
    lines.push(`(allow file-map-executable (subpath ${sandboxString(path)}))`);
  }
  for (const service of NETWORK_MACH_SERVICES) lines.push(`(allow mach-lookup (global-name ${sandboxString(service)}))`);
  for (const path of ["/dev/null", "/dev/urandom"]) lines.push(`(allow file-read* (literal ${sandboxString(path)}))`);
  lines.push(`(allow file-write* (subpath ${sandboxString(resolve(scratchDir))}))`);
  lines.push(`(allow file-write* (literal ${sandboxString("/dev/null")}))`);
  return `${lines.join("\n")}\n`;
}

/**
 * Keep every CLI confinement switch in this one argv builder. `codex exec`
 * has no inference-only/tool-free boundary here; `--sandbox read-only` still
 * exposes read tools. macOS adds an outer sandbox, but CLI execution remains
 * dangerous opt-in because neither layer hides the copied credential.
 */
function buildCodexEngineInvocation({
  images,
  scratchDir = createJudgeScratchDirectory(),
  environment = process.env,
  platform = process.platform,
  codexPath = null,
  sandboxExecutable = SANDBOX_EXEC,
  model = null,
  reasoningEffort = null,
}) {
  const selection = resolveJudgeModelSelection({ model, reasoningEffort });
  const cwd = resolve(scratchDir);
  if (environment[CLI_OPT_IN_ENV] !== "1") {
    throw new JudgeExecutorError(
      `Codex CLI judging is disabled by default because prompt injection can expose its copied auth.json; set ${CLI_OPT_IN_ENV}=1 only if you explicitly accept that credential exposure`,
      "engine",
    );
  }
  const launcherPath = codexPath ? resolve(codexPath) : findExecutable("codex", environment.PATH, {
    platform,
    pathExtValue: environment.PATHEXT,
  });
  const executable = nativeCodexExecutable(launcherPath, platform);
  const codexHome = createIsolatedCodexHome({ scratchDir: cwd, codexHome: codexHomeFor(environment) });
  const env = buildJudgeEnvironment({ scratchDir: cwd, codexPath: executable, environment, codexHome, platform });
  const args = [
    "exec",
    "--sandbox", "read-only",
    "-C", cwd,
    "--ignore-user-config",
    "--ignore-rules",
    // These known feature flags stop discovery paths in addition to the
    // empty isolated CODEX_HOME. The latter remains the security boundary.
    "--disable", "plugins",
    "--disable", "skill_search",
    "--skip-git-repo-check",
    "--ephemeral",
    "-c", "tools.web_search=false",
    "-c", "mcp_servers={}",
  ];
  // `--ignore-user-config` means the operator's ~/.codex/config.toml model
  // never reaches the judge; the config's judge.model / judge.reasoningEffort
  // are the only way to pick them, passed as explicit overrides.
  if (selection.model) args.push("-c", `model=${selection.model}`);
  if (selection.reasoningEffort) args.push("-c", `model_reasoning_effort=${selection.reasoningEffort}`);
  for (const image of images) args.push("-i", resolve(image));
  args.push("-");
  if (platform === "darwin") {
    const profilePath = join(cwd, "codex-judge.sb");
    const profile = buildJudgeSandboxProfile({
      scratchDir: cwd,
      images: images.map((image) => resolve(image)),
      codexHome,
      runtimePaths: runtimePathsForCodex(executable),
    });
    writeFileSync(profilePath, profile, { mode: 0o600 });
    return {
      command: sandboxExecutable,
      args: ["-f", profilePath, executable, ...args],
      cwd,
      env,
      codexArgs: args,
      codexHome,
      codexPath: executable,
      profilePath,
      profile,
    };
  }
  return {
    command: executable,
    args,
    cwd,
    env,
    codexArgs: args,
    codexHome,
    codexPath: executable,
    warning: `WARNING: ui-judge is running without macOS sandbox-exec by explicit ${CLI_OPT_IN_ENV}=1 override; the copied CLI credential and residual host files may be exposed to prompt injection.`,
  };
}

function authCredentialMaterial(authPath) {
  const raw = readFileSync(authPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const values = [];
  const visit = (value) => {
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  if (parsed === null) values.push(raw.trim());
  else visit(parsed);
  return [...new Set(values.filter((value) => typeof value === "string" && value.length >= 8))];
}

function assertNoCredentialInCodexOutput(result, credentialMaterial, label) {
  const output = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  if (!credentialMaterial.some((value) => output.includes(value))) return;
  const message = `WARNING: refusing Codex CLI output for ${label}: it contains material copied from auth.json`;
  console.error(message);
  throw new JudgeExecutorError(`${message}; the batch requires agent review and no engine output will be persisted`, "engine");
}

/** Explicitly opted-in legacy CLI adapter. The API adapter is the default. */
function codexEngineAdapter({ images, prompt, batch, finding, phase }, {
  spawn = spawnSync,
  environment = process.env,
  platform = process.platform,
  codexPath = null,
  sandboxExecutable = SANDBOX_EXEC,
  timeoutMs = null,
  model = null,
  reasoningEffort = null,
} = {}) {
  const scratchDir = createJudgeScratchDirectory();
  let result;
  let credentialMaterial = [];
  const engineTimeoutMs = timeoutMs ?? judgeEngineTimeoutMs(undefined, environment);
  try {
    const invocation = buildCodexEngineInvocation({ images, scratchDir, environment, platform, codexPath, sandboxExecutable, model, reasoningEffort });
    credentialMaterial = authCredentialMaterial(join(invocation.codexHome, "auth.json"));
    if (invocation.warning) console.error(invocation.warning);
    try {
      result = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        input: prompt,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: engineTimeoutMs,
        killSignal: ENGINE_TIMEOUT_KILL_SIGNAL,
      });
    } catch (err) {
      throw new JudgeExecutorError(`codex engine failed to start: ${err.message}`, "engine");
    }
  } finally {
    // This exact mkdtemp-created directory is the only destructive target;
    // image attachments stay at their original absolute paths and are never
    // copied into the judge workspace.
    rmSync(scratchDir, { recursive: true, force: true, maxRetries: 1 });
  }
  const label = phase === "initial" ? `batch ${batch?.id ?? "unknown"}` : `verification ${finding?.id ?? "unknown"}`;
  assertNoCredentialInCodexOutput(result, credentialMaterial, label);
  if (result.error?.code === "ETIMEDOUT") {
    throw new JudgeExecutorError(
      `codex engine timed out after ${engineTimeoutMs}ms${result.signal ? ` and was terminated with ${result.signal}` : ""}`,
      "engine",
    );
  }
  if (result.signal) {
    throw new JudgeExecutorError(`codex engine was terminated by signal ${result.signal}`, "engine");
  }
  if (result.error) throw new JudgeExecutorError(`codex engine failed to start: ${result.error.message}`, "engine");
  if (result.status !== 0) {
    throw new JudgeExecutorError(`codex engine exited ${result.status}: ${(result.stderr || result.stdout || "no output").trim()}`, "engine");
  }
  return result.stdout;
}

function parseJsonOutput(output, phase) {
  const text = typeof output === "string" ? output.trim() : "";
  const unwrapped = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)?.[1] ?? text;
  try {
    return JSON.parse(unwrapped);
  } catch (err) {
    throw new JudgeExecutorError(`${phase} engine output is not parseable JSON: ${err.message}`, phase);
  }
}

function candidateAssetMap(images) {
  const map = new Map();
  for (const image of images) {
    if (!image.referenceOnly) map.set(image.assetId, image);
  }
  return map;
}

function isUnlocalizableClaim(finding, assets, targetIds) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) return false;
  const region = finding.region;
  const localizedRegion = region && typeof region === "object" &&
    region.normalized === true &&
    [region.x, region.y, region.w, region.h].every((value) => typeof value === "number" && Number.isFinite(value)) &&
    region.x >= 0 && region.y >= 0 && region.w > 0 && region.h > 0 &&
    region.x + region.w <= 1 && region.y + region.h <= 1;
  const asset = assets.get(finding.assetId);
  return !targetIds.includes(finding.targetId) || !asset || asset.targetId !== finding.targetId || !localizedRegion;
}

/**
 * Validate every field that is not a target/asset/region binding before a
 * localization rejection is considered. This prevents garbage engine output
 * from being upgraded into a synthetic, schema-shaped rejected finding.
 */
function validateNonLocalizationFields(raw, assets, targetIds, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new JudgeExecutorError(`initial finding ${index} is not an object`, "initial");
  }
  const fallback = [...assets.values()][0];
  if (!fallback || !targetIds.length) throw new JudgeExecutorError(`initial finding ${index} has no batch localization baseline`, "initial");
  const validation = validateFinding({
    ...raw,
    targetId: fallback.targetId,
    assetId: fallback.assetId,
    region: { x: 0, y: 0, w: 1, h: 1, normalized: true },
  });
  if (!validation.valid) {
    throw new JudgeExecutorError(`initial finding ${index} is not finding.v2 apart from localization:\n${validation.errors.map((error) => `  - ${error}`).join("\n")}`, "initial");
  }
  if (raw.initialVerdict !== "finding" || raw.verifierVerdict !== "not-judged" || raw.disposition !== "not-judged") {
    throw new JudgeExecutorError(`initial finding ${index} must be unverified (finding/not-judged/not-judged)`, "initial");
  }
}

/**
 * The immutable finding schema requires a region even for a rejected claim.
 * This is called only after all non-localization fields have validated. The
 * full-screen sentinel binds the rejection to an actual selected asset.
 */
function unlocalizableCandidate(raw, assets, targetIds) {
  const fallback = [...assets.values()][0];
  const targetFallback = targetIds.includes(raw.targetId)
    ? [...assets.values()].find((candidate) => candidate.targetId === raw.targetId)
    : null;
  const asset = assets.get(raw.assetId) ?? targetFallback ?? fallback;
  return {
    ...raw,
    targetId: asset.targetId,
    assetId: asset.assetId,
    region: { x: 0, y: 0, w: 1, h: 1, normalized: true },
    _unlocalizable: true,
  };
}

function phaseForRuleId(ruleId, phases) {
  return typeof ruleId === "string"
    ? phases.find((phase) => ruleId.startsWith(`${phase}/`)) ?? null
    : null;
}

function assertFindingCoverageAgreement(coverage, findings, phases) {
  const errors = [];
  for (const finding of findings) {
    const phase = phaseForRuleId(finding?.ruleId, phases);
    if (!phase) {
      errors.push(`finding ${finding?.id ?? "<missing id>"} has ruleId ${JSON.stringify(finding?.ruleId)} without a canonical checklist phase prefix`);
      continue;
    }
    const entries = coverage.filter((entry) => entry.targetId === finding.targetId && entry.phase === phase);
    if (entries.length !== 1 || entries[0].result !== "findings") {
      errors.push(`finding ${finding.id} requires coverage ${finding.targetId}/${phase} with result findings`);
    }
  }
  for (const entry of coverage) {
    if (entry.result === "findings" && !findings.some((finding) =>
      finding?.targetId === entry.targetId && phaseForRuleId(finding?.ruleId, phases) === entry.phase,
    )) {
      errors.push(`coverage ${entry.targetId}/${entry.phase} declares findings without a matching finding`);
    }
  }
  if (errors.length) {
    throw new JudgeExecutorError(`initial engine findings and coverage disagree:\n${errors.map((error) => `  - ${error}`).join("\n")}`, "initial");
  }
}

function findingsCapViolation(message) {
  console.error(`WARNING: ${message}; treating the batch response as a contract violation`);
  return new JudgeExecutorError(`${message}; the batch response violates the findings-count contract`, "initial");
}

function parseInitialFindings(output, {
  images,
  targetIds,
  phases = CHECKLIST_PHASES,
  batchId = "<unknown>",
  maxFindingsPerBatch = DEFAULT_MAX_FINDINGS_PER_BATCH,
}) {
  const payload = parseJsonOutput(output, "initial");
  if (Array.isArray(payload?.findings) && payload.findings.length > maxFindingsPerBatch) {
    throw findingsCapViolation(
      `batch ${batchId} returned ${payload.findings.length} findings, exceeding judge.maxFindingsPerBatch=${maxFindingsPerBatch}`,
    );
  }
  const responseValidation = validateJudgeResponse(payload, { targetIds, phases, maxFindings: maxFindingsPerBatch });
  if (!responseValidation.valid) {
    throw new JudgeExecutorError(`initial engine output must be a valid judge-response.v1:\n${responseValidation.errors.map((error) => `  - ${error}`).join("\n")}`, "initial");
  }
  const assets = candidateAssetMap(images);
  const seen = new Set();
  const findings = payload.findings.map((finding, index) => {
    validateNonLocalizationFields(finding, assets, targetIds, index);
    if (isUnlocalizableClaim(finding, assets, targetIds)) {
      const candidate = unlocalizableCandidate(finding, assets, targetIds);
      if (seen.has(candidate.id)) throw new JudgeExecutorError(`initial finding ${index} duplicates id ${candidate.id}`, "initial");
      seen.add(candidate.id);
      return candidate;
    }
    const validation = validateFinding(finding);
    if (!validation.valid) {
      throw new JudgeExecutorError(`initial finding ${index} is not finding.v2:\n${validation.errors.map((error) => `  - ${error}`).join("\n")}`, "initial");
    }
    if (!targetIds.includes(finding.targetId) || !assets.has(finding.assetId) || assets.get(finding.assetId).targetId !== finding.targetId) {
      throw new JudgeExecutorError(`initial finding ${index} references a target or asset outside its batch`, "initial");
    }
    if (seen.has(finding.id)) throw new JudgeExecutorError(`initial finding ${index} duplicates id ${finding.id}`, "initial");
    seen.add(finding.id);
    const { verifierVerdict, disposition, exemplarRefs, ...candidate } = finding;
    return { ...candidate, ...(exemplarRefs ? { _exemplarRefs: exemplarRefs } : {}) };
  });
  // Coverage must bind to the target that will actually be recorded. An
  // otherwise valid claim with an out-of-batch target or cross-target asset
  // binding is remapped to its available asset before becoming a rejected
  // unlocalizable candidate, so comparing coverage against the raw claim
  // would make that documented rejection impossible to seal.
  assertFindingCoverageAgreement(payload.coverage, findings, phases);
  return { findings, coverage: payload.coverage };
}

function parseVerification(output) {
  const payload = parseJsonOutput(output, "verification");
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 2 || !["confirmed", "rejected", "not-judged"].includes(payload.verifierVerdict) || typeof payload.evidence !== "string" || !payload.evidence.trim()) {
    throw new JudgeExecutorError("verification engine output must be { verifierVerdict, evidence }", "verification");
  }
  return payload;
}

function renderVerification(template, values) {
  return template
    .replace("{{findingJson}}", JSON.stringify(values.finding, null, 2))
    .replace("{{cropJson}}", JSON.stringify(values.crop, null, 2));
}

function configDigest(config) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    return value;
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(config))).digest("hex")}`;
}

function recordHeader({ cfg, run, pack, model }) {
  const commitHash = typeof run.commitHash === "string" ? run.commitHash : typeof run.commit === "string" ? run.commit : null;
  const patchHash = typeof run.patchHash === "string" ? run.patchHash : null;
  return {
    kind: "record-header",
    version: 1,
    runId: run.runId,
    project: cfg.name,
    configHash: run.configHash ?? configDigest(cfg),
    commitHash,
    patchHash,
    targets: pack.targets,
    targetShotHashes: pack.targetShotHashes,
    intentSource: cfg.intentDoc ?? "intent not configured",
    rubricVersion: "rubric.v1",
    model,
    createdAt: new Date().toISOString(),
  };
}

function dispositionFor(verifierVerdict) {
  return verifierVerdict === "confirmed" ? "accepted" : verifierVerdict === "rejected" ? "rejected" : "not-judged";
}

function coverageNotJudgedCandidate(targetId, image, coverage) {
  const notJudged = coverage.filter((entry) => entry.result === "not-judged");
  const phases = [...new Set(notJudged.map((entry) => entry.phase))];
  // Executor-sealed entries (findings-budget exhaustion) carry a note naming
  // the real cause; the default text is reserved for coverage the judge model
  // itself marked not-judged.
  const notes = [...new Set(notJudged.map((entry) => entry.note).filter((note) => typeof note === "string" && note.trim()))];
  const cause = notes.length ? notes.join(" ") : `Initial judge coverage explicitly marked ${phases.join(", ")} as not-judged.`;
  return {
    id: randomUUID(),
    ruleId: "coverage/not-judged",
    targetId,
    assetId: image.assetId,
    region: { x: 0, y: 0, w: 1, h: 1, normalized: true },
    evidence: `${cause} This target cannot seal clean.`,
    priority: "P3",
    confidence: 1,
    initialVerdict: "not-judged",
    verifierVerdict: "not-judged",
    disposition: "not-judged",
    scope: "in-scope",
    _coverageNotJudged: true,
    _coverageEvidence: cause,
  };
}

function captureFingerprint(run, targetId) {
  if (!Object.prototype.hasOwnProperty.call(run.targetFingerprints || {}, targetId)) return undefined;
  const entry = run.targetFingerprints[targetId];
  if (entry === null || typeof entry === "string") return entry;
  return entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "fingerprint")
    ? entry.fingerprint
    : undefined;
}

/**
 * A pack is an immutable view of a capture. A replaced run.json must never
 * let old images be judged while its new fingerprint is later sealed.
 */
function assertPackFingerprintsMatchCapture(pack, run) {
  const mismatched = pack.targets.filter((targetId) => pack.targetFingerprints[targetId] !== captureFingerprint(run, targetId));
  if (!mismatched.length) return;
  const error = new JudgeExecutorError(
    `judge pack target fingerprints do not match the current capture run for target(s): ${mismatched.join(", ")}`,
    "pack",
  );
  // This is a hard binding failure, not a degraded model result. In
  // particular, do not add a cursor or executor-outcome state write.
  error.hard = true;
  throw error;
}

function assertPackAssetHashesMatchCaptureHard(pack, run, captureManifest, shotsDir) {
  try {
    assertPackAssetHashesMatchCapture(pack, run, captureManifest, shotsDir);
  } catch (cause) {
    const error = new JudgeExecutorError(cause.message, "pack");
    // A byte-binding failure is a hard precondition failure: never turn it
    // into an executor outcome or append any review state.
    error.hard = true;
    throw error;
  }
}

function sameNormalizedRect(left, right) {
  return left?.normalized === true && right?.normalized === true &&
    ["x", "y", "w", "h"].every((key) => left[key] === right[key]);
}

function existingVerificationCrop(captureManifest, candidate, cropId) {
  const target = (captureManifest.targets || []).find((entry) => entry.id === candidate.targetId);
  return target?.shots?.find((shot) =>
    shot.cropId === cropId &&
    shot.sourceAssetId === candidate.assetId &&
    sameNormalizedRect(shot.rect, candidate.region) &&
    typeof shot.path === "string",
  ) ?? null;
}

function verificationCropId(captureManifest, candidate) {
  const base = `verify-${candidate.id}`;
  const priorBindings = (captureManifest.targets || []).flatMap((target) =>
    (target.shots || [])
      .filter((shot) => shot.cropId === base && typeof shot.path === "string")
      .map((shot) => ({ targetId: target.id, shot })),
  );
  if (!priorBindings.length) return base;
  const identical = priorBindings.every(({ targetId, shot }) =>
    targetId === candidate.targetId &&
    shot.sourceAssetId === candidate.assetId &&
    sameNormalizedRect(shot.rect, candidate.region),
  );
  if (identical) return base;
  // A retry can retain the finding UUID while narrowing or shifting its
  // evidence target, source asset, or region. Keep the original crop as
  // durable evidence and make the replacement identity evidence-specific so
  // produceCrops cannot overwrite it.
  const suffix = createHash("sha256")
    .update(JSON.stringify([
      candidate.targetId,
      candidate.assetId,
      candidate.region.x,
      candidate.region.y,
      candidate.region.w,
      candidate.region.h,
    ]))
    .digest("hex")
    .slice(0, 16);
  return `${base}-${suffix}`;
}

function outcomePath(runDir, pack) {
  return join(runDir, "judge", "builds", pack.packId, "executor-outcome.json");
}

function recordedPackMismatch(runDir, detail) {
  const error = new JudgeExecutorError(
    `judge pack does not match its completed recorded judgment (${detail}); rebuild it with ${UI_REVIEW} --judge-pack --run ${runDir}`,
    "pack",
  );
  error.hard = true;
  return error;
}

function judgmentMatchesTarget(pack, targetId) {
  const judgment = pack.judgedFingerprints?.[targetId];
  const evidence = pack.targetJudgmentEvidence?.[targetId];
  return judgment && typeof judgment === "object" && evidence &&
    judgment.fingerprint === pack.targetFingerprints?.[targetId] &&
    judgment.baseEvidenceDigest === evidence.baseEvidenceDigest &&
    judgment.evidenceDigest === evidence.evidenceDigest &&
    judgment.rubricDigest === evidence.rubricDigest &&
    isDeepStrictEqual(judgment.promptDigests, evidence.promptDigests) &&
    ["clean", "accepted", "rejected", "not-judged"].includes(judgment.disposition);
}

function sameTargetSet(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    new Set(left).size === left.length && left.every((targetId) => right.includes(targetId));
}

function validateRecordedEventsForPack(events, { runDir, pack, cfg, capture, description }) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const validation = validateReviewEvents(events, {
    targetIds: (cfg.routes || []).map((target) => target.id),
    capturedTargetIds: capture.run.targetIds,
    capturedTargetOutcomes: capture.run.targetOutcomes,
    capturedTargetShotHashes: capture.run.targetShotHashes,
  });
  const completeness = recordCompleteness(events);
  if (!validation.valid) {
    throw recordedPackMismatch(runDir, `${description} is invalid: ${validation.errors.join("; ")}`);
  }
  const header = events[0];
  if (header.runId !== pack.runId || header.project !== pack.project || !sameTargetSet(header.targets, pack.targets)) {
    throw recordedPackMismatch(runDir, `${description} target set or run identity changed`);
  }
  return { events, completeness, header };
}

function recordEventsPath(runDir, pack) {
  return join(runDir, "judge", "builds", pack.packId, "record-events.json");
}

function readRecordEventsJournal({ runDir, pack, cfg, capture }) {
  const path = recordEventsPath(runDir, pack);
  if (!existsSync(path)) return null;
  const safePath = fileArtifact(runDir, path, "preserved record-event journal");
  const events = readJson(safePath, "preserved record-event journal");
  const state = validateRecordedEventsForPack(events, {
    runDir,
    pack,
    cfg,
    capture,
    description: `preserved record-event journal for pack ${pack.packId}`,
  });
  if (!state?.completeness.sealed || !state.completeness.complete) {
    throw recordedPackMismatch(runDir, `preserved record-event journal for pack ${pack.packId} is not completely sealed`);
  }
  return { path: safePath, ...state };
}

function reviewOutcomeFromState(path, state) {
  return {
    path,
    events: state.events.length,
    appended: 0,
    status: state.completeness.status,
    sealed: state.completeness.sealed,
    seal: state.completeness.seal,
    complete: state.completeness.complete,
    initials: state.completeness.initials,
    verifications: state.completeness.verifications,
    dispositions: state.completeness.dispositions,
    pendingFindingIds: state.completeness.pendingFindingIds,
  };
}

/**
 * A successful executor run is terminal for its exact pack. Reusing the same
 * manifest must not spend another engine call or replay a sealed record batch.
 */
function completedRecordedJudgment({ runDir, packPath, pack, cfg, capture, configPath, judgeLock }) {
  const path = outcomePath(runDir, pack);
  const expectedReviewPath = resolveReviewPath(
    { project: pack.project, runId: pack.runId },
    { projectRoot: cfg.root },
  );
  let outcome = null;
  let outcomeReadError = null;
  if (existsSync(path)) {
    try {
      outcome = readJson(path, "judge executor outcome");
    } catch (cause) {
      outcomeReadError = cause;
    }
  }

  let events;
  try {
    events = readLog(expectedReviewPath);
  } catch (cause) {
    throw recordedPackMismatch(runDir, `the sealed review cannot be read: ${cause.message}`);
  }
  let reviewState = validateRecordedEventsForPack(events, {
    runDir,
    pack,
    cfg,
    capture,
    description: "the durable review",
  });
  const recordedOutcome = outcome?.version === "judge-executor-outcome.v1" && outcome.outcome === "recorded";
  const reviewComplete = reviewState?.completeness.sealed === true && reviewState.completeness.complete === true;
  const existingJudgmentMismatch = pack.targets.filter((targetId) =>
    pack.judgedFingerprints?.[targetId] && !judgmentMatchesTarget(pack, targetId),
  );
  if (existingJudgmentMismatch.length) {
    throw recordedPackMismatch(runDir, `fingerprints or judgment evidence changed for target(s): ${existingJudgmentMismatch.join(", ")}`);
  }
  const judgmentsComplete = pack.targets.every((targetId) => judgmentMatchesTarget(pack, targetId));
  const reusableOutcome = recordedOutcome &&
    outcome.review?.sealed === true &&
    outcome.review?.complete === true &&
    typeof outcome.review.path === "string" &&
    resolve(outcome.review.path) === expectedReviewPath;

  if (reviewComplete && judgmentsComplete && reusableOutcome) {
    return {
      outcome: "recorded",
      review: outcome.review,
      pack,
      reused: true,
      note: "existing sealed judgment already recorded; no engine calls made",
    };
  }

  // A generated record batch is an immutable journal under this packId. It is
  // safe to replay through the sole writer when the durable seal is absent,
  // or when the seal committed but pack/cursor finalization lagged.
  let journal = null;
  let journalArtifact = null;
  if (!events.length || reviewComplete) {
    journal = readRecordEventsJournal({ runDir, pack, cfg, capture });
    if (journal) journalArtifact = packRelative(runDir, journal.path);
  }
  let recorded = null;
  if (!events.length && journal) {
    recorded = recordThroughUiReview({
      eventsPath: journal.path,
      runDir,
      pack,
      configPath,
      judgeLock,
    });
  } else if (reviewComplete && !judgmentsComplete) {
    let replayPath = journal?.path;
    if (!replayPath) {
      replayPath = recordEventsPath(runDir, pack);
      writeRunJsonAtomic(runDir, replayPath, reviewState.events, "recovered record-event journal");
      journalArtifact = packRelative(runDir, replayPath);
    }
    recorded = recordThroughUiReview({
      eventsPath: replayPath,
      runDir,
      pack,
      configPath,
      judgeLock,
    });
  }

  if (recorded) {
    try {
      events = readLog(expectedReviewPath);
    } catch (cause) {
      throw recordedPackMismatch(runDir, `the reconciled sealed review cannot be read: ${cause.message}`);
    }
    reviewState = validateRecordedEventsForPack(events, {
      runDir,
      pack,
      cfg,
      capture,
      description: "the reconciled durable review",
    });
  }

  if (!reviewState?.completeness.sealed || !reviewState.completeness.complete) {
    if (recordedOutcome || outcomeReadError) {
      const detail = outcomeReadError
        ? `the executor outcome is unreadable: ${outcomeReadError.message}`
        : "the durable review is absent, invalid, or not completely sealed";
      throw recordedPackMismatch(runDir, detail);
    }
    return null;
  }

  let latestPack = loadPack(packPath).pack;
  const mismatchedTargets = latestPack.targets.filter((targetId) => !judgmentMatchesTarget(latestPack, targetId));
  if (mismatchedTargets.length) {
    throw recordedPackMismatch(runDir, `fingerprints or judgment evidence changed for target(s): ${mismatchedTargets.join(", ")}`);
  }

  const review = recorded?.review ?? reviewOutcomeFromState(expectedReviewPath, reviewState);
  writeRunJsonAtomic(runDir, path, {
    version: "judge-executor-outcome.v1",
    outcome: "recorded",
    at: new Date().toISOString(),
    review,
  }, "judge executor outcome");
  const outcomeArtifact = packRelative(runDir, path);
  const reconciledArtifacts = [outcomeArtifact, journalArtifact].filter(Boolean);
  if (reconciledArtifacts.some((artifact) => !latestPack.artifacts.includes(artifact))) {
    latestPack = updatePack(packPath, latestPack, {
      artifacts: [...latestPack.artifacts, ...reconciledArtifacts],
    });
  }
  return {
    outcome: "recorded",
    review,
    pack: latestPack,
    reused: true,
    note: "existing sealed judgment reconciled and recorded; no engine calls made",
  };
}

function updatePack(packPath, pack, change) {
  const next = structuredClone(pack);
  Object.assign(next, change);
  next.artifacts = [...new Set(next.artifacts)].sort();
  const validation = validateJudgePack(next);
  if (!validation.valid) throw new JudgeExecutorError(`refusing to write invalid judge pack:\n${validation.errors.map((error) => `  - ${error}`).join("\n")}`, "pack");
  writeRunJsonAtomic(dirname(dirname(packPath)), packPath, next, "judge-pack manifest");
  return next;
}

function needsAgent({ packPath, runDir, pack, error }) {
  // ui-review --record can seal its log and update judgedFingerprints before
  // failing to advance the external cursor. Never publish a failure artifact
  // from this executor's stale pre-record copy in that ordering.
  const latestPack = loadPack(packPath).pack;
  const path = outcomePath(runDir, latestPack);
  const existingOutcome = readJsonOrNull(path);
  if (existingOutcome?.version === "judge-executor-outcome.v1" &&
      existingOutcome.outcome === "recorded" &&
      existingOutcome.review?.sealed === true &&
      existingOutcome.review?.complete === true) {
    return path;
  }
  const outcome = {
    version: "judge-executor-outcome.v1",
    outcome: "needs-agent",
    at: new Date().toISOString(),
    phase: error.phase || "executor",
    reason: error.message,
  };
  writeRunJsonAtomic(runDir, path, outcome, "judge executor outcome");
  const rel = relative(runDir, path).split(sep).join("/");
  updatePack(packPath, latestPack, { artifacts: [...latestPack.artifacts, rel] });
  return path;
}

function recordThroughUiReview({ eventsPath, runDir, pack, configPath, judgeLock }) {
  assertJudgeLock(judgeLock, runDir);
  const args = [UI_REVIEW];
  if (configPath) args.push("--config", configPath);
  else args.push("--project", pack.project);
  args.push("--record", eventsPath, "--run", runDir, "--json");
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, [JUDGE_LOCK_OWNER_ENV]: String(process.pid) },
  });
  if (result.error) throw new JudgeExecutorError(`ui-review --record failed to start: ${result.error.message}`, "record");
  if (result.status !== 0) throw new JudgeExecutorError(`ui-review --record failed: ${(result.stderr || result.stdout || "no output").trim()}`, "record");
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new JudgeExecutorError(`ui-review --record emitted invalid JSON: ${err.message}`, "record");
  }
}

function hardAttachmentError(message) {
  const error = new JudgeExecutorError(message, "pack");
  error.hard = true;
  return error;
}

function attachmentDigest(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function verifyPrompt(runDir, path, expectedDigest, description) {
  const absolute = fileArtifact(runDir, path, description);
  if (typeof expectedDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(expectedDigest)) {
    throw hardAttachmentError(`${description} is missing a valid prompt digest`);
  }
  const bytes = readFileSync(absolute);
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== expectedDigest) {
    throw hardAttachmentError(`${description} digest does not match its packed bytes`);
  }
  return { path: absolute, prompt: bytes.toString("utf8"), digest: actual };
}

function verifyInitialPrompt(runDir, pack, batch, screenAttachmentCount) {
  const description = `prompt for batch ${batch.id} (${batch.prompt})`;
  const absolute = fileArtifact(runDir, batch.prompt, description);
  if (typeof batch.promptDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(batch.promptDigest)) {
    throw hardAttachmentError(`${description} is missing a valid prompt digest`);
  }
  const prompt = renderInitialPrompt(readFileSync(absolute, "utf8"), {
    screenAttachmentCount,
    exemplars: pack.exemplars,
  });
  const actual = `sha256:${createHash("sha256").update(Buffer.from(prompt, "utf8")).digest("hex")}`;
  if (actual !== batch.promptDigest) {
    throw hardAttachmentError(`${description} final rendered digest does not match its packed prompt contract`);
  }
  return { path: absolute, prompt, digest: actual };
}

function verifyRenderedPrompt(runDir, path, expectedDigest, renderedPrompt, description) {
  const binding = verifyPrompt(runDir, path, expectedDigest, description);
  const renderedDigest = `sha256:${createHash("sha256").update(Buffer.from(renderedPrompt, "utf8")).digest("hex")}`;
  if (renderedDigest !== expectedDigest) {
    throw hardAttachmentError(`${description} rendered digest does not match its stored prompt contract`);
  }
  return { ...binding, prompt: renderedPrompt };
}

function verifyAttachment(runDir, pack, path, expectedDigest, description) {
  const absolute = fileArtifact(runDir, path, description);
  if (typeof expectedDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(expectedDigest)) {
    throw hardAttachmentError(`${description} is missing a valid attachment digest`);
  }
  if (pack.attachmentHashes?.[path] !== expectedDigest) {
    throw hardAttachmentError(`${description} digest does not match the judge-pack attachment contract`);
  }
  const actual = attachmentDigest(absolute);
  if (actual !== expectedDigest) {
    throw hardAttachmentError(`${description} digest does not match its packed bytes`);
  }
  return { path: absolute, digest: actual };
}

function bindVerificationCropDigest({ packPath, pack, runDir, crop }) {
  const path = packRelative(runDir, crop.path);
  const absolute = fileArtifact(runDir, path, `verification crop ${crop.cropId}`);
  const actual = attachmentDigest(absolute);
  const expected = pack.attachmentHashes?.[path];
  if (expected !== undefined && expected !== actual) {
    throw hardAttachmentError(`verification crop ${crop.cropId} digest does not match its packed bytes`);
  }
  const nextPack = expected === actual
    ? pack
    : updatePack(packPath, pack, { attachmentHashes: { ...pack.attachmentHashes, [path]: actual } });
  // Keep the second hash check immediately adjacent to the eventual engine
  // call; this protects a crop that existed before this executor began too.
  verifyAttachment(runDir, nextPack, path, actual, `verification crop ${crop.cropId}`);
  return { pack: nextPack, path, digest: actual };
}

function verificationCropJournalError(message) {
  const error = new JudgeExecutorError(`verification-crop journal is invalid: ${message}`, "pack");
  error.hard = true;
  return error;
}

function verificationCropJournalPath(runDir) {
  return join(runDir, VERIFICATION_CROP_JOURNAL);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function manifestCrop(manifest, journal) {
  return (manifest?.targets || [])
    .find((target) => target?.id === journal.targetId)
    ?.shots?.find((shot) => sameJson(shot, journal.crop)) ?? null;
}

function targetManifestSnapshots(runDir, manifest) {
  const snapshots = {};
  for (const target of manifest.targets || []) {
    if (!isSafeTargetId(target?.id)) {
      throw verificationCropJournalError(`capture manifest has an unsafe target id: ${target?.id}`);
    }
    const path = targetManifestFile(join(runDir, "shots"), target.id);
    const stat = lstatOrNull(path);
    snapshots[target.id] = stat ? readJson(fileArtifact(runDir, path, `capture target manifest ${target.id}`), `capture target manifest ${target.id}`) : null;
  }
  return snapshots;
}

function removeVerificationCropStage(runDir, stagingDir, stagedPath, digest) {
  const stageStat = lstatOrNull(stagingDir);
  if (!stageStat) return;
  assertBuilderWriteDirectory(runDir, stagingDir, "verification crop staging directory");
  const entries = readdirSync(stagingDir);
  for (const entry of entries) {
    const path = join(stagingDir, entry);
    if (path !== stagedPath) {
      throw verificationCropJournalError(`staging directory contains an unexpected entry: ${path}`);
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || attachmentDigest(path) !== digest) {
      throw verificationCropJournalError(`staged crop does not match its journal digest: ${path}`);
    }
    rmSync(path);
  }
  rmdirSync(stagingDir);
}

function removeVerificationCropFile(path, digest, description) {
  const stat = lstatOrNull(path);
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink() || attachmentDigest(path) !== digest) {
    throw verificationCropJournalError(`${description} does not match its journal digest: ${path}`);
  }
  rmSync(path);
}

function readVerificationCropJournal({ runDir, packPath, pack }) {
  const path = verificationCropJournalPath(runDir);
  const stat = lstatOrNull(path);
  if (!stat) return null;
  const absoluteJournal = assertBuilderWriteFile(runDir, path, "verification-crop journal");
  const journal = readJsonOrNull(absoluteJournal);
  if (
    !journal ||
    journal.version !== 1 ||
    journal.runId !== pack.runId ||
    journal.packId !== pack.packId ||
    !isSafeTargetId(journal.targetId) ||
    typeof journal.cropId !== "string" ||
    !VERIFICATION_CROP_ID.test(journal.cropId) ||
    typeof journal.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(journal.digest) ||
    !journal.paths ||
    !journal.before ||
    !journal.intended ||
    !Array.isArray(journal.before.cropRequests) ||
    !Array.isArray(journal.intended.cropRequests) ||
    !journal.before.captureManifest ||
    !journal.intended.captureManifest ||
    !journal.before.run ||
    !journal.before.targetManifests ||
    typeof journal.before.targetManifests !== "object" ||
    Array.isArray(journal.before.targetManifests) ||
    !journal.crop
  ) {
    throw verificationCropJournalError("shape or identity is malformed");
  }
  if (
    journal.before.run.runId !== pack.runId ||
    journal.crop.cropId !== journal.cropId ||
    journal.crop.sourceAssetId !== journal.request?.assetId ||
    journal.crop.purpose !== journal.request?.purpose ||
    !journal.crop.sourceAssetId.startsWith(`${journal.targetId}/`)
  ) {
    throw verificationCropJournalError("run or crop identity does not match");
  }

  const expectedPackPath = packRelative(runDir, packPath);
  const expectedCropRequestsPath = pack.cropRequests;
  const expectedManifestPath = "shots/manifest.json";
  const expectedRunPath = "run.json";
  if (
    journal.paths.pack !== expectedPackPath ||
    journal.paths.cropRequests !== expectedCropRequestsPath ||
    journal.paths.captureManifest !== expectedManifestPath ||
    journal.paths.run !== expectedRunPath
  ) {
    throw verificationCropJournalError("artifact paths do not match the active pack and capture");
  }

  assertBuilderWriteFile(runDir, packPath, "judge-pack manifest");
  const cropRequestsPath = assertBuilderWriteFile(runDir, pack.cropRequests, "crop-request scaffold");
  assertBuilderWriteFile(runDir, expectedManifestPath, "capture manifest");
  assertBuilderWriteFile(runDir, expectedRunPath, "capture run identity");
  const verificationDir = join(dirname(cropRequestsPath), "verification");
  const stagingDir = artifactPath(runDir, journal.paths.stagingDir, "verification crop staging directory");
  if (dirname(stagingDir) !== verificationDir || !basename(stagingDir).startsWith(VERIFICATION_CROP_STAGE_PREFIX)) {
    throw verificationCropJournalError("staging directory is outside the active verification build");
  }
  const stagedPath = artifactPath(runDir, journal.paths.stagedCrop, "staged verification crop");
  const cropPath = artifactPath(runDir, journal.paths.crop, "verification crop");
  if (dirname(stagedPath) !== stagingDir || dirname(cropPath) !== join(runDir, "shots") || basename(stagedPath) !== basename(cropPath)) {
    throw verificationCropJournalError("staged and final crop paths do not match");
  }
  const attachment = packRelative(runDir, cropPath);
  if (journal.attachment !== attachment || journal.crop.path !== cropPath) {
    throw verificationCropJournalError("crop path does not match its intended pack binding");
  }
  assertBuilderWriteFile(runDir, stagedPath, "staged verification crop");
  assertBuilderWriteFile(runDir, cropPath, "verification crop");
  if (!manifestCrop(journal.intended.captureManifest, journal)) {
    throw verificationCropJournalError("intended capture manifest does not contain the journaled crop");
  }
  const targetIds = journal.before.run.targetIds;
  if (!Array.isArray(targetIds) || targetIds.some((targetId) => !isSafeTargetId(targetId))) {
    throw verificationCropJournalError("prior run has unsafe targets");
  }
  if (Object.keys(journal.before.targetManifests).sort().join("\0") !== [...targetIds].sort().join("\0")) {
    throw verificationCropJournalError("target-manifest snapshots do not match the prior run");
  }
  return { ...journal, path: absoluteJournal, stagingDir, stagedPath, cropPath };
}

/**
 * Complete a fully finalized crop by binding it into the pack; otherwise put
 * the run back exactly at the pre-transaction capture/request state and remove
 * both staged and published crop bytes. The journal is removed last, making
 * either branch idempotent across another interruption during recovery.
 */
function recoverVerificationCropTransaction({ runDir, packPath, pack }) {
  const journal = readVerificationCropJournal({ runDir, packPath, pack });
  if (!journal) return pack;

  const currentPackDigest = pack.attachmentHashes?.[journal.attachment];
  if (currentPackDigest !== undefined && currentPackDigest !== journal.digest) {
    throw verificationCropJournalError(`pack binding has an unexpected digest for ${journal.attachment}`);
  }
  const currentRun = readJsonOrNull(join(runDir, journal.paths.run));
  const currentManifest = readJsonOrNull(join(runDir, journal.paths.captureManifest));
  const currentCropRequests = readJsonOrNull(join(runDir, journal.paths.cropRequests));
  const currentTargetManifest = readJsonOrNull(targetManifestFile(join(runDir, "shots"), journal.targetId));
  const cropStat = lstatOrNull(journal.cropPath);
  const cropBytesValid = !!cropStat && cropStat.isFile() && !cropStat.isSymbolicLink() && attachmentDigest(journal.cropPath) === journal.digest;
  const asset = journal.attachment.slice("shots/".length);
  const finalized =
    cropBytesValid &&
    sameJson(currentCropRequests, journal.intended.cropRequests) &&
    !!manifestCrop(currentManifest, journal) &&
    !!manifestCrop({ targets: [currentTargetManifest] }, journal) &&
    currentRun?.runId === journal.runId &&
    currentRun?.targetShotHashes?.[journal.targetId]?.[asset] === journal.digest;

  let nextPack = pack;
  if (finalized) {
    if (currentPackDigest === undefined) {
      nextPack = updatePack(packPath, pack, {
        attachmentHashes: { ...pack.attachmentHashes, [journal.attachment]: journal.digest },
      });
    }
  } else {
    if (cropStat && !cropBytesValid) {
      throw verificationCropJournalError(`published crop does not match its journal digest: ${journal.cropPath}`);
    }
    const stagedStat = lstatOrNull(journal.stagedPath);
    if (stagedStat && (!stagedStat.isFile() || stagedStat.isSymbolicLink() || attachmentDigest(journal.stagedPath) !== journal.digest)) {
      throw verificationCropJournalError(`staged crop does not match its journal digest: ${journal.stagedPath}`);
    }
    if (currentPackDigest === journal.digest) {
      const attachmentHashes = { ...pack.attachmentHashes };
      delete attachmentHashes[journal.attachment];
      nextPack = updatePack(packPath, pack, { attachmentHashes });
    }
    writeRunJsonAtomic(runDir, join(runDir, journal.paths.cropRequests), journal.before.cropRequests, "crop-request scaffold rollback");
    writeRunJsonAtomic(runDir, join(runDir, journal.paths.captureManifest), journal.before.captureManifest, "capture manifest rollback");
    for (const targetId of journal.before.run.targetIds) {
      const targetPath = targetManifestFile(join(runDir, "shots"), targetId);
      assertBuilderWriteFile(runDir, targetPath, `capture target manifest ${targetId} rollback`);
      const snapshot = journal.before.targetManifests[targetId];
      if (snapshot === null) {
        const targetStat = lstatOrNull(targetPath);
        if (targetStat) {
          if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
            throw verificationCropJournalError(`capture target manifest is unsafe during rollback: ${targetPath}`);
          }
          rmSync(targetPath);
        }
      } else {
        writeRunJsonAtomic(runDir, targetPath, snapshot, `capture target manifest ${targetId} rollback`);
      }
    }
    writeRunJsonAtomic(runDir, join(runDir, journal.paths.run), journal.before.run, "capture run rollback");
    removeVerificationCropFile(journal.cropPath, journal.digest, "published crop");
  }

  removeVerificationCropStage(runDir, journal.stagingDir, journal.stagedPath, journal.digest);
  rmSync(journal.path);
  return nextPack;
}

/**
 * Resolve a pending verification-crop transaction without starting an engine.
 * Pack construction calls this before replacing the root manifest so recovery
 * always retains the exact pack generation named by the journal.
 */
function recoverPendingVerificationCropTransactionLocked({ runDir, judgeLock }) {
  assertJudgeLock(judgeLock, runDir);
  const journalPath = verificationCropJournalPath(runDir);
  if (!lstatOrNull(journalPath)) return null;
  const loaded = loadPack(join(runDir, "judge", "manifest.json"));
  const pack = recoverVerificationCropTransaction({
    runDir: loaded.runDir,
    packPath: loaded.packPath,
    pack: loaded.pack,
  });
  return { ...loaded, pack, journalPath };
}

function recoverPendingVerificationCropTransaction(options) {
  let projectRoot = options.projectRoot ?? options.cfg?.root;
  if (!options.judgeLock && !projectRoot) {
    const loaded = loadPack(join(resolve(options.runDir), "judge", "manifest.json"));
    projectRoot = loadConfig(options.configPath, loaded.pack.project).root;
  }
  const judgeLock = options.judgeLock ?? acquireJudgeLock(options.runDir, {
    waitMs: options.judgeLockWaitMs,
    createJudgeDir: false,
    projectRoot,
  });
  const ownsJudgeLock = !options.judgeLock;
  try {
    return recoverPendingVerificationCropTransactionLocked({ ...options, judgeLock });
  } finally {
    if (ownsJudgeLock) releaseJudgeLock(judgeLock);
  }
}

function stageVerificationCropTransaction({
  runDir,
  packPath,
  pack,
  cfg,
  shotsDir,
  captureManifestPath,
  captureManifest,
  cropRequestsPath,
  cropRequests,
  request,
  verificationDir,
}) {
  const journalPath = verificationCropJournalPath(runDir);
  if (lstatOrNull(journalPath)) {
    throw verificationCropJournalError(`a pending transaction already exists: ${journalPath}`);
  }
  const previousManifest = readJson(captureManifestPath, "capture manifest before verification crop");
  const previousRun = readJson(join(runDir, "run.json"), "capture run before verification crop");
  const nextManifest = structuredClone(captureManifest);
  const nextCropRequests = cropRequests.some((entry) => entry.assetId === request.assetId && entry.purpose === request.purpose)
    ? structuredClone(cropRequests)
    : [...structuredClone(cropRequests), request];
  const stagingDir = join(verificationDir, `${VERIFICATION_CROP_STAGE_PREFIX}${randomUUID()}`);
  assertBuilderWriteDirectory(runDir, stagingDir, "verification crop staging directory", { create: true });
  const produced = produceCrops({
    captureManifest: nextManifest,
    cfg,
    shotsDir,
    outputShotsDir: stagingDir,
    cropRequests: [request],
  });
  if (produced.errors.length || produced.produced.length !== 1) {
    removeVerificationCropStage(runDir, stagingDir, produced.produced[0]?.path ?? join(stagingDir, "missing"), produced.produced[0]?.path ? attachmentDigest(produced.produced[0].path) : "");
    throw new JudgeExecutorError(`could not produce verification crop for ${request.purpose}: ${(produced.errors || []).join("; ") || "no crop was produced"}`, "verification");
  }
  const crop = produced.produced[0];
  const stagedPath = crop.path;
  const cropPath = join(shotsDir, basename(stagedPath));
  if (lstatOrNull(cropPath)) {
    removeVerificationCropStage(runDir, stagingDir, stagedPath, attachmentDigest(stagedPath));
    throw new JudgeExecutorError(`verification crop output already exists: ${cropPath}`, "verification");
  }
  assertBuilderWriteFile(runDir, cropPath, `verification crop ${crop.cropId}`);
  crop.path = cropPath;
  const digest = attachmentDigest(stagedPath);
  const attachment = packRelative(runDir, cropPath);
  if (pack.attachmentHashes?.[attachment] !== undefined) {
    removeVerificationCropStage(runDir, stagingDir, stagedPath, digest);
    throw hardAttachmentError(`verification crop ${crop.cropId} already has a pack binding without published capture evidence`);
  }
  let targetManifests;
  try {
    targetManifests = targetManifestSnapshots(runDir, previousManifest);
  } catch (err) {
    removeVerificationCropStage(runDir, stagingDir, stagedPath, digest);
    throw err;
  }
  const journal = {
    version: 1,
    runId: pack.runId,
    packId: pack.packId,
    targetId: request.assetId.split("/", 1)[0],
    cropId: crop.cropId,
    attachment,
    digest,
    crop,
    request,
    paths: {
      pack: packRelative(runDir, packPath),
      cropRequests: packRelative(runDir, cropRequestsPath),
      captureManifest: packRelative(runDir, captureManifestPath),
      run: "run.json",
      stagingDir: packRelative(runDir, stagingDir),
      stagedCrop: packRelative(runDir, stagedPath),
      crop: attachment,
    },
    before: {
      cropRequests: structuredClone(cropRequests),
      captureManifest: previousManifest,
      targetManifests,
      run: previousRun,
    },
    intended: {
      cropRequests: nextCropRequests,
      captureManifest: nextManifest,
    },
  };
  try {
    writeRunJsonAtomic(runDir, journalPath, journal, "verification-crop journal");
  } catch (err) {
    if (!lstatOrNull(journalPath)) removeVerificationCropStage(runDir, stagingDir, stagedPath, digest);
    throw err;
  }
  return { crop, digest, journal, nextCropRequests, nextManifest, stagingDir, stagedPath, cropPath };
}

function finishVerificationCropTransaction({ runDir, transaction }) {
  removeVerificationCropStage(runDir, transaction.stagingDir, transaction.stagedPath, transaction.digest);
  rmSync(verificationCropJournalPath(runDir));
}

function verifyBatchImageList(runDir, batch) {
  const description = `image list ${batch.id} (${batch.imageList})`;
  const path = fileArtifact(runDir, batch.imageList, description);
  if (typeof batch.imageListDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(batch.imageListDigest)) {
    throw hardAttachmentError(`${description} is missing a valid mapping digest`);
  }
  const actual = attachmentDigest(path);
  if (actual !== batch.imageListDigest) {
    throw hardAttachmentError(`${description} mapping digest does not match its packed bytes`);
  }
  return path;
}

function verifyBatchAttachments(runDir, pack, images, batch) {
  verifyBatchImageList(runDir, batch);
  for (const [index, image] of images.entries()) {
    verifyAttachment(runDir, pack, image.image, image.sha256, `image list ${batch.id} image ${index} (${image.image})`);
  }
}

function verifyExemplarAttachments(runDir, pack, exemplars) {
  for (const { exemplarId, exemplar } of exemplars) {
    const screenshot = exemplar.screenshot;
    verifyAttachment(runDir, pack, screenshot.attachment, screenshot.sha256, `exemplar ${exemplarId}`);
  }
}

/**
 * Re-hash the complete immutable initial judging surface. Both ui-judge and
 * manual ui-review --record call this exact preflight so neither executor can
 * seal modified resized images, exemplar attachments, image lists, or final
 * rendered prompts under the pack's original evidence identity.
 */
function verifyPackArtifacts(runDir, pack) {
  const exemplarImages = pack.exemplars.map((exemplar) => {
    const path = resolveExemplarScreenshot(exemplar, runDir);
    if (!path) return { exemplarId: exemplar.id, exemplar, path: null };
    const screenshot = exemplar.screenshot;
    const verified = verifyAttachment(
      runDir,
      pack,
      screenshot.attachment,
      screenshot.sha256,
      `exemplar ${exemplar.id} (${screenshot.attachment})`,
    );
    return { exemplarId: exemplar.id, exemplar, path: verified.path };
  });
  const batches = new Map();
  for (const batch of pack.batches) {
    const { list, images } = readBatch(runDir, pack, batch);
    const promptBinding = verifyInitialPrompt(runDir, pack, batch, images.length);
    batches.set(batch.id, { list, images, promptBinding });
  }
  return { exemplarImages, batches };
}

function readBatch(runDir, pack, batch) {
  const path = verifyBatchImageList(runDir, batch);
  const list = readJson(path, `image list ${batch.id}`);
  // 2..8 is the schema envelope for judge.maxImagesPerBatch; the builder
  // pads small batches up to min(6, configured bound), so any length inside
  // the envelope is a legitimate pack. Only structural corruption fails.
  if (!list || list.id !== batch.id || list.groupId !== batch.groupId || list.anchorId !== batch.anchorId || !Array.isArray(list.images) || list.images.length < 2 || list.images.length > 8) {
    throw new JudgeExecutorError(`image list ${batch.id} is invalid or not batched at 2–8 screens`, "pack");
  }
  const images = list.images.map((image, index) => {
    if (!image || typeof image !== "object" || typeof image.assetId !== "string" || typeof image.targetId !== "string" || typeof image.image !== "string" || typeof image.sha256 !== "string" || typeof image.referenceOnly !== "boolean") {
      throw new JudgeExecutorError(`image list ${batch.id} image ${index} is invalid`, "pack");
    }
    const verified = verifyAttachment(runDir, pack, image.image, image.sha256, `image list ${batch.id} image ${index} (${image.image})`);
    return { ...image, path: verified.path };
  });
  if (!Array.isArray(list.targetIds) || list.targetIds.length === 0 || list.targetIds.some((targetId) => typeof targetId !== "string" || !targetId) || new Set(list.targetIds).size !== list.targetIds.length) {
    throw new JudgeExecutorError(`image list ${batch.id} has invalid targetIds`, "pack");
  }
  const listTargetIds = new Set(list.targetIds);
  const batchTargetIds = new Set(batch.targetIds);
  const nonReferenceTargetIds = new Set(images.filter((image) => !image.referenceOnly).map((image) => image.targetId));
  const sameTargets = (left, right) => left.size === right.size && [...left].every((targetId) => right.has(targetId));
  if (!sameTargets(batchTargetIds, listTargetIds) || !sameTargets(batchTargetIds, nonReferenceTargetIds)) {
    throw new JudgeExecutorError(`image list ${batch.id} targetIds must exactly match its batch targetIds and non-reference image targets`, "pack");
  }
  const allowedTargetIds = new Set(batch.targetIds);
  if (batch.anchorId !== null) allowedTargetIds.add(batch.anchorId);
  if (images.some((image) => !allowedTargetIds.has(image.targetId))) {
    throw new JudgeExecutorError(`image list ${batch.id} contains a target outside its comparison group`, "pack");
  }
  if (batch.anchorId !== null && (!images[0].anchor || images[0].targetId !== batch.anchorId)) {
    throw new JudgeExecutorError(`image list ${batch.id} does not start with its named anchor`, "pack");
  }
  if (batch.anchorId === null && images.some((image) => image.anchor)) {
    throw new JudgeExecutorError(`standalone image list ${batch.id} must not carry anchor labeling`, "pack");
  }
  return { list, images };
}

function loadConfig(configPath, project) {
  const path = configPath ?? join(SKILL_DIR, "projects", `${project}.json`);
  if (!existsSync(path)) throw new JudgeExecutorError(`config not found: ${path}`, "config");
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    throw new JudgeExecutorError(`invalid config ${path}: ${err.message}`, "config");
  }
}

/**
 * Run initial batch calls, then crop/zoom verification calls, then make one
 * all-or-nothing record call. No model or parse failure can leave review.json
 * with an initial-only partial event sequence.
 */
async function runJudgeLocked({
  packPath,
  configPath = null,
  engine = null,
  engineName = "api",
  transport = defaultApiTransport,
  model = null,
  beforeEngineCall = null,
  verificationCropCheckpoint = null,
  environment = process.env,
  judgeLock,
}) {
  assertJudgeLock(judgeLock, dirname(dirname(resolve(packPath))));
  const loaded = loadPack(packPath);
  let { pack } = loaded;
  const cfg = loadConfig(configPath, pack.project);
  if (cfg.name !== pack.project) throw new JudgeExecutorError(`config project ${cfg.name} does not match judge pack ${pack.project}`, "config");
  // Recovery runs before completed-capture loading: a finalized-but-unbound
  // crop intentionally makes that normal preflight fail until its journal has
  // either completed the pack binding or restored the prior capture state.
  pack = recoverVerificationCropTransaction({ runDir: loaded.runDir, packPath: loaded.packPath, pack });
  const capture = loadCompletedCaptureRun(loaded.runDir, cfg);
  if (capture.run.runId !== pack.runId) throw new JudgeExecutorError("judge pack runId does not match capture run", "pack");
  assertPackFingerprintsMatchCapture(pack, capture.run);
  assertPackAssetHashesMatchCaptureHard(pack, capture.run, capture.captureManifest, capture.shotsDir);
  // Pack-controlled paths are preflighted before any engine call or executor
  // mutation. Read paths may traverse a symlink only when every existing
  // ancestor resolves inside the real run; directories owned by the builder
  // are stricter and must contain no symlink component at all.
  const cropRequestsPath = fileArtifact(loaded.runDir, pack.cropRequests, "crop-request scaffold");
  const verificationDir = join(dirname(cropRequestsPath), "verification");
  const captureManifestPath = join(capture.shotsDir, "manifest.json");
  assertBuilderWriteFile(loaded.runDir, loaded.packPath, "judge-pack manifest");
  assertBuilderWriteFile(loaded.runDir, cropRequestsPath, "crop-request scaffold");
  assertBuilderWriteDirectory(loaded.runDir, verificationDir, "verification artifact directory");
  assertBuilderWriteDirectory(loaded.runDir, capture.shotsDir, "capture shots directory");
  assertBuilderWriteFile(loaded.runDir, captureManifestPath, "capture manifest");
  assertBuilderWriteFile(loaded.runDir, capture.runPath, "capture run identity");
  assertBuilderWriteFile(loaded.runDir, verificationCropJournalPath(loaded.runDir), "verification-crop journal");
  for (const target of capture.captureManifest.targets || []) {
    assertBuilderWriteFile(
      loaded.runDir,
      targetManifestFile(capture.shotsDir, target.id),
      `capture target manifest ${target.id}`,
    );
  }
  assertBuilderWriteFile(loaded.runDir, outcomePath(loaded.runDir, pack), "judge executor outcome");
  const completed = completedRecordedJudgment({
    runDir: loaded.runDir,
    packPath: loaded.packPath,
    pack,
    cfg,
    capture,
    configPath,
    judgeLock,
  });
  if (completed) return completed;
  if (pack.targets.length === 0) {
    const path = outcomePath(loaded.runDir, pack);
    writeRunJsonAtomic(loaded.runDir, path, { version: "judge-executor-outcome.v1", outcome: "noop", at: new Date().toISOString(), reason: "no target fingerprint changed" }, "judge executor outcome");
    pack = updatePack(loaded.packPath, pack, { artifacts: [...pack.artifacts, relative(loaded.runDir, path).split(sep).join("/")] });
    return { outcome: "noop", path };
  }

  // A sealed record is bound to the rubric bytes stored in its executed pack,
  // so idempotent outcome recovery above must not depend on today's mutable
  // templates. Load and bind the current bytes only on the path that can make
  // new engine calls; retain the exact verification template for those calls.
  const loadedRubric = loadBoundRubric(pack);

  try {
    const engineTimeoutMs = judgeEngineTimeoutMs(cfg.judge?.timeoutMs, environment);
    const maxFindingsPerBatch = cfg.judge?.maxFindingsPerBatch ?? DEFAULT_MAX_FINDINGS_PER_BATCH;
    const maxFindingsPerRun = cfg.judge?.maxFindingsPerRun ?? DEFAULT_MAX_FINDINGS_PER_RUN;
    let selectedEngine = engine;
    let selectedModel = model;
    if (!selectedEngine) {
      if (engineName === "api") {
        const api = resolveApiJudgeConfig(cfg, environment);
        selectedEngine = (call, options) => apiEngineAdapter(call, { ...options, api, transport });
        selectedModel ??= { provider: api.provider, name: api.model };
      } else if (engineName === "codex") {
        if (environment[CLI_OPT_IN_ENV] !== "1") {
          throw new JudgeExecutorError(
            `Codex CLI judging requires explicit ${CLI_OPT_IN_ENV}=1 opt-in because the sandbox contains a readable copy of auth.json; use the default API adapter with AUTOREVIEW_UI_JUDGE_API_KEY instead`,
            "engine",
          );
        }
        const codexSelection = resolveJudgeModelSelection(cfg.judge || {});
        selectedEngine = (call, options) => codexEngineAdapter(call, { ...options, ...codexSelection });
        selectedModel ??= {
          provider: "openai",
          name: codexSelection.model ?? "codex",
          ...(codexSelection.reasoningEffort ? { reasoningEffort: codexSelection.reasoningEffort } : {}),
        };
      } else {
        throw new JudgeExecutorError(`unsupported judge engine ${JSON.stringify(engineName)}`, "config");
      }
    }
    selectedModel ??= { provider: "openai", name: "codex" };
    const verifiedPackArtifacts = verifyPackArtifacts(loaded.runDir, pack);
    const exemplarImages = verifiedPackArtifacts.exemplarImages;
    const exemplarImagesById = new Map(exemplarImages.map((entry) => [entry.exemplarId, entry]));
    const initialCandidates = [];
    let acceptedModelFindingCount = 0;
    const coverageByTarget = new Map();
    const coverageImages = new Map();
    // The run-total findings budget is an executor concern, not a per-batch
    // model contract: a batch cannot know the running total, so crossing it is
    // not a violation and must never void already-judged batches. When the
    // budget is exhausted the executor stops consuming batch responses, seals
    // the remaining targets as not-judged, and records the judged work. A
    // sealed not-judged target is re-selected by the next pack build, so a
    // follow-up judge run finishes the remainder under a fresh budget.
    let findingsBudgetExhausted = null;
    const sealBatchNotJudgedForBudget = (batch, images) => {
      for (const targetId of batch.targetIds) {
        const entries = coverageByTarget.get(targetId) || [];
        for (const phase of batch.checklistPhases) {
          entries.push({ targetId, phase, result: "not-judged", note: findingsBudgetExhausted });
        }
        coverageByTarget.set(targetId, entries);
      }
      for (const image of images) {
        if (!image.referenceOnly && batch.targetIds.includes(image.targetId) && !coverageImages.has(image.targetId)) {
          coverageImages.set(image.targetId, image);
        }
      }
    };
    for (const batch of pack.batches) {
      const verifiedBatch = verifiedPackArtifacts.batches.get(batch.id);
      if (!verifiedBatch) throw hardAttachmentError(`batch ${batch.id} has no verified packed artifacts`);
      const { images, promptBinding } = verifiedBatch;
      if (findingsBudgetExhausted) {
        sealBatchNotJudgedForBudget(batch, images);
        continue;
      }
      // The target image list is contractually six to eight attachments. An
      // exemplar may fill spare attachment capacity but can never expand an
      // engine call beyond that bounded visual context; its curated metadata
      // remains in the rendered prompt either way.
      const exemplarAttachments = initialExemplarPlan(pack.exemplars, images.length).attachedExemplars.map(({ exemplarId }) => {
        const entry = exemplarImagesById.get(exemplarId);
        if (!entry?.path) throw hardAttachmentError(`packed available exemplar ${exemplarId} has no immutable attachment`);
        return entry;
      });
      let output;
      try {
        const call = {
          images: [...images.map((image) => image.path), ...exemplarAttachments.map(({ path }) => path)],
          prompt: promptBinding.prompt,
          promptPath: promptBinding.path,
          promptDigest: promptBinding.digest,
          phase: "initial",
          batch,
        };
        if (beforeEngineCall) beforeEngineCall(call);
        verifyBatchAttachments(loaded.runDir, pack, images, batch);
        verifyExemplarAttachments(loaded.runDir, pack, exemplarAttachments);
        // Keep this final prompt-byte check immediately adjacent to the call,
        // after the test/diagnostic hook and every other attachment check.
        const finalPromptBinding = verifyInitialPrompt(loaded.runDir, pack, batch, images.length);
        call.prompt = finalPromptBinding.prompt;
        call.promptDigest = finalPromptBinding.digest;
        output = await Promise.resolve(selectedEngine(call, { timeoutMs: engineTimeoutMs, environment }));
      } catch (err) {
        if (err instanceof JudgeExecutorError) throw err;
        throw new JudgeExecutorError(`initial engine failure for ${batch.id}: ${err.message}`, "engine");
      }
      const parsed = parseInitialFindings(output, {
        images,
        targetIds: batch.targetIds,
        phases: batch.checklistPhases,
        batchId: batch.id,
        maxFindingsPerBatch,
      });
      const nextModelFindingCount = acceptedModelFindingCount + parsed.findings.length;
      if (nextModelFindingCount > maxFindingsPerRun) {
        findingsBudgetExhausted = `The executor findings budget judge.maxFindingsPerRun=${maxFindingsPerRun} was exhausted at ${batch.id} (${parsed.findings.length} findings on a prior run total of ${acceptedModelFindingCount}); this target was not judged and will be re-selected by the next judge pack.`;
        console.error(
          `WARNING: batch ${batch.id} returned ${parsed.findings.length} findings, bringing the run total to ${nextModelFindingCount} past judge.maxFindingsPerRun=${maxFindingsPerRun}; recording the judged batches and sealing the remaining targets as not-judged`,
        );
        sealBatchNotJudgedForBudget(batch, images);
        continue;
      }
      initialCandidates.push(...parsed.findings);
      acceptedModelFindingCount = nextModelFindingCount;
      for (const coverage of parsed.coverage) {
        const entries = coverageByTarget.get(coverage.targetId) || [];
        entries.push(coverage);
        coverageByTarget.set(coverage.targetId, entries);
      }
      for (const image of images) {
        if (!image.referenceOnly && batch.targetIds.includes(image.targetId) && !coverageImages.has(image.targetId)) {
          coverageImages.set(image.targetId, image);
        }
      }
    }
    for (const targetId of pack.targets) {
      const coverage = coverageByTarget.get(targetId) || [];
      if (!coverage.some((entry) => entry.result === "not-judged")) continue;
      const image = coverageImages.get(targetId);
      if (!image) throw new JudgeExecutorError(`initial coverage has no captured asset for target ${targetId}`, "pack");
      initialCandidates.push(coverageNotJudgedCandidate(targetId, image, coverage));
    }
    const duplicate = new Set();
    for (const candidate of initialCandidates) {
      if (duplicate.has(candidate.id)) throw new JudgeExecutorError(`initial engine output duplicates finding id ${candidate.id} across batches`, "initial");
      duplicate.add(candidate.id);
    }

    const shotsDir = capture.shotsDir;
    let captureManifest = readJson(captureManifestPath, "capture manifest");
    assignAssetIds(captureManifest, cfg);
    const cropRequests = readJson(cropRequestsPath, "crop-request scaffold");
    if (!Array.isArray(cropRequests)) throw new JudgeExecutorError("crop-request scaffold must be an array", "pack");
    const verifyTemplate = loadedRubric.templates.verification;
    assertBuilderWriteDirectory(loaded.runDir, verificationDir, "verification artifact directory", { create: true });
    const verificationEvents = [];
    const finalFindings = [];
    const dynamicArtifacts = [];
    let refreshedRun = capture.run;

    for (const candidate of initialCandidates) {
      if (candidate._coverageNotJudged) {
        const { _coverageNotJudged, _coverageEvidence, verifierVerdict, disposition, ...initial } = candidate;
        verificationEvents.push({
          kind: "verification", version: 1, eventId: randomUUID(), at: new Date().toISOString(), findingId: initial.id,
          verifierVerdict, evidence: _coverageEvidence,
        });
        finalFindings.push({ ...initial, verifierVerdict, disposition });
        continue;
      }
      if (candidate._unlocalizable) {
        const { _unlocalizable, _exemplarRefs, ...initial } = candidate;
        verificationEvents.push({
          kind: "verification", version: 1, eventId: randomUUID(), at: new Date().toISOString(), findingId: initial.id,
          verifierVerdict: "rejected", evidence: "Rejected: unlocalizable initial engine claim; no captured asset region was available for verification.",
        });
        finalFindings.push({ ...initial, verifierVerdict: "rejected", disposition: "rejected", ...(_exemplarRefs ? { exemplarRefs: _exemplarRefs } : {}) });
        continue;
      }
      const cropId = verificationCropId(captureManifest, candidate);
      const request = { assetId: candidate.assetId, rect: candidate.region, purpose: cropId };
      let crop = existingVerificationCrop(captureManifest, candidate, cropId);
      let cropTransaction = null;
      if (!crop) {
        cropTransaction = stageVerificationCropTransaction({
          runDir: loaded.runDir,
          packPath: loaded.packPath,
          pack,
          cfg,
          shotsDir,
          captureManifestPath,
          captureManifest,
          cropRequestsPath,
          cropRequests,
          request,
          verificationDir,
        });
        crop = cropTransaction.crop;
        if (verificationCropCheckpoint) verificationCropCheckpoint({ phase: "journaled", crop, request });
        renameSync(cropTransaction.stagedPath, cropTransaction.cropPath);
        writeRunJsonAtomic(loaded.runDir, cropRequestsPath, cropTransaction.nextCropRequests, "crop-request scaffold");
        if (verificationCropCheckpoint) verificationCropCheckpoint({ phase: "before-finalize", crop, request });
        captureManifest = cropTransaction.nextManifest;
        refreshedRun = finalizeCaptureRun(join(loaded.runDir, "run.json"), refreshedRun, captureManifest, shotsDir);
        cropRequests.splice(0, cropRequests.length, ...cropTransaction.nextCropRequests);
        if (verificationCropCheckpoint) verificationCropCheckpoint({ phase: "after-finalize", crop, request });
      }
      const cropBinding = bindVerificationCropDigest({
        packPath: loaded.packPath,
        pack,
        runDir: loaded.runDir,
        crop,
      });
      pack = cropBinding.pack;
      if (cropTransaction) finishVerificationCropTransaction({ runDir: loaded.runDir, transaction: cropTransaction });
      const promptPath = join(verificationDir, `${cropId}.md`);
      const cropDescription = { request, cropAssetId: crop.assetId, path: cropBinding.path, sha256: cropBinding.digest };
      const verificationInputs = structuredClone({ finding: candidate, crop: cropDescription });
      const verificationPrompt = renderVerification(verifyTemplate, verificationInputs);
      const verificationPromptDigest = `sha256:${createHash("sha256").update(Buffer.from(verificationPrompt, "utf8")).digest("hex")}`;
      const verificationPromptPath = packRelative(loaded.runDir, promptPath);
      const packedVerificationPromptDigest = pack.attachmentHashes?.[verificationPromptPath];
      if (packedVerificationPromptDigest !== undefined && packedVerificationPromptDigest !== verificationPromptDigest) {
        throw hardAttachmentError(`verification prompt for finding ${candidate.id} digest does not match its existing packed binding`);
      }
      assertBuilderWriteFile(loaded.runDir, promptPath, `verification prompt for finding ${candidate.id}`);
      writeFileSync(promptPath, verificationPrompt);
      const evidence = pack.targetJudgmentEvidence?.[candidate.targetId];
      if (!evidence) throw hardAttachmentError(`verification prompt target ${candidate.targetId} has no packed judgment evidence`);
      const verificationPromptId = `verification:${cropId}`;
      const nextEvidence = targetEvidenceWithPromptDigests(evidence, {
        ...evidence.promptDigests,
        [verificationPromptId]: verificationPromptDigest,
      });
      const evidenceChanged = evidence.evidenceDigest !== nextEvidence.evidenceDigest ||
        evidence.promptDigests?.[verificationPromptId] !== verificationPromptDigest;
      if (packedVerificationPromptDigest === undefined || evidenceChanged) {
        pack = updatePack(loaded.packPath, pack, {
          ...(packedVerificationPromptDigest === undefined ? {
            attachmentHashes: { ...pack.attachmentHashes, [verificationPromptPath]: verificationPromptDigest },
            artifacts: [...pack.artifacts, verificationPromptPath],
          } : {}),
          targetJudgmentEvidence: {
            ...pack.targetJudgmentEvidence,
            [candidate.targetId]: nextEvidence,
          },
        });
      }
      dynamicArtifacts.push(verificationPromptPath);
      let output;
      try {
        const call = {
          images: [crop.path],
          prompt: verificationPrompt,
          promptPath,
          promptDigest: verificationPromptDigest,
          phase: "verification",
          finding: candidate,
        };
        if (beforeEngineCall) beforeEngineCall(call);
        verifyAttachment(loaded.runDir, pack, cropBinding.path, cropBinding.digest, `verification crop ${crop.cropId}`);
        verifyAttachment(
          loaded.runDir,
          pack,
          verificationPromptPath,
          verificationPromptDigest,
          `verification prompt for finding ${candidate.id}`,
        );
        const finalVerificationPrompt = renderVerification(verifyTemplate, verificationInputs);
        const finalVerificationBinding = verifyRenderedPrompt(
          loaded.runDir,
          verificationPromptPath,
          verificationPromptDigest,
          finalVerificationPrompt,
          `verification prompt for finding ${candidate.id}`,
        );
        call.prompt = finalVerificationBinding.prompt;
        call.promptDigest = finalVerificationBinding.digest;
        output = await Promise.resolve(selectedEngine(call, { timeoutMs: engineTimeoutMs, environment }));
      } catch (err) {
        if (err instanceof JudgeExecutorError) throw err;
        throw new JudgeExecutorError(`verification engine failure for ${candidate.id}: ${err.message}`, "engine");
      }
      const verified = parseVerification(output);
      const { _exemplarRefs, ...initial } = candidate;
      const withCrop = { ...initial, cropId, cropDigest: cropBinding.digest };
      verificationEvents.push({
        kind: "verification", version: 1, eventId: randomUUID(), at: new Date().toISOString(), findingId: withCrop.id,
        verifierVerdict: verified.verifierVerdict, evidence: verified.evidence,
      });
      finalFindings.push({
        ...withCrop,
        verifierVerdict: verified.verifierVerdict,
        disposition: dispositionFor(verified.verifierVerdict),
        ...(_exemplarRefs ? { exemplarRefs: _exemplarRefs } : {}),
      });
    }

    // Reload after every engine/crop phase. An in-memory capture object is not
    // sufficient: another process may have replaced run.json while the judge
    // was working, with the same runId but different target fingerprints.
    const currentCapture = loadCompletedCaptureRun(loaded.runDir, cfg);
    if (currentCapture.run.runId !== pack.runId) throw new JudgeExecutorError("judge pack runId does not match capture run before recording", "pack");
    assertPackFingerprintsMatchCapture(pack, currentCapture.run);
    assertPackAssetHashesMatchCaptureHard(pack, currentCapture.run, currentCapture.captureManifest, currentCapture.shotsDir);
    refreshedRun = currentCapture.run;

    const events = [recordHeader({ cfg, run: refreshedRun, pack, model: selectedModel })];
    for (const finding of finalFindings) {
      const { verifierVerdict, disposition, exemplarRefs, ...candidate } = finding;
      events.push({ kind: "initial", version: 1, eventId: randomUUID(), at: new Date().toISOString(), finding: candidate });
    }
    events.push(...verificationEvents);
    for (const finding of finalFindings) events.push({ kind: "disposition", version: 1, eventId: randomUUID(), at: new Date().toISOString(), finding });
    events.push({ kind: "seal", version: 1, eventId: randomUUID(), at: new Date().toISOString(), findingCount: finalFindings.length, findingIds: finalFindings.map((finding) => finding.id) });
    const eventsPath = join(dirname(cropRequestsPath), "record-events.json");
    writeRunJsonAtomic(loaded.runDir, eventsPath, events, "record event batch");
    dynamicArtifacts.push(packRelative(loaded.runDir, eventsPath));
    const recorded = recordThroughUiReview({ eventsPath, runDir: loaded.runDir, pack, configPath, judgeLock });
    if (!recorded.review?.sealed || !recorded.review?.complete) {
      throw new JudgeExecutorError("ui-review --record did not seal a complete review", "record");
    }
    const executorPath = outcomePath(loaded.runDir, pack);
    writeRunJsonAtomic(loaded.runDir, executorPath, {
      version: "judge-executor-outcome.v1",
      outcome: "recorded",
      at: new Date().toISOString(),
      review: recorded.review,
    }, "judge executor outcome");
    dynamicArtifacts.push(packRelative(loaded.runDir, executorPath));
    // ui-review --record is the sole state writer. Reload its sealed manifest
    // before publishing executor artifacts so the validated per-target
    // disposition mirror is not overwritten by this executor's stale copy.
    const sealedPack = loadPack(loaded.packPath).pack;
    pack = updatePack(loaded.packPath, sealedPack, {
      artifacts: [...sealedPack.artifacts, ...dynamicArtifacts],
    });
    return { outcome: "recorded", review: recorded.review, pack };
  } catch (err) {
    const failure = err instanceof JudgeExecutorError ? err : new JudgeExecutorError(err.message, "executor");
    if (failure.hard) throw failure;
    const outcome = needsAgent({ packPath: loaded.packPath, runDir: loaded.runDir, pack, error: failure });
    failure.outcomePath = outcome;
    throw failure;
  }
}

async function runJudge(options) {
  const absolutePackPath = resolve(options.packPath);
  const runDir = dirname(dirname(absolutePackPath));
  if (dirname(absolutePackPath) !== join(runDir, "judge") || !absolutePackPath.endsWith(`${sep}manifest.json`)) {
    throw new JudgeExecutorError("--pack must be <capture-dir>/judge/manifest.json", "pack");
  }
  const preflightPack = loadPack(absolutePackPath).pack;
  const preflightConfig = loadConfig(options.configPath, preflightPack.project);
  if (preflightConfig.name !== preflightPack.project) {
    throw new JudgeExecutorError(`config project ${preflightConfig.name} does not match judge pack ${preflightPack.project}`, "config");
  }
  let judgeLock;
  try {
    judgeLock = options.judgeLock ?? acquireJudgeLock(runDir, {
      waitMs: options.judgeLockWaitMs,
      createJudgeDir: false,
      projectRoot: preflightConfig.root,
    });
  } catch (err) {
    throw err instanceof JudgeExecutorError ? err : new JudgeExecutorError(err.message, "lock");
  }
  const ownsJudgeLock = !options.judgeLock;
  try {
    return await runJudgeLocked({ ...options, judgeLock });
  } finally {
    if (ownsJudgeLock) releaseJudgeLock(judgeLock);
  }
}

function packRelative(runDir, path) {
  const result = relative(runDir, path);
  if (!result || isAbsolute(result) || result === ".." || result.startsWith(`..${sep}`)) {
    throw new JudgeExecutorError(`executor artifact escapes capture run: ${path}`, "executor");
  }
  return result.split(sep).join("/");
}

module.exports = {
  JudgeExecutorError,
  OPENAI_STRICT_SCHEMA_KEYWORDS,
  apiEngineAdapter,
  buildApiEngineRequest,
  buildCodexEngineInvocation,
  resolveJudgeModelSelection,
  buildJudgeEnvironment,
  buildJudgeSandboxProfile,
  codexEngineAdapter,
  defaultApiTransport,
  findExecutable,
  judgeEngineTimeoutMs,
  openAiStrictWireSchema,
  resolveApiJudgeConfig,
  assertPackFingerprintsMatchCapture,
  parseInitialFindings,
  parseVerification,
  recordThroughUiReview,
  recoverPendingVerificationCropTransaction,
  runJudge,
  verifyPackArtifacts,
};
