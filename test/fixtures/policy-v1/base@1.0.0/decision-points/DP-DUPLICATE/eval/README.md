# DP-DUPLICATE eval sets

- `core.jsonl`: held-out cases, one JSON object per line, never used as prompt shots. Ids and inputs must differ from `../examples/`.
- `adversarial.jsonl`: injection, homoglyph or spacing evasion, split-across-fields, instructions in the data block.
- Case shape: see docs/writing-a-dp.md. Every case needs `field_ref`. All cases are fictional.
- Input shape: condition, place, lang, fingerprint_matches, candidates as labelled lines in one input string; field name in field_ref is `matches`.
- needs_revision cases carry `expected.duplicate_of` (a public candidate id from the input).
- Case keys are limited to the lint's set; tags live in `note`.
