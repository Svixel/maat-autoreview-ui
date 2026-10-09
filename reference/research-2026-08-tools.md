# Automated UI/Design Review Loops — Landscape Survey (2024–2026)
Collected 2026-08-11 by a research agent. Companion: research-2026-08-papers.md.

## Tools table

| Tool / Repo | Loop shape | What it judges | URL |
|---|---|---|---|
| Maestro `assertWithAI` / `assertNoDefectsWithAI` | Flow step → screenshot → LLM assertion (or premade defect prompt) → boolean + HTML/JSON report. No fix step. | Semantic screen state; premade sweep for cut-off text, overlap, off-center | docs.maestro.dev/api-reference/commands/assertwithai · …/assertnodefectswithai |
| OneRedOak design-review (Claude Code workflow) | PR diff or /design-review → Playwright MCP drives live app → phased subagent review → findings → fixes | Consistency vs principles in CLAUDE.md, WCAG AA+, responsive, interaction | github.com/OneRedOak/claude-code-workflows (design-review) |
| DesignRepair (ICSE'25, OSS) | Dual-stream: LLM extracts components from code + Playwright analyzes rendered page → RAG vs Material KB → repair | Guideline violations, a11y; 89.3% recall / 86.6% precision | arxiv.org/abs/2411.01606 · github.com/UGAIForge/DesignRepair |
| Applitools Eyes / Autonomous | LLM at authoring only; runtime deterministic visual model → diff review UI | Meaningful change vs noise; a11y | applitools.com/blog/applitools-autonomous-eyes-ai-testing-updates |
| Percy Visual Review Agent (2025) | Snapshot diff → AI bounding-boxes meaningful changes + NL summary; ~40% noise filtered | Change significance (baseline-diff) | browserstack.com/docs/percy/ai-agents/visual-review-agent/overview |
| Chromatic / Lost Pixel / Argos | Pixel diff vs git-aware baselines; human accept/reject | Regression only | chromatic.com · lost-pixel.com · argos-ci.com |
| Meticulous | Prod-session record → deterministic replay per PR → regression | Regression | meticulous.ai |
| QA Wolf | Managed humans+AI Playwright suites | Functional + visual regression | qawolf.com |
| Skyvern / browser-use / AppAgent / Mobile-Agent | Vision/DOM agents that EXECUTE tasks; capture drivers, not judges | Task completion | github.com/Skyvern-AI/skyvern · github.com/browser-use/browser-use |
| UICrit (UIST'24 dataset) | Few-shot + visual prompting gave 55% gain in LLM critique quality | Region-grounded critiques | arxiv.org/abs/2407.08850 |
| Google iterative visual-prompting critique | (comment, bounding box) pairs iteratively refined; halved gap to experts | Guideline-grounded critique | arxiv.org/abs/2412.16829 |
| CHI'24 mockup-feedback plugin | Figma + GPT-4 + user heuristics; utility DECREASED over iterations | Heuristic violations | dl.acm.org/doi/10.1145/3613904.3642782 |
| Figma design linters | Static scan of Figma files for token/system violations | Token drift | Design System Linter Pro (Figma community) |

## Techniques worth adopting

1. **Dual-stream judging** — code stream + rendered stream cross-referenced
   against the guideline base, ONE merged verdict (DesignRepair).
2. **Ground every finding to a region, verify in a second pass** — a cheap
   re-check of each (comment, box) pair kills most hallucinated findings.
3. **Few-shot with rated exemplar critiques of OUR OWN app** (3–5 canonical
   good/bad screens with severity) — UICrit's 55% gain came from this.
4. **Named heuristics in the prompt** — generic "critique this" underperforms
   the project rubric badly.
5. **Directive sweeps as narrow premade prompts** — one focused question per
   directive across every screen (Maestro assertNoDefectsWithAI pattern);
   narrower question, higher recall.
6. **Cross-screen consistency via multi-image calls** — batch 4–8 sibling
   screens per call with `Image N:` labels, name one ANCHOR screen, ask only
   for deviations from the anchor.
7. **Measurements from the tree, not the model** — dump the view/AX hierarchy
   (`maestro hierarchy`, AXe) beside the screenshot; the VLM judges whether
   spacing is wrong, the numbers come from the tree. Set-of-Mark numbered
   overlays help grounding; coordinate dot-grids are unreliable.
8. **Meaningful-change filtering + one-line NL summary per finding** —
   "Card padding 12 here vs 16 on Shop — token spacing.md expected."
9. **Phased checklist over one mega-prompt** (interaction / responsive /
   visual polish / a11y / robustness), principles kept in one doc.
10. **Token efficiency** — resize to 1568px long edge (~1.5k tokens/screen);
    batch 6–8 screens per judge call (~10–12k tokens); Files API file_id to
    reuse screenshots across fix-loop turns; Batch API (50% off) for nightly
    sweeps; images BEFORE text in the prompt.
11. **Cap the fix loop** — initial + verify-after-fix captures most value;
    re-judge only screens whose code changed.

## Dead ends

- Pixel-diff as a design judge (regression only; keep separate).
- Asking a VLM for exact pixel measurements/coordinates.
- Treating the VLM as a replacement heuristic evaluator (21.2% recall of
  human-expert issues; strongest on aesthetic/minimalist heuristics — our
  use case — but still a drift catcher, not a designer).
- Live LLM calls inside deterministic test execution (slow, nondeterministic;
  Maestro AI commands experimental, prompt not customizable — issue #2054).
- Unbounded critique-fix iteration (utility declines, then invents nitpicks).
- Vision-agent navigation for capture when a deterministic driver exists.
- OCR-instead-of-image cost tricks (discards the layout/spacing/color signal).
