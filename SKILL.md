---
name: autoreview-ui
description: "Vision + static UI/design closeout review for web AND React Native. Renders the running app — a dev server via Playwright, or an iOS Simulator via deep links + AXe — screenshots routes across viewports/appearances and interaction states, runs an accessibility audit, and critiques for design-system consistency and 'lazy' code (inline styles, hardcoded values, reinvented atoms). Self-contained and global; composes with redesign-existing-projects, design-taste-frontend, atomic-design-check."
---

# Autoreview UI

A closeout gate for **how the UI actually renders**, where `autoreview` only reads code text. It targets one bug class — **LLM laziness** — which shows up two ways at once:

- **Pixel face**: ugly spacing, misalignment, inconsistent radii/shadows, missing hover/focus states, breaks at 375px, slop next to the careful parts of the app.
- **Code face**: inline `style={{}}`, hardcoded `#hex`/`px` instead of tokens, a hand-rolled `<div className="myCard">` where a `<Card>` atom exists (non-DRY against the design system).

These are the same defect seen twice. The skill fuses two detectors against one ruler:

> **Vision finds the symptom → the static scan finds the cause → the design system is the ruler.**

The decisive guard against vision slop: never ask "is this good?" (subjective, sycophantic). Ask **"does this match the rest of the app and the documented design intent?"** — because *deviation from the careful baseline IS the laziness signal*.

## Use when

- closing out any UI change (new screen, component, restyle, polish pass) before commit/ship;
- the user asks for a "UI review", "design review", "visual review", "check how it looks", responsive/interaction-state check;
- after `autoreview` passes but you still need eyes on the render.

## It is self-contained and global

This skill lives in `~/.agents/skills/autoreview-ui/`, owns its runtime dependencies, and **never writes into the project repo**. It reads a per-project config from `projects/<name>.json` and talks to the project's already-running app. Do not add a Playwright spec or an XCUITest to the project's test tree — the drivers replace them. Output (screenshots, manifest, bundle) goes to an out dir, never the repo; review event logs live only at `~/.local/state/autoreview-ui/<project>/runs/<run-id>/review.json`. Persisted review intent should also live outside the repo, usually via an `intentDoc` with a `skill:` path; so should any auth secret (`auth.secretFile` accepts an absolute path).

## Capture backends

The config's `capture.mode` picks the backend. **An absent `capture` block means `playwright`**, so a web config needs no changes.

| | `playwright` (default) | `rn-sim` |
|---|---|---|
| Product | Web app on a dev server | React Native / Expo app on an **iOS Simulator** |
| Driver | `scripts/shoot.mjs` | `scripts/shoot-rn.mjs` |
| Runtime deps | `@playwright/test`, `@axe-core/playwright` (`npm run bootstrap`) | `xcrun simctl` (Xcode) + `axe` (AXe: `brew tap cameroncooke/axe && brew install axe`) |
| Addressing | `page.goto(baseUrl + route)` | `simctl openurl <scheme>://<route>` — the route **must** be registered in the app's deep-link config |
| Sweep axis | `viewports` matrix (widths) | `capture.appearance` — light/dark. A phone has one width; the colour scheme is the axis worth sweeping |
| Selectors | CSS | accessibility selectors: `label=Save`, `id=cta`, `label~=About this`, `type=Button`, comma-joined |
| `axe` field | axe-core violations | runtime accessibility-tree audit, mapped to the identical violation shape |
| Interactions | `hover`, `focus`, `active`, `click`, `fill` | `tap`, `fill` only |
| `baseUrl` | the dev server | the **Metro** packager (probed as a precondition) |

**Selection rule:** if the product under review is React Native, its config must set `capture.mode: "rn-sim"`. Do not point a Playwright config at a Metro URL — it will connect and screenshot nothing useful.

Things that are genuinely impossible on the native backend, and are therefore *rejected* rather than faked:

- **`hover` / `focus` / `active`** — iOS has no pointer hover and no DOM focus ring. `ui-review` exits 2 and names `tap` as the replacement. Never report a missing hover/focus state on a native surface; the RN equivalent is the `pressed` style callback, judged from code.
- **Per-target `role`** — an app has one signed-in session, so roles cannot be switched per screenshot. Use the `auth` block.
- **Physical devices** — there is no scriptable screenshot/tap path for a real iPhone here. The backend is simulator-only.
- **Freezing animations** — they run inside the app process and cannot be disabled from outside. Determinism comes from a status-bar override plus a stable-retake loop (shoot twice, compare bytes, retry). The override and the pre-run appearance are both restored when the run ends, success or failure, so the simulator is left as it was found. A target whose `errors` mention "never settled" may have caught a mid-transition frame; re-run before calling it a layout bug.

> Naming collision, worth knowing: the `axe` **CLI** is AXe, the iOS automation tool. It is unrelated to **axe-core**, whose results fill the `axe` field of a manifest. Both appear in this skill.

## Bootstrap

Before first screenshot capture with the `playwright` backend in a fresh skill checkout:

```bash
cd ~/.agents/skills/autoreview-ui
npm run bootstrap
```

`ui-review` checks each backend's runtime tools before capture and prints the right install hint (npm bootstrap, or the Xcode/AXe lines) instead of failing inside a driver.

## Preconditions

1. The app is running and reachable at the config `baseUrl` — a dev server, or Metro for `rn-sim` (the config carries a `startHint`).
2. For gated routes, auth is available: the config's `auth` block describes how the skill signs in (a dev-login endpoint on web; a sign-in deep link on native).
3. **`rn-sim` only:** a simulator matching `capture.udid` / `capture.simulator.deviceName` is booted and has `capture.bundleId` installed. `ui-review` checks this and exits 2 with the boot/install command if not.
4. **External session (when configured):** `capture.session = { bootstrapHint, readiness, timeoutMs }` is project-owned setup, not an auth shortcut in this skill. Before the first RN capture, `ui-review` waits for `readiness` in the AX tree and exits 2 with `bootstrapHint` if it never appears. The shape is backend-neutral; Playwright currently treats it as a no-op precondition.

## Workflow

