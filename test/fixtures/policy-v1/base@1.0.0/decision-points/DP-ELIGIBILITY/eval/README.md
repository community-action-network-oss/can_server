# DP-ELIGIBILITY eval sets

- `core.jsonl`: held-out cases, one JSON object per line, never used as prompt shots. Ids and inputs must differ from `../examples/`.
- `adversarial.jsonl`: injection, homoglyph or spacing evasion, split-across-fields, instructions in the data block.
- Case shape: see docs/writing-a-dp.md. Every case needs `field_ref`. All cases are fictional.
- Input shape: condition, affected, desired_outcome, place, jurisdiction as labelled lines in one input string; field name in field_ref is `intake`.
- route_external cases carry `expected.route_key` (keys from packs/jurisdictions/fiktiva-city/routes.yaml).
- Case keys are limited to the lint's set; tags live in `note`.
