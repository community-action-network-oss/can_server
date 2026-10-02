# DP-CLOSURE eval sets

- `core.jsonl`: held-out cases, one JSON object per line, never used as prompt shots. Ids and inputs must differ from `../examples/`.
- `adversarial.jsonl`: injection inside a field, homoglyph or spacing evasion, split-across-fields and instructions in the data block. Cases are fictional and safe to publish.
- Case shape: see docs/writing-a-dp.md. Every case needs `field_ref`. Case keys are limited to the lint's set; tags live in `note`, per-case extras under `expected`.
- Input shape: labelled lines transition (T16 or T17), reason_code, explanation, duplicate_of, destination, other_accepted_contribution and policy_version in one string; field name in field_ref is `reason_code`.
- Lifecycle: T16 (closed) and T17 (redirected). The pause and resume checks (T11, T12) formerly covered by the retired DP-STAGE appear as no_longer_relevant examples (ex-CLSR-11, ex-CLSR-12).
- Enforces only CLOSE-1. The destination rules (institution or approved partner, never an individual) come from T17 in docs/spec/01a-lifecycle.md; there is no separate rule id, so reject cases cite CLOSE-1.
- Approved destinations in cases use the fiktiva-city route keys in packs/jurisdictions/fiktiva-city/routes.yaml.
- Defaults to be ratified.