### 0. Resolve design intent (derive, else ASK)

The rubric judges *consistency with intent*, so intent must be known first.

- **Derive** from: the project `designDoc` (e.g. `docs/design-system.md`), the token palette, the design-system inventory, and the sibling/surrounding components (the consistency baseline). Use `design-taste-frontend`'s brief-inference signals as the vocabulary.
- **Ask** the user only the gaps you cannot derive — per-screen **purpose**, target **user**, intended **feeling/tone**, hard **constraints**, and any **intentional deviations** from the system. Keep it to 1–4 sharp questions.
- **Persist** the result to the config's `intentDoc` so it is not re-asked. To preserve the no-repo-write contract, prefer `skill:projects/intent/<project>.md`; absolute paths outside the repo are also valid. `ui-review` reports `INTENT not captured` until that file exists.

Never critique "ugliness" in a vacuum — without intent you will flag intentional choices.

### 1. Capture

```bash
~/.agents/skills/autoreview-ui/scripts/ui-review --project <name> \
  [--targets id1,id2-or-group] [--base origin/main] [--scan-scope diff|targets] [--out DIR] [--no-library]
```

This runs the static scan over the change, screenshots the selected routes across the sweep axis + interaction states, runs the accessibility audit, and writes `bundle.json` + a `shots/` dir. Each run owns a newly created output directory; if you pass `--out DIR`, `DIR` must not already exist. `--targets` picks routes from the config (default: all). `--base` scopes the scan to a branch diff (default: uncommitted local changes).

`groups: { name: [targetIds] }` lets `--targets <name>` select a named coverage set; target ids and group names may be combined. Each selected target reports `captured`, `skipped`, or `failed` with a reason, and one failed target does not suppress the later targets.

### Full-page shots load the whole page first

A Playwright full-page screenshot captures beyond the viewport without
scrolling, so a lazy image or a scroll-revealed section below the fold would be
blank in it. Before each full-page shot (`fullPage` is the default; not for a
`clip` target or `fullPage: false`) the driver:

1. starts at the top, then scrolls down one viewport at a time until the
   position stops moving;
