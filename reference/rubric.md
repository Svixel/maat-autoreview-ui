# UI-review rubric (consistency, not taste)

The vision pass uses this. Judge every surface against **the rest of the app +
the resolved design intent**, not abstract beauty. A finding ships only if it is
(a) corroborated by a scan tell or axe violation, or (b) specific and
reproducible. "Feels off" is not a finding; "the card's radius is larger than
every sibling card" is.

Always have the design intent in hand first (SKILL.md → Resolve design intent).
Without it you will flag deliberate choices.

## The four layers

A production-ready review is not just "are the pixels token-correct." Judge each
surface on four layers — a screen can pass one and fail another:

1. **Pixels & design system** — typography, color/tokens, shadows, spacing,
   responsive, a11y, slop-tells. *Is each element rendered correctly and
   consistently?* (§§1–8)
2. **Interaction & logic** — *does the flow make sense to a real user?* States,
   honest feedback, no silent data loss, no dead ends, no fake locks. (§9)
3. **Composition & presentation** — *is the right primitive used the right way?*
   The correct block/layout for the content, compare/contrast in columns, visual
   variety vs a wall of one thing, deliberate beats vs an undifferentiated
   scroll. (§10)
4. **Intent match** — *does the surface serve its stated purpose, audience, and
   feeling?* (§11)

Layers 2–4 usually need the app **driven**, not just screenshotted: navigate it,
fill the forms, submit, hit the edges. Where the project has a content/authoring
layer, review **how content is composed**, not only whether components render.

---

# LAYER 1 — Pixels & design system

## 1. Consistency vs siblings + design system  `inconsistency` / `reinvented-component`
- Does this element match other instances of the same thing elsewhere in the app
  (same padding, radius, shadow step, type scale)? Put the new surface next to a
  known-good sibling screenshot and compare.
- Is it a **reinvented atom** — a bespoke card/button/input/field instead of the
  design-system primitive? (The scan flags styled raw `<button>/<input>` and
  direct Hugeicons; correlate. A rule the project's documented conventions
  contradict is switched off by `scan.ignoreRules` and listed as ignored in the
  summary; do not re-raise it.)
- Are forms built from the canonical pattern (label + control + error wrapper) or
  hand-rolled label/input/error divs?

## 2. Token & brand adherence  `token-drift`
- Colors, radii, shadows, spacing, type, motion: do they read as the system's
  tokens, or off-by-a-bit one-offs (a slightly different grey, a radius between
  two steps, a harsher shadow)?
- Brand vs semantic: are saturated brand colors used for app chrome where a
  semantic surface/text token belongs? (Reserve expressive color for the moments
  intent calls for.)
