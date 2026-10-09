# autoreview-ui

**Maat weighs your UI against the feather.** A skill for AI coding agents that reviews how a UI actually renders, before you ship it.

[`autoreview`](https://github.com/openclaw/agent-skills/tree/main/skills/autoreview) reads code. `autoreview-ui` looks at the result: it opens your running app, takes screenshots at several screen sizes and states, checks accessibility, scans the source for lazy shortcuts, and then judges everything against your own design system.

## What it catches

One bug class: lazy UI work. It shows up twice, and this skill looks at both.

- **In the pixels:** uneven spacing, mismatched radii and shadows, missing hover and focus states, layouts that break at 375 px, a rushed screen next to a careful one.
- **In the code:** inline styles, hard-coded colours and sizes instead of tokens, a hand-rolled card where a `<Card>` already exists.

Vision finds the symptom, the static scan finds the cause, and your design system is the ruler. The question is never "is this good?" It is "does this match the rest of the app and the documented design intent?"

## How it works

| Tool | Does |
|---|---|
| `scripts/ui-review` | Captures screenshots of every configured route, in every viewport and state, with an accessibility audit |
| `scripts/ui-scan` | Static scan of the source for inline styles, hard-coded values and reinvented components |
| `scripts/ui-judge` | A vision judge that scores the screenshots against a written rubric and your design intent, and returns structured findings |

- **Web:** a dev server driven by Playwright.
- **React Native:** an iOS Simulator driven through deep links and AXe.
- It never writes into your project repo. Output goes to a separate folder, and your configs stay outside git.

See [`SKILL.md`](SKILL.md) for the full workflow, and `reference/rubric.md` for what the judge checks.

## Requirements

- Node 24 (tested).
- Runtime dependencies: `npm run bootstrap` (runs `npm ci`).
- Playwright 1.60.0 and a browser. The web capture driver uses Chromium today: `npx playwright install chromium`.
- React Native only: Xcode (`xcrun simctl`) and AXe (`brew tap cameroncooke/axe && brew install axe`).
- For the vision judge (`ui-judge`): an OpenAI API key (`OPENAI_API_KEY` or `AUTOREVIEW_UI_JUDGE_API_KEY`), or the `codex` CLI with `--engine codex` after you opt in with `AUTOREVIEW_UI_ALLOW_UNCONFINED_JUDGE=1`.
  Capture and the static scan need no key.

## Install

```bash
git clone https://github.com/Svixel/maat-autoreview-ui ~/.claude/skills/autoreview-ui
cd ~/.claude/skills/autoreview-ui
npm run bootstrap
```

`SKILL.md` calls the folder `~/.agents/skills/autoreview-ui`. Use whichever skills folder your agent reads.

## First run

1. Copy `projects/example.json` to `projects/<your-app>.json` and fill in the base URL, routes and viewports.
2. Copy `projects/intent/example.md` to `projects/intent/<your-app>.md` and describe what your design should feel like.
3. Start your app, then run `scripts/ui-review --project <your-app>`.

Files in `projects/` other than the examples are git-ignored, so your private configs never get committed by accident.

## Update

```bash
cd ~/.claude/skills/autoreview-ui
git pull
npm run bootstrap
```

## Credits

- **[`autoreview`](https://github.com/openclaw/agent-skills/tree/main/skills/autoreview)** from [openclaw/agent-skills](https://github.com/openclaw/agent-skills) (MIT). This skill is built as its companion and follows the same idea: an independent reviewer that gives advice to verify, not orders to apply. Go use that one for code review.
- Its sibling for user journeys: [`ogun-ux-paths`](https://github.com/Svixel/ogun-ux-paths). It reuses this skill's screenshot driver.
- Playwright and axe-core do the capturing and the accessibility audit.

## Status and licence

Shared as is, maintained by [@Svixel](https://github.com/Svixel). Released under the [MIT licence](LICENSE).
