# autoreview-ui

An agent skill for a vision and static UI review before you ship a UI change.
It renders the running app (a dev server through Playwright, or an iOS
Simulator through deep links and AXe), screenshots routes across viewports,
appearances and interaction states, runs an accessibility audit, and critiques
the result for design-system consistency.

It targets one bug class, lazy UI work, which shows up twice: in the pixels
(uneven spacing, mismatched radii, missing hover or focus states, layouts that
break at 375 px) and in the code (inline styles, hardcoded colours and sizes
instead of tokens, a hand-rolled card where a `<Card>` atom exists). Vision
finds the symptom, the static scan finds the cause, and the project's design
system is the ruler. The question is never "is this good?" but "does this match
the rest of the app and the documented design intent?". See `SKILL.md` for the
full workflow.

## Requirements

- Node 24 (tested).
- Runtime dependencies installed with `npm run bootstrap` (runs `npm ci`).
- Playwright 1.60.0 and its browser. The web capture driver uses Chromium
  today, so install it with `npx playwright install chromium` if you do not
  have it.
- For React Native review only: Xcode (`xcrun simctl`) and AXe
  (`brew tap cameroncooke/axe && brew install axe`).

## Install

```bash
git clone https://github.com/Svixel/maat-autoreview-ui ~/.claude/skills/autoreview-ui
cd ~/.claude/skills/autoreview-ui
npm run bootstrap
```

`SKILL.md` refers to the skill as `~/.agents/skills/autoreview-ui`; use
whichever skills folder your agent reads.

Per-project configs go in `projects/<name>.json`, and intent docs in
`projects/intent/<name>.md`. Both are git-ignored, so your private configs are
never committed. Start from `projects/example.json` and
`projects/intent/example.md`.

Run the tests with `npm test`.

## Update

```bash
cd ~/.claude/skills/autoreview-ui
git pull
npm run bootstrap
```

## Licence

Personal tooling, shared as is. No licence is set yet, so ask before reusing it commercially.