- **Shadows — one soft elevation step, and they must not overlap or restack.**
  Never stacked shadow strips on one element; tint shadows toward the background
  hue, not pure black. And respect the elevation *hierarchy*: a row/tile **nested
  inside an already-elevated container** stays flat (hairline only) — only a
  *standalone* clickable card resting on the page background gets the lift (and
  rises on hover/focus). Two elevated surfaces touching/overlapping so their
  shadows pool is a finding. (Bind to the project's documented elevation rule.)

## 3. Typography & readability  `inconsistency` / `token-drift`  ← often the biggest gap
The pixel pass under-checks type. Judge against the project's type tokens:
- **Measure (line length).** Body/prose must cap at the project's reading-width
  token (~60–75ch). Full-width lines of running text are a finding — name the
  measure ("body text runs ~110ch at 1280px; reading cap is ~65ch").
- **Leading (line-height).** Body needs generous leading (≈1.5–1.6); display/
  titles want tight leading (≈1.05–1.2). Flag cramped body or balloon-loose
  headings.
- **Hierarchy & scale.** One clear focal point per view; the type scale expresses
  hierarchy (not five competing sizes, not two headings fighting). Display text
  should have presence — size + weight + tracking, not just bigger.
- **Tracking.** Large display wants slightly negative tracking; small caps/labels
  want positive. Flag default `letter-spacing` on hero-scale type.
- **Weights.** Real hierarchy uses medium/semibold steps, not just 400/700.
- **Orphans & wrapping.** A single word alone on a heading's last line, or a
  heading that breaks awkwardly — wants `text-wrap: balance`/`pretty`. Flag
  orphaned display headings.
- **Numbers.** Data/tabular figures should use tabular-nums so columns align.

## 4. Spacing, vertical rhythm & whitespace  `inconsistency`
- **Rhythm on the scale.** Gaps between elements and sections come from the
  spacing scale, not arbitrary px. Adjacent blocks whose vertical gaps don't sit
  on the scale read as drift.
- **Breathing room.** Calm/marketing surfaces should breathe — when in doubt the
  fix is usually *more* vertical space, not less (dense is for data tables, not
  reading or hero surfaces). Flag cramped sections that fight the intended
  density.
- **Optical padding.** Section top/bottom padding is often optically better
  *unequal* (a bit more on the bottom). Mechanically-equal padding that reads
  tight or top-heavy is a (P3) finding.
- **Grouping.** Related things grouped, unrelated things separated; consistent
  rhythm signals structure. Uneven inter-section gaps (one scene cramped, the
  next airy, no reason) is a finding.
- **Alignment.** Optical alignment of edges, baselines, icon+text; nothing 1–3px
  off.

## 5. Responsive integrity  `responsive`
Across the viewport matrix (375 / 768 / 1280 / 1920):
- Overflow, horizontal scroll, clipped or truncated text, broken wraps, elements
  colliding or escaping containers.
- The fold: is the primary action reachable; is anything important hidden behind
  an overlay at 375px?
- Tap targets ≥ ~44px on mobile; controls not cramped.
- Layout doesn't just shrink — does it reflow sensibly (stacks, sheets) at small
  widths? A multi-column layout that stays multi-column at 375px is a finding.

## 6. Interaction states (presence)  `missing-state`
Every interactive element must visibly change on **hover, focus-visible, active,
disabled**, and open/expanded where applicable.
- The manifest's `changed=false` (before/after byte-identical) is a hard signal
  of a **missing state** — no hover, or no focus ring. Treat as a real finding.
- Focus ring must be visible and meet contrast on its surface (the system
  re-scopes the ring per surface — check brand/navy surfaces specifically).
- Disabled state must look disabled (not just non-functional).
- Loading / empty / error states: did the change ship only the happy path? (A
  classic lazy gap.) *(Whether those states behave correctly is Layer 2, §9.)*

## 7. Accessibility & contrast  `a11y` / `contrast`
- Take axe violations as objective findings: contrast < 4.5 (normal) / 3 (large),
  missing labels/names, aria-hidden focusables. Attribute to the change vs
  pre-existing before acting.
- Text on tinted/photographic backgrounds: legible at the smallest size shown.
- Icon-only controls have an accessible name.
- Motion respects `prefers-reduced-motion`; animation isn't load-bearing for
  meaning.

## 8. Slop-tells  `slop-tell`  (compose `design-taste-frontend`)
- Em-dashes in UI copy (in product chrome, not editorial content), fake
  placeholder screenshots, version labels in heroes, generic step labels,
  oversaturated/AI-default accent colors, center-bias everywhere, split-header
  clichés, three-equal-cards as the default feature row.

---

# LAYER 2 — Interaction & logic  `logic` / `missing-state`

*Does the flow make sense when you actually use it?* This needs the app driven —
click through, type, submit, reload, tab with the keyboard, try the edges.

- **Honest feedback / completion signals.** A control's *stated* requirement must
  equal its *actual* behavior. A counter saying "29 characters to go" while the
  thing accepts 1 char, a "pick at least 4" hint where the gate accepts 2, a
  "Min N chars" label that isn't enforced — these contradictions on one screen
  are a top-severity logic finding. The user must always be able to trust what
  the UI tells them about their progress.
- **No silent data loss.** Input that vanishes on reload/navigation/locale-switch
  without warning (unsaved local-only state that *looks* saved); a keyboard
  focus that select-all's a filled field so the next keystroke wipes it; a
  destructive action with no confirm. Either persist, or disclose the limit.
- **No fake locks, no dead ends.** A disabled primary CTA with no explanation
  reads as broken (a soft "you have N left" hint is better than a hard-disabled
  button). A blocked/empty/end state must say *what's missing* and link forward —
  never a dead-end "almost there" with no path.
- **State transitions make sense.** Save/submit/complete give visible, truthful
  feedback; optimistic UI reconciles; errors say what happened and what to do.
- **Keyboard & touch parity.** Every drag has a keyboard/select fallback; every
  custom control is operable by keyboard; touch targets work without hover; a
  scrollable matrix keeps its headers in view. Mobile interaction must *work*,
  not just reflow.
- **The path is sensible.** Navigation/progression matches the mental model
  (what unlocks what, what "done" means, how to get back). Trace a real task end
  to end and ask where a first-timer would get confused or stuck.

---

# LAYER 3 — Composition & presentation  `composition` / `reinvented-component`

*Is the right primitive used, the right way?* Review **how content is composed**,
not just whether components render. Where the project has an authoring/content
layer, this is where most "it works but reads poorly" findings live.

- **Right block for the content.** Compare/contrast, pros/cons, before/after,
  problem/solution, text+example → a **two-/multi-column** layout, not stacked
  prose. Key numbers → a stat/figure primitive, not buried in a sentence. A
  procedure → an ordered list. A definition aside → a callout. Flag content
  whose *shape* doesn't match its *meaning* when a system primitive fits.
- **Columns used well.** The ratio matches the content (balanced 1:1 for peers,
  asymmetric for text+aside); lanes are reasonably balanced; nothing heavy is
  crammed into a narrow lane; columns collapse sensibly on mobile; don't force
  columns where one column reads better, and don't over-nest.
- **Visual variety & beats.** A long surface should have deliberate beats —
  section breaks, varied backgrounds/moods where the system supports them, rhythm
  between teaching/doing/reflecting — not one undifferentiated wall of the same
  block or one endless scroll. Flag "every section identical" *and* "no structure
  at all."
- **Expressive primitives actually used.** If the design system ships expressive
  moments (highlight marks, stat stickers, scene backgrounds, eyebrows that carry
  real category/step info) and the content uses none of them where intent calls
  for warmth/emphasis, the surface reads flat — a presentation finding, not just
  taste. Conversely, flag expressive elements over-used to the point of noise.
- **Restraint per intent.** Match the project's chosen expressiveness dial (e.g.
  "warm but calm" ≠ "maximal everywhere"). Both under- and over-composition are
  findings against the intent.

