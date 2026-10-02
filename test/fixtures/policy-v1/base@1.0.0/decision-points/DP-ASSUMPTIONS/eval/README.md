# DP-ASSUMPTIONS eval sets

- `core.jsonl`: held-out cases, one JSON object per line, never used as prompt shots. Ids and inputs must differ from `../examples/`.
- `adversarial.jsonl`: injection, homoglyph or spacing evasion, split-across-fields, instructions in the data block.
- Case shape: see docs/writing-a-dp.md. Every case needs `field_ref`. All cases are fictional.
- Input shape: optional jurisdiction and competence lines, then the problem fields (condition, affected, causal_hypothesis, assumptions) as labelled lines in one input string; field_ref names the field that carries the assumption.
- This DP never emits reject (ASSUMP-1: a fixable error is never rejected).
- Guidance pairs from `content-schemas/problem/examples/guidance-index.json` are eval cases; their `note` starts with `source: x-guidance:problem.<field>`.
- One hint per field; legal readings point to the pack version on the form or ask the poster to mark the reading unverified.
- Case keys are limited to the lint's set; tags and sources live in `note`; DP-specific expectations live under `expected`.
