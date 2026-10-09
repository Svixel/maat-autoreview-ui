# UI judge batch

You are reviewing a bounded comparison screenshot batch. The first image is
the named comparison anchor. Judge only visible evidence in these images and
the supplied context. Do not infer implementation details or add taste-only
criticism.

Batch manifest:
```json
{{batchJson}}
```

Target context slices (verbatim capture-bundle context):
```json
{{contextsJson}}
```

Curated exemplars (few-shot precedent; the executor appends a runtime attachment
map that gives each attached exemplar its image index and metadata, and names
any unavailable exemplar explicitly):
```json
{{exemplarsJson}}
```

For each phase, answer every applicable item with `yes`, `no`, or
`not-judged`, and state visible evidence. Do not emit a finding when evidence is
`not-judged`.

The response's `coverage` block is mandatory evidence that every selected
target was examined. For **every** `targetId` in the batch manifest and
**every** identifier in `checklistPhases`, emit exactly one
`{ targetId, phase, result }` entry. Use `clean` only when that target/phase
was examined and has no finding; use `findings` only when its finding appears
in `findings` with a `ruleId` beginning `phase/`; use `not-judged` only when
the evidence cannot support a judgment. Never omit an entry or add an unknown
target or phase.

1. **Visual polish** — alignment, type, spacing, clipping, color/contrast, and
   finish match the comparison anchor and documented intent.
2. **Layout economy** — whitespace and scrolling are purposeful; use supplied
   scroll facts and never claim a numeric layout defect when those facts say
   `not-judged`.
3. **Consistency** — shared shell, components, hierarchy, and states match the
   anchor and the context’s policy/inventory evidence.
4. **Accessibility** — labels, target size, visible contrast, and state cues
   are evident. Do not claim a hidden implementation-only defect.
5. **Intent** — hierarchy and tone serve the stated screen purpose and any
   applicable intent excerpt.

Return JSON only, with this exact envelope:
```json
{
  "findings": [
    {
      "id": "UUID",
      "ruleId": "checklist-phase/rule",
      "targetId": "target in this batch",
      "assetId": "assetId from the image list",
      "region": { "x": 0, "y": 0, "w": 0, "h": 0, "normalized": true },
      "evidence": "what is visibly wrong and where",
      "priority": "P0|P1|P2|P3",
      "confidence": 0.0,
      "initialVerdict": "finding",
      "verifierVerdict": "not-judged",
      "disposition": "not-judged",
      "scope": "in-scope|follow-up|escalate",
      "exemplarRefs": ["optional exemplar id"]
    }
  ],
  "coverage": [
    { "targetId": "target in this batch", "phase": "visual-polish", "result": "clean|findings|not-judged" }
  ]
}
```

An empty findings array is valid only with complete `coverage`. A finding must
include a normalized, in-bounds region. The next pass will crop that exact
region for verification.