---

# LAYER 4 — Intent match  `intent-mismatch`

- Does the surface serve its stated **purpose, audience, and feeling**? A
  technically consistent, well-composed screen can still miss intent (a focused
  workflow that reads like a marketing page, or vice-versa).
- Flag only against an intent you actually have — otherwise ask. Never critique
  "ugliness" in a vacuum; without intent you will flag deliberate choices.

---

## Severity
- **P0** — broken/unusable: overflow that hides content, illegible contrast on a
  primary action, an interactive control with no affordance at all, data loss on
  a normal action, a flow with no way forward.
- **P1** — clearly wrong vs the system/intent on a primary surface: reinvented
  atom, missing focus ring, inconsistent primary CTA, a completion signal that
  lies, full-width unreadable body measure on a reading surface.
- **P2** — token drift, secondary-surface inconsistency, minor responsive
  cramping, the right-block-not-used where a column/stat clearly fits.
- **P3** — polish: optical nudges, tracking/orphans, slop-tells, copy, mild
  rhythm unevenness.

## Findings categories
`a11y` · `contrast` · `responsive` · `inconsistency` · `token-drift` ·
`reinvented-component` · `missing-state` · `slop-tell` · `logic` · `composition`
· `intent-mismatch`

## Correlate before you report
For each visual finding, pull the matching scan tell and axe node. The strongest,
most actionable findings are the ones where the pixel anomaly and the code cause
agree — and the fix names a real token or atom. For Layer 2/3 findings, cite the
concrete repro (the field, the file:line, the step that reads flat). Where signals
disagree (vision sees nothing but the scan flags a tell, or axe fires where the
render looks fine), say so and lower confidence.

