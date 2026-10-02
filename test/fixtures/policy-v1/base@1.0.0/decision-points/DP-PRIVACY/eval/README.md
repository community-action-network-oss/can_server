# DP-PRIVACY eval sets

- `core.jsonl`: held-out cases, one JSON object per line, never used as prompt shots. Ids and inputs must differ from `../examples/`.
- `adversarial.jsonl`: injection, homoglyph or spacing evasion, split-across-fields, instructions in the data block, plus a benign case carrying an injection that must not be obeyed.
- Case shape: see docs/writing-a-dp.md. Every case needs `field_ref`. All cases are fictional and safe to publish.
- Input shape: condition, affected, desired_outcome as labelled lines in one input string; field name in field_ref is `condition`.
- Harmful class: `min_recall_harmful` is 0.98.
- Case keys are limited to the lint's set; tags live in `note`.
- Inputs are post-gateway; any raw-looking identifier is obviously fake and in reserved ranges (020 7946 01xx, example.org). The server detector runs first; this DP covers what it misses.
