# VLM UI-Critique Research Survey (2023–2026)
Collected 2026-08-11 by a research agent for the elevation plan. Companion:
research-2026-08-tools.md (tools landscape). Both feed rubric v2 + judge design.

## Papers table

| Paper (ID) | Takeaway |
|---|---|
| UIClip — arXiv:2404.12500, UIST'24 | CLIP fine-tuned on 2.3M UI/quality-caption pairs + 1.2K designer ratings; numeric design-quality score. Beat larger baselines on agreement with 12 human designers. Usable as fast scalar pre-filter before expensive VLM critique. |
| UICrit — arXiv:2407.08850, UIST'24; github.com/google-research-datasets/uicrit | 11,344 expert critiques with bounding box + ratings for 1,000 RICO mobile UIs. Reference dataset for few-shot critique examples. |
| Visual Prompting w/ Iterative Refinement for Design Critique — arXiv:2412.16829 (Google) | Closest published system to our judge: screenshot + design guidelines → critique list with bounding boxes; iterative few-shot refinement of text+boxes cut the human-expert gap ~50% vs single-shot. |
| Learning to Detect UI Principle Violations via RL — arXiv:2607.20690 | 4B VLM RL-trained on ~10K pages with synthetically injected violations (19-principle taxonomy). Micro-F1 36%→84%. Violation detection is trainable when you can inject known violations — copy the injection trick for judge evals. |
| DesignRepair — arXiv:2411.01606, ICSE'25 | Retrieves from 399-guideline KB (Material) and checks code + rendered page; 92.1% recall vs 32.3% prompt-only. Explicit guideline retrieval >> "know good design" prompting. |
| Can GPT-4o Evaluate Usability Like Human Experts? — arXiv:2506.16345 | Only 21.2% of human-expert issues also found by GPT-4o. VLM heuristic eval is a supplement, not replacement — expect low recall on human-salient issues. |
| AIHeurEval — Springer HCII'25 | Multi-screen heuristic evaluation with MLLMs (paywalled; existence verified). Only multi-screen work found. |
| PerceptUI — arXiv:2606.05697 | Persona-conditioned agents as synthetic users; stock MLLM critiques "superficial or reflect model biases" without alignment. |
| Design2Code — arXiv:2403.03163 | Fine-grained automatic metrics (text/position/color match) for screenshot↔render comparison — template for objective layout-diff metrics beside the VLM judge. |
| ScreenAI — arXiv:2402.04615 | Screen-specialist VLM; screen-element grounding is a learned skill generalists partially lack. |
| ScreenSpot (SeeClick arXiv:2401.10935) / ScreenSpot-Pro — arXiv:2504.07981 | Frontier VLMs weak at precise localization on dense/high-res screens — calibrate trust in pixel claims. |
| VLMs Are Blind — arXiv:2407.06581, ACCV'24 | Trivial low-level tasks (overlap, counting): SOTA VLMs ~58.6% avg. Canonical "don't ask a VLM to measure pixels." |
| SpatialEval — arXiv:2406.14852 | VLMs can fall below random on spatial relations/counting; the image sometimes hurts vs text description. |
| Set-of-Mark — arXiv:2310.11441; Scaffold — arXiv:2402.12058 | Labeled marks / coordinate dot-matrix overlays dramatically improve grounding vs plain CoT. |
| V* / SEAL — arXiv:2312.14135 | Recursive crop-and-zoom fixes small-detail misses in high-res images — basis for the zoomed-crops scaffold. |
| MLLM-as-a-Judge — arXiv:2402.04788, ICML'24 | Judges near-human on PAIR COMPARISON; diverge on absolute scoring and batch ranking; biases persist. |
| CriticGPT — arXiv:2407.00215 | Longer critiques = more hallucinations/nitpicks; precision-recall dial (FSBS). The core tension our judge inherits. |
| Self-Refine — arXiv:2303.17651; Vision-Guided Iterative Refinement — arXiv:2604.05839; UI2Code^N — arXiv:2511.08195 | Critique→fix→re-judge loops show monotonic gains, diminishing returns, no published convergence bound — cap iterations. |

## Empirical guidance

**Reliable:** relative visual hierarchy; aesthetic RANKING of two variants;
guideline-violation detection when the guideline text is in-context (92%
recall); categorical violations; high-level layout description.

**Unreliable:** exact pixel gaps/margins; alignment within a few px; counting;
small-text legibility; geometric overlap (~59%); precise localization on
dense screens; absolute 1–10 scores; recall of human-salient usability
issues (21% overlap). Contrast ratios are arithmetic — compute, don't ask.

## Scaffolds to adopt

1. **Pairwise/reference framing, never bare "rate this."** Judge against a
   sibling screen or known-good reference; A/B variants. Pairwise is the only
   mode where MLLM judges match humans.
2. **In-context rubric retrieval** — inject the project's specific rules
   per-surface (tokens, spacing scale, sheet/popup standards), DesignRepair-
   style (~3x recall).
3. **Forced evidence citation**: every finding = {rule id, region, what's
   visible}. Drop findings the model can't localize.
4. **Set-of-Mark / coordinate grid overlay** on screenshots before judging —
   reproducible region references instead of "the button lower left."
5. **Zoomed crops for anything small** (badges, captions, dense rows) —
   crop-then-rejudge.
6. **Compute, don't perceive, the measurables.** Spacing/alignment/contrast
   from the view hierarchy or pixel analysis, handed to the VLM as facts;
   VLM reserved for semantic judgment.
7. **Structured checklist pass per rubric item (yes/no/evidence)**, then a
   self-verification pass over its own findings.
8. **Cheap scalar gate first**, full critique only on regressions/divergence
   — cost control + a trend metric across runs.
9. **Cap fix-verify loops (~2–3)**; the re-judge compares before/after
   screenshots pairwise.

## Open risks

- Low recall vs human experts is the field's headline result (21.2%): the
  judge is a regression net + guideline linter, not a designer replacement.
- Precision–recall dial is unavoidable: comprehensiveness inflates nitpicks;
  tune with a small labeled set of real findings from our own app.
- Absolute scores drift; only pairwise deltas are trustworthy for gating.
- Multi-screen consistency judging is underexplored — build a tiny eval from
  deliberately-broken screens (violation-injection trick).
- Mobile critique data is RICO-era Android; styled dark/Skia-heavy UIs like
  a stylised game UI are out-of-distribution for every dataset above.