2. waits until no request was in flight for 500 ms (requests are counted from
   the page's first one; event streams, websockets and media do not count);
3. waits until every image the shot can show has `complete && naturalWidth > 0`;
4. tries one more step, and goes on from 1 when a request that finished in the
   meantime made the page longer;
5. scrolls back to the top, then shoots.

Everything is bounded: 100 viewports, 15 s of network waits and 15 s of image
waits per shot, 10 s per script evaluation in the page. A failure in this step
never costs the screenshot. The shot's manifest entry records the result as
`preScroll`: `steps`, `bottomReached`, `networkIdle`, `images`, and
`imagesNotLoaded` (sources that did not load: a broken file, or one still
loading at the bound), plus `error` when the step itself failed. Read
`imagesNotLoaded` before calling a blank image box a design finding. An image
with no layout box (inside a `display: none` subtree) or outside the area the
full-page shot covers (for example far to the side inside a carousel's own
scroll box) is not counted: the browser never starts it, and the shot does not
show it.

Because the page is scrolled to its bottom, anything that mounts on scroll (a
map that loads when it enters the viewport, a deferred grid) is in its loaded
state in the full-page shot and in the axe audit that follows.

### Scroll evidence

Add `"scroll"` to a target's `captureVariants` to capture top and bottom
viewport PNGs as independent `scroll-top` / `scroll-bottom` assets. The target
manifest records pre/post AX trees and facts: `scrollable`, `scrollExtentPt`,
`viewportPt`, `bottomReached`, `revealed`, `containerSelector`, and exposed
container/content/viewport/footer frames.

`capture.scrollProbe` supplies defaults and a target-level `scrollProbe`
overrides them. `containerSelector` is an AX selector for `rn-sim` and a DOM
selector for Playwright; without one, the largest exposed scrollable is used.
`footerSelector`, `maxSwipes` (default 8), `swipePercent`, and `settleMs` are
also available. Swipes continue until the content geometry reaches its end,
the AX end state is stable, or the cap is reached, so `bottomReached: false`
is evidence, not a guess. Set
`thresholds.sliverExtentViewportRatio` (default `0.15`) to flag an extent below
that share of the viewport as `sliver-scroll`.

#### Evidence states

| AX evidence | Recorded facts | Layout-economy result |
| --- | --- | --- |
| Content and viewport geometry exposed | Numeric extent/viewport, bottom state, revealed summary, and swipe count | Numeric threshold may flag `sliver-scroll`. |
| Container frame exposed but geometry unavailable | `scrollExtentPt` and `viewportPt` stay `null`; swipes still record `bottomReached` through AX-signature stability, `revealed`, and `swipeCount` | `not-judged` because no numeric extent exists, but the judge receives the observed facts. |
| First swipe leaves the AX signature unchanged and reveals nothing | `scrollable: true`, `inert: true`, `sliverScroll: "suspected"` | `not-judged` with `sliver-scroll-suspected`; this is an inert/sliver-scroll signal, not a numeric-threshold finding. |

Do not make a numeric layout-economy claim when the geometry is unavailable.

### Evidence crops

Top-level `cropRequests` (or `ui-review --crop-requests requests.json`) is an
array of `{ assetId, rect|axSelector, purpose }` requests. Use exactly one of
a normalized `rect` or `axSelector`; an asset ID is
`target/appearance/variant/interaction`, using `base` for a non-interaction.
The crop is derived from the existing PNG via `png.cjs`, is hashed into the
run, and is published to `latest/` with `purpose` as its crop identity.
For a clipped asset, an `axSelector` frame is normalized relative to that
clip's PNG (not the page or simulator display); a partly visible selector crops
its visible intersection. A selector wholly outside the clip is absent from
that asset and fails explicitly with `selector outside clipped area`.

### Barrels, route shells, rule opt-outs, and scan scope

`scan.barrels` is a non-empty list of project-relative TypeScript/JavaScript
barrels. `ui-scan` parses their **value exports** (including constants and
hooks, never `export type`) using the same resolver as the web design-system
scanner. The deduplicated component inventory is written to
`bundle.json → scan.inventory.components`; it is deliberately not repeated in
the human summary.

`scan.shellPolicy` applies shared route-chrome rules:

```json
{
  "routeClass": "sub-screen",
  "match": ["myapp://career/*"],
  "require": ["ScreenHeader", "ScrollViewHeader"],
  "exceptions": ["myapp://career/full-bleed"]
}
```

`match` and `exceptions` are route-glob lists (an empty `exceptions` list is
valid); `require` is a non-empty one-of component list. The first
`sourceFiles` entry is the route root. A required component counts only when
it is imported directly or from a configured barrel and rendered in that route
file, or in one component the route renders. A second wrapper hop is
`unresolved`, never a pass. Each applicable target/rule is emitted under
`scan.shellPolicy` with `satisfied`, `violated`, `unresolved`, or `exempt`.
Violations and unresolved results are player-facing summary signals; a
violation names its missing list and route root `file:line`.

`scan.ignoreRules` switches off scan rules that encode a convention the
project's **documented** design system contradicts. Example: `hugeicons-direct`
assumes an `<Icon>` atom, but a project whose design doc says to render
`<HugeiconsIcon>` directly sets `"ignoreRules": ["hugeicons-direct"]`. Rules:

- Each id must be a rule of the configured `scan.ruleset` (ids are listed under
  Static rulesets). An unknown or other-ruleset id is a config error
  (`ui-review` exits 2), never a silent no-op.
- Ignoring is never silent. Ignored hits are dropped from `findings`, `byRule`
  and the exit code, but `bundle.json → scan.summary.ignoredByRule` records
  every ignored rule with the hits it would have reported (0 included), and the
  summary prints `SCAN  ignored by config (scan.ignoreRules), not counted: {...}`.
  A rule that keeps showing 0 is a stale opt-out; remove it.
- Justify each entry in the project's intent doc by citing the design-doc line
  it follows. Do not use it to silence findings that are merely inconvenient;
  a rule whose message is wrong for the project but whose detection is still
  valid there (for example `style-tag` on a Tailwind project) stays on.

The default `--scan-scope diff` retains change-only static scanning. Use
`--scan-scope targets` to scan every selected target's declared `sourceFiles`
in full, independently of Git diff state; this is how an existing screen is
audited deliberately.

### Durable capture library

Unless `--no-library` is supplied, every capture is copied after it completes to the skill-owned state tree — never to the project:

```
~/.local/state/autoreview-ui/<project>/
  runs/<run-id>/
    shots/                 # PNGs plus capture manifests
    run.json               # capture identity, outcomes, PNG hashes, fingerprints
    bundle.json
    review.json            # added later by ui-review --record
    review-crops/          # sealed crops keyed by target + source asset + crop id
  latest/<target>/<appearance>/<variant>/<interaction>/<crop>.png
  manifest.jsonl
```

`AUTOREVIEW_UI_STATE_DIR` can relocate that state tree, but publication and
retention reject any resolved project library root that is equal to or nested
inside the reviewed project.

The on-disk `latest/` path segments are safely encoded, but its logical key is
always the complete asset identity: `target / appearance / variant /
interaction / crop`. `latest/` contains copied bytes, never a symlink into a
run, so retention cannot break it. A later run replaces only the specific
asset identities it captured. For web captures, the viewport sweep name is
part of `variant`; for native captures, appearance is the sweep axis. Partial runs retain every successful PNG while
also recording each failed or skipped target explicitly.

`manifest.jsonl` is append-only and shares the review-record lock/fsync/atomic
rename discipline. Asset records carry `targetId`, `appearance`, `variant`,
`interaction`, `crop`, `assetPath`, `takenAt`, `branch`, `commit`, `patchHash`
(`null` for a clean or unknown tree), `targetFingerprint`, fingerprint inputs,
`appBuild`, `device`, `runId`, `outcome`, and `reason`. A per-target summary
line means a skipped or failed target is never ambiguous by absence.

### Bounded judge context

`bundle.json → judgeContext[targetId]` contains only shell-policy verdicts for
that target, inventory components it actually imports, viewport-keyed normalized
scroll probes, and route-class-matched intent excerpts. It never contains raw
AX trees or the full inventory. `judgeContext.maxBytes` defaults to 8192 bytes
per target. Truncation is deterministic: shell policy, inventory matches, scroll
probes, then intent excerpts; its explicit `omitted` list includes the count of
any dropped scroll probes, so silence never implies that a viewport was not
captured.

The library retains the last 30 runs by default. Set `library.keepRuns` to a
positive run count and optionally `library.maxBytes` to a positive byte quota;
both limits remove the oldest run directories only. Pruning never touches
`latest/` or `manifest.jsonl`. If the retained current run alone exceeds a
quota, it remains durable and the summary reports that quota condition.

Before the library copies a capture into `runs/<run-id>/`, it writes a
`library-install.marker`; the marker is removed only after that run's manifest
records commit. Recovery may reclaim an uncommitted directory only when this
marker identifies it as an interrupted library installation. Uncommitted,
unmarked run directories — including historical review-only homes and reviews
made after a `--no-library` capture — are preserved and excluded from retention
accounting.
For a committed library run with `review.json`, retention keeps the entire run
directory so the review remains beside the capture evidence it describes.

`--no-library` makes the capture explicitly **ephemeral**: the normal summary
says `--no-library; excluded from manifest.jsonl`, and no durable manifest or
library bytes are written.

### Fingerprints and freshness

Each target with `sourceFiles` receives a SHA-256 fingerprint in `run.json`
and every related manifest record. It covers the declared source-file contents,
canonical route and params, target `role` and `stateProfile`, receipt id when
supplied, asset variant identity, app build, capture configuration, and
capture-driver version. It also includes only the non-secret authentication
state selectors: `auth.mode`, account identifier/alias, and the basename of
`auth.storageState`; credential values and secret-file/env fields are never
hashed. Web targets also include the effective URL that Playwright navigates:
the configured `baseUrl` for relative routes, or the route's own origin for an
absolute URL. Native targets intentionally omit `baseUrl`, because its Metro
address does not affect rendered pixels. A target with no `sourceFiles` (or unavailable declared source) has
fingerprint `null`; it is `unverifiable`, never quietly fresh.

Check whether selected library captures still match a git revision without
capturing again:

```bash
~/.agents/skills/autoreview-ui/scripts/ui-review --project <name> \
  --verify-fresh [--base <sha>] [--targets id1,id2-or-group] [--json]
```

Without `--base`, freshness fingerprints `sourceFiles` from the current
working tree — matching what capture fingerprints, including uncommitted
edits. With `--base <sha>`, it instead reads each entry through read-only `git
show` using each configured project root's repository-relative prefix; this is a deliberately
revision-pinned comparison and does not see uncommitted edits. The report gives every selected target one of
`fresh`, `stale`, `unverifiable`, or `never-captured`, with the changed input
(for example `sourceFiles changed: src/Screen.tsx` or `capture config
changed`). It exits 0 when all selected targets are fresh,
3 when any target is stale, unverifiable, or never captured, and 2 for invalid
usage.

After the calling agent has made its initial, verification, and disposition decisions, it writes the versioned event batch through the sole record writer:

```bash
ui-review --record events.json --run <capture-dir> [--project <name>]
```

`--run` is the output directory from a completed capture (the directory containing its `run.json`); it binds the event batch to that capture. The command requires the header `runId` to match, rejects targets absent from that capture's resolved target set, rejects targets not successfully captured or lacking hashed PNGs, and verifies every optional header `targetShotHashes[targetId][relativePngPath]` claim against the capture's SHA-256 identity. Shot-hash keys always serialize with forward-slash POSIX separators; completed-run loading canonicalizes legacy Windows backslash keys before lookups, pack serialization, crop binding, or evidence digests. When the run has a judge pack, the header target set must exactly equal `pack.targets`, and the pack's target fingerprints and complete capture-time shot-hash set (including requested crops) must still match the current `run.json`. Each `run.json` records its UUID `runId`, project, resolved `targetIds`, per-target `targetOutcomes` (`captured`, `failed`, or `skipped`), and SHA-256 hash of every target PNG (including interaction-state PNGs). `captureComplete` is true only when every resolved target is captured and has at least one hashed PNG; partial captures remain inspectable but cannot back a review record.

An existing unsealed `review.json` whose immutable header contains legacy
Windows backslash shot-hash keys remains appendable: the writer warns once
naming the log and compares a canonical read-view without changing the stored
header bytes. The published `review-event.v1` schema remains permissive so
historical Windows headers stay readable to external consumers; forward-slash
POSIX keys are an append-time writer policy only, and every newly submitted
record header must satisfy it.

A crop-backed finding newly appended through `ui-review --record` must carry both `cropId` and `cropDigest`. This is an append-time policy, rather than a retroactive schema requirement: published `finding.v2` / `review-event.v1` records with a digest-less crop remain readable, and a legacy digest-less disposition may complete its matching legacy initial finding. The writer holds both the project library and per-run review locks, validates the complete prospective event log, copies referenced crops to private staging names inside the durable run, and journals the exact prospective log digest. It atomically commits `review.json` before promoting any crop to its deterministic append-only `review-crops/<encoded-target>/<encoded-asset>/<encoded-crop>.png` path. Crop binding and journal recovery use the same `targetId + assetId + cropId` identity, so two source assets may safely use the same crop purpose. On the next library operation, recovery completes promotion only when that exact review log committed; otherwise it deletes the private staging. A sequence-invalid or interrupted pre-commit batch therefore leaves no final crop path behind, and an existing crop path is never overwritten.

Once that committed log is complete, normal post-commit finalization is derived
again from the sealed `review.json`, the validated capture, and its judge pack.
The journal stores the resulting immutable run/pack/target evidence identity
for every completing sealed log; a clean review with no crop entries still has
a finalization journal. Recovery advances the durable judgment cursor from
that journal's own run identity, independent of the run that triggered recovery
and without requiring the original capture directory; when the same run's judge
lease is already held, its pack mirror is reconciled too. Replaying an already committed
`--record` batch after an interruption appends no events, completes any lagging
finalization, and exits successfully with an explicit note; repeating the
finalization does not rewrite the pack or advance the cursor.

`events.json` is a JSON array whose first object is the immutable `record-header`, followed by `initial`, `verification`, and `disposition` events, and exactly one terminal `seal` event. The `seal` declares `findingCount` and may declare `findingIds`; when present, that list must exactly match the observed initial finding ids. A record is complete only when its final seal matches the emitted finding set and every finding has verification plus disposition. A log without a seal is explicitly `unsealed`, never complete. The command validates the sequence and atomically appends it to the state-directory `review.json`.

For an append that would complete the log, `ui-review --record` derives and
validates every target's judgment evidence while holding both the project
library lease and the review-log lock, before staging crops or committing
`review.json`. A derivation failure therefore leaves no sealed log, published
crop, or judgment cursor, and the same batch can be retried after correcting
the evidence source.

### Judge packs

Build the deterministic judging input from a completed capture—this never
launches an app, simulator, or model:

```bash
ui-review --judge-pack --run <capture-dir> [--targets id1,id2-or-group] [--previous-pack <manifest.json>] [--project <name> | --config <path>] [--json]
```

Pack construction, verification-journal recovery, automated execution, and
record-time pack-manifest updates serialize on the run-local
`judge/.judge.lock`. A concurrent contender exits after the standard bounded
lock timeout with `another judge operation is running`; a dead owner's stale
lock is reclaimed with the same two-link discipline as review recording.

When `--project` / `--config` is omitted, `ui-review` reads the project name
from the completed run. It writes `judge/manifest.json` plus a new generation
under `judge/builds/<pack-id>/`. The `judgepack.v1` manifest is
bound to the capture `runId`, target fingerprints, and the complete
capture-time SHA-256 map for every selected target, including ordinary
requested crops. The stable target-local judgment evidence digest includes
those ordinary capture-time crop hashes and excludes only executor-generated
verification crops.
Its `attachmentHashes` map and each
batch image-list entry bind the SHA-256 digest of every generated image
attachment (including verification crops added later). Each batch also stores
an `imageListDigest`, binding the complete canonical image-list mapping
(target/asset labels, order, attachment paths, and attachment digests), plus a
`promptDigest` binding the exact complete prompt bytes passed to an engine,
including the deterministic exemplar attachment map appended to the base
prompt artifact. The executor re-renders that final prompt from the packed
image list and immutable exemplar metadata immediately before every call and
refuses any digest mismatch. It lists every generated artifact:

- resized PNG attachments (1568px long edge), grouped into six-to-eight-image
  calls strictly within one `reviewGroups` comparison family; every split
  group batch starts with that group's `anchorId`, while standalone batches
  carry `groupId: null` and no anchor labeling. Comparison prompts instruct
  the judge to use the first image as the anchor; standalone prompts explicitly
  say that there is no comparison anchor and each screen is judged on its own;
- verbatim Pass 3 `judgeContext` files, one per target;
- editable prompts rendered from the comparison and standalone checklist
  templates in `reference/`, with the five yes/no/evidence phases: visual
  polish, layout economy, consistency, accessibility, and intent. Every batch
  also carries their canonical identifiers (`visual-polish`, `layout-economy`,
  `consistency`, `accessibility`, `intent`) in `checklistPhases`;
- an initially empty `crop-requests.json` scaffold; and
- curated exemplar metadata. An available exemplar pins a run-qualified
  `runs/<run-id>/...png` library path plus SHA-256 at curation time. While the
  library lease is held, the builder copies those exact bytes into the judge
  build, records the attachment digest, and the executor verifies it before
  invoking an engine. Unavailable exemplars are named explicitly; they are
  never substituted from mutable `latest/`. No PNG is copied into this skill
  repository.

`--targets` limits judge-pack selection to named targets/groups before the
normal fingerprint, judgment-evidence, and `not-judged` selection rules run.
Every current pack computes a stable target-local `baseEvidenceDigest` over
its captured viewport/variant and ordinary capture-time crop hashes (excluding
only executor-generated `verify-<uuid>` crops), all three canonical templates
(comparison, standalone, and verification) plus `checklistPhases`, the attached
exemplar identities and digests, that target's `judgeContext` slice, and—when
the target belongs to a comparison family—the relevant `reviewGroups`
definition plus the complete sorted set of relevant resolved anchor asset
identities and SHA-256 digests. Its
sealed `evidenceDigest` additionally binds the exact `promptDigest` of every
batch that judged the target; the map is retained as `promptDigests`. This
separates stable delta selection from generation-specific artifact paths while
keeping the verdict bound to the prompt bytes actually executed. A byte change in any relevant
anchor viewport, appearance, variant, or interaction-state asset, or a group-purpose
change therefore reselects unchanged siblings as `evidence-changed`. A completed judgment
suppresses a target only when its source fingerprint and stable base evidence
match; a changed rubric (including the verification protocol) is reported as
`rubric-changed`, while another changed input is `evidence-changed`. Judge-pack is not a capture or scan mode: it
rejects `--base` and non-default `--min-confidence`
rather than silently ignoring them. A retained comparison anchor is copied
from its manifest-named immutable library run while the library lease is held;
the pack records that run-relative path and SHA-256 digest alongside the
resized attachment.

After a completed, sealed judgment written through `ui-review --record`, the loop cursor is persisted at
`$AUTOREVIEW_UI_STATE_DIR/<project>/judgments/latest.json` (or
`~/.local/state/autoreview-ui/<project>/judgments/latest.json`). It is updated
under the project `.library.lock` and records each target's fingerprint,
judgment-evidence and rubric digests, run, monotonic `judgedAt` token, and
final disposition. A fresh capture therefore re-judges a changed or
never-judged target, a same-fingerprint target whose judgment evidence
changed, and any same-fingerprint `not-judged` target. Digest-less legacy
cursor and `--previous-pack` entries are deliberately non-suppressing once;
the re-judgment writes the new digests. Unchanged completed targets appear in
the pack's `skippedTargets` with a reason. An
unchanged comparison anchor may appear as reference imagery for a changed
sibling, but is not re-judged. When targets are selected, the union of batch
target IDs must cover every selected target; a hand-edited pack that omits a
target or supplies no batches is rejected before any judge engine runs.

Use `--previous-pack <manifest.json>` only to override that durable cursor
(for example when the state directory is unavailable). A completed sealed
`ui-review --record` also atomically mirrors that pack's selected fingerprints,
judgment-evidence digests, and dispositions into its validated `judgepack.v1`
manifest, so this fallback includes agent-recorded judgments as well as
automated ones and can reselect an unresolved `not-judged` target. The
supplied manifest must validate and name the same project.

### Two judge executors

The default executor is the calling agent: inspect the pack headlessly, make
initial / verification / disposition decisions, and submit the event array
through the existing `ui-review --record ... --run ...` command.

The optional automated executor uses the same pack and record path:

```bash
ui-judge --pack <capture-dir>/judge/manifest.json [--config <path>] [--engine api|codex] [--json]
```

Re-invoking `ui-judge` after that exact pack has already produced a complete
sealed review is an idempotent success: it reuses the recorded outcome without
launching an engine or rewriting executor state. If the completed review's
target set or any selected target's fingerprint/evidence digest no longer
matches the manifest, the executor stops before engine launch and requires a
fresh `ui-review --judge-pack --run <capture-dir>` build.

`ui-judge` keeps the following explicit adapter matrix:

| Mode | Activation | Credential boundary | Failure behavior |
| --- | --- | --- | --- |
| Direct API (default) | Omit `--engine`, or pass `--engine api`. | The runner reads `judge.apiKeyEnv` when configured, then `AUTOREVIEW_UI_JUDGE_API_KEY`, then the provider's conventional variable (`OPENAI_API_KEY`). It sends the key only in the HTTPS authorization header. The request contains the prompt, PNG data URLs, and a strict JSON response schema, but no tools. There is no nested agent, child process, argv credential, scratch directory, or copied auth file. | Transport/status/timeout failures retry through `judge.maxRetries` (default 2), then write `needs-agent` with no review events. |
| Codex CLI (dangerous opt-in) | Pass `--engine codex` **and** set `AUTOREVIEW_UI_ALLOW_UNCONFINED_JUDGE=1`. | The legacy adapter creates a fresh scratch `CODEX_HOME` with a mode-0600 copy of `auth.json`. That credential is readable to the CLI model itself and can be exposed by prompt injection; filesystem mode and the outer sandbox do not protect it from the same process. | Before parsing, the runner scans raw stdout and stderr for every credential string loaded from the copied auth file. A match names the batch, writes `needs-agent`, persists no engine output/review events, and removes scratch. |
| Refusal | No API key for the default adapter, or CLI selected without its explicit opt-in. | No automated model is launched. | Nonzero exit plus `needs-agent`, with an actionable message naming the API-key and CLI-opt-in choices. |

The CLI adapter otherwise retains its defense-in-depth confinement: a scrubbed
allowlist environment; `codex exec -C <scratch> --sandbox read-only` with user
config, rules, plugins, skill search, web search, and MCP disabled; and, on
macOS, a generated deny-default `sandbox-exec` profile. Attached images remain
read-only inputs at their original paths. On non-macOS, the same explicit
override also accepts the additional lack of OS-level read confinement. The
override is never inherited by Codex. These controls reduce host-file exposure
but do not make the copied CLI credential safe from model-readable injection,
which is why this adapter is never the default.

It first judges the batch, then judges an exact Pass 3 crop/zoom. Only a
claim whose non-localization fields are fully schema-valid may become a
rejected `unlocalizable` finding when its target, asset binding, or region
cannot be localized. Any other schema-invalid claim degrades to `needs-agent`
with no review events.

The initial engine response is exactly `{ findings, coverage }`. `coverage`
must contain exactly one `{ targetId, phase, result }` for every batch target
and every `checklistPhases` identifier, where `result` is `clean`, `findings`,
or `not-judged`; unknown, duplicate, missing, or partial entries degrade the
whole batch to `needs-agent` without review events. A target seals `clean`
only when every required phase in every batch is `clean` and no finding names
it. Any `not-judged` phase is persisted as the target's `not-judged` disposition, so
the normal freshness loop selects it again.

Model-produced findings are bounded before candidate acceptance or crop work.
`judge.maxFindingsPerBatch` defaults to 12 and is also applied as the response
schema's `findings.maxItems`; `judge.maxFindingsPerRun` defaults to 48 across
all batches in one executor run. Exceeding either cap is a batch contract
violation: `ui-judge` warns with the observed count, writes `needs-agent`, and
emits no review events or verification crops.

Before making any new engine call, `ui-judge` hashes the current comparison,
standalone, and verification templates together and refuses a pack whose
stored rubric digest does not match; completed-record reconciliation runs
first, so an idempotent sealed rerun remains bound to its executed pack even
after the current templates change. The exact loaded verification bytes are
retained for every verification prompt. Every pack-supplied artifact path resolves each existing
ancestor and must remain inside the real capture run; directories the executor
writes through must additionally be real, per-component non-symlink
directories. A path violation is a hard preflight error and writes nothing.
Before the engine runs and again immediately before `ui-review --record`,
`ui-judge` requires each selected `pack.targetFingerprints[targetId]` and the
complete stored capture-time `pack.targetShotHashes[targetId][asset]` map to
match the current capture, rejecting any added current asset except a
manifest-identified `verify-<uuid>` crop whose bytes are already bound in
`pack.attachmentHashes`. Immediately before every initial engine call
it re-hashes that batch's complete image-list artifact against
`imageListDigest`; before every engine call it also re-hashes every packed
resized attachment or verification crop against `attachmentHashes`. It
re-renders and hashes the complete initial prompt against `promptDigest`, then
passes those verified bytes to the engine. It likewise binds each dynamically
rendered verification prompt into the pack, re-renders and hashes it
immediately before its call, and passes exactly those verified bytes.
(Verification crops added after packing are bound to the pack before their
verify call and do not replace a stored base asset. On a later pack rebuild,
they remain in the complete capture-time and attachment hash sets as durable
verification evidence, but are excluded from initial screen batches. A retry
with the same finding UUID reuses an identical target + source asset + region
binding. If any of those evidence coordinates changed, its crop ID receives a
deterministic digest suffix so the earlier artifact remains untouched.) Verification-crop
publication is journaled: `ui-judge` startup and every pack rebuild first
complete a fully finalized crop's pack binding, or restore the prior
request/manifest/run state and remove an incomplete crop before retrying. A
rebuild refuses to replace the manifest when journal recovery cannot complete.
Any mismatch is a hard
error naming the target(s) or asset(s): no engine invocation or review-state
write is allowed, preventing old or modified imagery from sealing a replacement
capture.

The manual `ui-review --record` path applies the same complete capture-time byte-hash and target
fingerprint checks whenever that capture directory has a judge pack, and also
requires the record header's target set to be exactly the pack's target set,
before appending any events. It rejects a stale, target-mismatched, or
run-mismatched pack rather than allowing a manual event header to seal it. A
legacy pack without target judgment evidence is rejected before the record
commit path with an actionable judge-pack rebuild command; its historical
evidence cannot be reconstructed from mutable current templates and exemplars.

### Automation degradation contract

Engine launch failure (including an engine timeout), malformed JSON, every schema-invalid structured output
(except an otherwise valid unlocalizable binding/region claim), incomplete
coverage, or a recording failure never silently falls back to a vague review.
`ui-judge` preserves the
pack, writes a `judge-executor-outcome.v1` file with
`outcome: "needs-agent"`, lists it in the pack manifest, exits nonzero, and does not
write partial review events. The calling agent then resumes with the preserved
pack. Tests inject fake adapters; they never invoke the real `codex` CLI.

### 2. Vision pass (you, the agent)

Read the screenshots in `shots/` and apply `reference/rubric.md` **against the resolved intent**. For each surface judge: consistency vs siblings + DS, token/brand adherence, responsive integrity, hierarchy/alignment, interaction-state presence, and slop-tells. On a native run, read `reference/rubric.md`'s React Native appendix too, and note that each shot's `viewport` label encodes **simulator + appearance** (`QA-iPhone-dark`) rather than a width — so the paired shots are a light/dark comparison. Correlate every visual finding with the scan + audit:

- **Vision → Code** (highest precision): vision flags an inconsistency → the scan shows it is a reinvented atom / inline style → the fix is "use the DS primitive + tokens".
- **axe** gives objective contrast/label/focus violations; **missing-state** (an interaction whose before/after screenshot is byte-identical) flags a control with no visible hover/focus.

### 3. Classify (Scope Governor)

`axe` and vision run on the **whole rendered page**, so they surface **pre-existing** issues too. Before acting, attribute each finding to the change and classify it (below). Fix in-scope blockers; list the rest as follow-ups. Do not let a polish pass become a refactor.

### 4. Fix DRY and iterate

Apply the smallest correct fix (inline → DS atom + token; add the missing state; swap the off token). Re-run `ui-review`; repeat until no in-scope findings remain, then stop.

## Contract

- **Advisory.** Never blind-apply. Verify each finding against the actual screenshot and code path before fixing.
- **Reject** taste-in-a-vacuum, speculative nitpicks, and broad rewrites. A finding must be either corroborated by a code tell/axe, or specific and reproducible ("text overflows its container at 375px"), not "feels unbalanced".
- Prefer the fix at the right ownership boundary; extend a DS atom's props/variants before hand-rolling (see `atomic-design-check`).
- Stop as soon as a run is clean of in-scope findings. Don't re-run for a nicer "clean" line.

## Findings schema

```
{ title, body, priority: P0|P1|P2|P3, confidence: 0..1,
  category: a11y|contrast|responsive|inconsistency|token-drift|
            reinvented-component|missing-state|slop-tell|intent-mismatch,
  evidence: { screenshot, file, line }, recommended_fix, scope: in-scope|follow-up|escalate }
```
Plus an overall `consistent-with-system | drifts-from-system` + why.

## Scope Governor

Freeze a baseline = the surface/diff under review. Classify each finding:

- **in-scope blocker** — introduced by this change, same owner boundary, fixable without changing the task contract.
- **follow-up** — real but pre-existing or an adjacent surface/cleanup.
- **escalate** — needs a new token/component/design decision outside the request.

Stop and report instead of pressing on when: a polish pass turns into a system refactor; the diff grows past ~2× its files/LOC; two fix cycles don't converge; or the right fix is "define the canonical token/component first".

## Exit codes

`ui-review` exits `0` when intent is resolved and the automated scan/capture checks are clean. It exits nonzero when intent is missing, scan findings are present, screenshot capture/config fails, axe violations are present, or interaction states are missing. `ui-scan` exits `0` when nothing actionable is found and nonzero when scan findings are present. Treat nonzero as "look", not "all in scope".

Freshness mode is intentionally separate: `ui-review --verify-fresh [--base
<sha>]` exits 0 only when every selected target is fresh, 3 for stale,
unverifiable, or never-captured targets, and 2 for invalid usage.

## Compose, don't duplicate

- **`atomic-design-check`** — before proposing a "create a component" fix, run its reuse>extend>compose>create discipline; flag reinvented atoms as maintainability findings.
- **`redesign-existing-projects`** — its audit checklist + fix-priority order is the design-correctness vocabulary for the vision pass.
- **`design-taste-frontend`** — its "AI tells" are canonical slop-tells; its brief-inference + three dials feed intent derivation.

## CLIs

| Tool | Role |
|------|------|
| `scripts/ui-review` | Orchestrator: scan + shoot + bundle + durable library + summary (the normal entry point), `--verify-fresh [--base <sha>]` freshness checks (working tree by default; revision-pinned with `--base`), `--judge-pack --run <capture-dir>` pack construction, plus the sole `--record ... --run <capture-dir>` event-log writer. Dispatches to the backend named by `capture.mode`. |
| `scripts/ui-scan` | Static "laziness tells" scanner (diff-scoped). Standalone: `ui-scan --root REPO --base origin/main`. `--ruleset rn-stylesheet` for React Native; `--include <prefix>` to scope a monorepo; `--ignore-rules id1,id2` is the CLI form of `scan.ignoreRules` (unknown ids exit 2; ignored hits are reported under `summary.ignoredByRule`). Exit nonzero on findings. |
| `scripts/shoot.mjs` | Standalone Playwright driver: `shoot.mjs --run run.json`. Screenshots viewports + interaction states + axe-core → manifest. |
| `scripts/shoot-rn.mjs` | Standalone iOS Simulator driver: same `--run run.json` contract and manifest shape. Deep-link navigation, light/dark, AX audit. |
| `scripts/sim-target.cjs` | Shared simulator resolution + accessibility-tree helpers (used by both `ui-review`'s preconditions and `shoot-rn.mjs`). |
| `scripts/png.cjs` | Dependency-free PNG decode/encode/crop/resize. Native region clips, verification crops, judge-pack resizing, and before/after diffs need it — `simctl` only captures the whole display and `sips` cannot crop from an origin. |
| `scripts/ui-judge` | Optional headless automated judge executor: consumes a `judgepack.v1`, calls the isolated engine adapter, verifies region crops, and submits the final event batch through `ui-review --record`. |

## Static rulesets

| | `web-css` (default) | `rn-stylesheet` |
|---|---|---|
| Files | `.tsx`, `.jsx`, `.css` | `.tsx` (excluding tests and `.d.ts`) |
| Tokens | `--globals <globals.css>` custom properties | `--tokens-dir <dir>` — exported TS scale objects, incl. nested numeric scales (`typography.sizes.md`) but not style presets |
| Atoms | `--barrel <index.ts>` exports | `--components-doc <file.md>` inventory tables |
| Rules | inline styles, hardcoded colour/length, stacked shadows, `<style>` tags, direct Hugeicons, raw `<button>` vs atom, em-dash | hardcoded colour/size in style objects, `ActivityIndicator`, native `Alert`/`returnKeyType`, emoji, a11y props on pressables/images/switches, rebuilt atoms, solid chrome, em-dash |
| Rule ids (`scan.ignoreRules`) | `inline-style-literal`, `reinvented-component`, `style-tag`, `hugeicons-direct`, `em-dash`, `hardcoded-color`, `hardcoded-length`, `stacked-shadow`, `hardcoded-shadow` | `rn-hardcoded-color`, `rn-hardcoded-size`, `rn-activity-indicator`, `rn-native-os-ui`, `rn-emoji`, `em-dash`, `rn-a11y-pressable`, `rn-a11y-image`, `rn-a11y-switch`, `rn-reinvented-component`, `rn-solid-chrome` |

Convention-bound web rules, and what they assume: `hugeicons-direct` assumes
the design system wraps icons in an `<Icon>` atom; `reinvented-component`
fires only when the barrel really exports the matching atom; `style-tag` and
`inline-style-literal` assume styles live in a stylesheet layer with tokens (a
CSS Module, or `globals.css` plus token utility classes on Tailwind). When a
project's documented convention contradicts one of these, list it in
`scan.ignoreRules` (see Barrels, route shells, rule opt-outs, and scan scope).

Two calibration facts worth carrying into any new RN project:

- **"Styled" is not a tell in React Native.** `Pressable` is the universal tap primitive — rows, cards, tiles and backdrops are all styled Pressables. The `rn-reinvented-component` rule fires only on button *chrome* (a filled, rounded surface) or a button-ish style key. Keying it off "has a style prop", the way the web rule keys off `className`, produced 80 findings on a reference codebase, all false.
- **Comments are masked before scanning.** Prose that merely names a rule ("loaders are Skeletons, never ActivityIndicator") otherwise reports itself. String literals are deliberately kept: emoji and em-dashes in copy are real findings.

## Onboarding a new project

Add `projects/<name>.json` with `root`, `baseUrl`, `startHint`, `designDoc`, `intentDoc`, an `auth` block, and a `routes` inventory. `configVersion` is optional for backwards compatibility (absent means v1); new configs should set `2`. The config `name` and every record-header `project` must match `^[A-Za-z0-9_-]+$`; they are used as state-directory names and must match exactly. v2 keeps the target `waitFor` name and adds optional `stateProfile`, `sourceFiles`, `captureVariants`, `scrollProbe`, and `flow`. `library: { keepRuns?, maxBytes? }` controls durable retention (`keepRuns` defaults to 30); `judgeContext: { maxBytes? }` controls the bounded per-target context. `judge.timeoutMs` bounds every automated engine call and defaults to 600000 ms; `judge.provider` currently accepts `openai`, `judge.model` defaults to `gpt-5.6`, `judge.apiKeyEnv` may name an uppercase environment variable without storing the credential in config, and `judge.maxRetries` is bounded to 0–5 (default 2). `judge.maxFindingsPerBatch` and `judge.maxFindingsPerRun` are positive-integer caps with defaults 12 and 48. `AUTOREVIEW_UI_JUDGE_TIMEOUT_MS` is a positive-integer test/diagnostic override and is never passed through to either engine. A timeout writes `needs-agent` and no review events. Use `skill:projects/intent/<name>.md` for `intentDoc` unless the user explicitly wants intent stored elsewhere.

**Web:** `tokensCss`, `designSystemIndex`, a `viewports` matrix, `auth.mode: "devLogin" | "none"`, routes with `id`/`route`/`role`/`waitFor`/optional `clip`/`interactions`. For atom-level isolation point one route at a dev-only component gallery if the project has one; element-clipping real routes works otherwise.

Web capture waits are per-project `capture` keys (Playwright only; both are positive integers of milliseconds, at most 2147483647, and both are rejected under `capture.mode: "rn-sim"`, whose targets set their own `timeoutMs`):

- `capture.navigationTimeoutMs` (default `30000`) bounds each dev-server round trip: `page.goto` to the `load` event, and the `auth.mode: "devLogin"` request.
- `capture.waitForTimeoutMs` (default `15000`) bounds each target's `waitFor` visibility wait.

A dev server that compiles a route on its first request (Next.js dev can take 20–60 s) needs both raised, for example `"capture": { "navigationTimeoutMs": 90000, "waitForTimeoutMs": 60000 }`; a production URL normally keeps the defaults. When a wait expires, the target error names the key and its value. The resolved values are written to `run.json` and are part of each target's capture fingerprint (`captureConfig.webTimeouts`), so changing them marks library entries stale with `capture config changed`.

**React Native:** a `capture` block (`mode: "rn-sim"`, `bundleId`, `scheme`, `appearance`, `simulator.deviceName` or `udid`, optional `statusBar` / `stableRetries` / `axAudit` / `session`), a `scan` block (`ruleset`, `include`, `tokensDir`, `componentsDoc`, optional `ignoreRules`), `auth.mode: "reviewSignin" | "none"`, and routes whose `route` is a **registered deep link**. `waitFor` and `clip` are accessibility selectors — get real ones by running `axe describe-ui --udid <udid>` once with the screen open. Screens with no deep link are unreachable; extending the app's linking config is the fix, and is a pure navigation-config addition.

`capture.axAudit` is a lint config: `touchTargetMinPt`, per-rule `rules: { "rn/touch-target-size": false }`, and an `ignore` list of selectors. Note that `rn/touch-target-size` reads the **accessibility** frame, which `hitSlop` does not enlarge — an intentionally small control with `hitSlop` still reports, so confirm against the source before treating it as a defect.

## Headless rule

This skill never opens Preview, Quick Look, a browser window, or the Simulator
window. Do not call `open` on screenshots or force a simulator frontmost.
Inspect captured images through headless CLI attachments or programmatic pixel
reads only.

## Final report

State: the `ui-review` command run; intent source (derived/asked/persisted); findings accepted/rejected with why; in-scope fixes applied and verified by a clean re-run; pre-existing issues listed as follow-ups (not silently fixed or silently ignored).