---

# APPENDIX — React Native (the `rn-sim` backend)

The eleven categories above are platform-neutral and all still apply. This
appendix only says how they *land* on a native screenshot, and which of them
do not exist here. Read it whenever a bundle's `captureMode` is `rn-sim`.

## What changes about the evidence

- **The paired shots are light vs dark, not narrow vs wide.** A shot's
  `viewport` label is `<simulator>-<appearance>` (`QA-iPhone-dark`). Judge
  every surface twice and compare the pair directly.
- **One width.** "Responsive integrity" becomes *safe-area* and *dynamic-content*
  integrity (below), not breakpoint behaviour.
- **The status bar is overridden** to a fixed time and battery so shots diff
  cleanly. It is not a rendering bug.
- **Shots may be unstable.** If a target's `errors` mention the display never
  settling, the frame may be mid-animation. Re-run before reporting layout.

## Categories that do NOT apply — never report these

- **Hover, focus rings, and `:active`.** `missing-state` findings of this kind
  are invalid on iOS: there is no pointer and no DOM focus. The real state
  affordance is the `pressed` style callback, which is a *code* judgement.
  A `changed: false` interaction here means the tap produced no visible
  change at all, which is still worth a look.
- **Breakpoint/reflow bugs.** No viewport matrix exists to produce them.
- **CSS-shaped causes** — inline `style={{}}` and `StyleSheet.create` are the
  correct, idiomatic pattern. Only the *values* inside them are ever a finding.

## Categories that gain a native meaning

**Safe areas** `responsive` / `inconsistency`
The most common real defect. Look at the top and bottom edges of every full
shot: content colliding with the status bar or the home indicator, a header
that starts under the notch, or a CTA sitting on the home bar. In systems
where the screen owns its own top inset, a screen that forgets it is
immediately visible as content riding too high.

**Keyboard avoidance** `logic` / `responsive`
On any screen with a text field, the keyboard must not cover the field being
typed into or the submit control. Capture a `fill` interaction and look at
what the keyboard hides.

**Chrome treatment** `inconsistency`
If the system specifies a blur/scrim treatment for headers, footers and tab
bars so content scrolls beneath them, a flat opaque bar is drift — and the
`rn-solid-chrome` scan rule names the file. Check the two together.

**Touch targets** `a11y`
The audit's `rn/touch-target-size` uses the accessibility frame. `hitSlop`
enlarges the *touchable* area but not that frame, so deliberately small
controls report here. Confirm against the source before calling one a defect;
the intent doc should list the settled ones.

**Accessibility labels** `a11y`
`rn/button-name` and `rn/image-alt` are the native analogue of axe-core's
label rules, and they matter more here: an unlabelled control is not only
unusable with VoiceOver, it is also *unaddressable by this skill's own
selectors*. A screen you cannot write a `waitFor` for is a screen with an
accessibility problem.

**Light/dark parity** `contrast` / `token-drift`
Compare the paired shots. A hardcoded colour that reads fine in light mode
and becomes invisible in dark is the single highest-yield native finding, and
it correlates directly with an `rn-hardcoded-color` scan tell on the same
file. Check text, icons, borders, and any scrim over an image.
