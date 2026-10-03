# DP-ELIGIBILITY eval sets

- `core.jsonl`: held-out cases, one JSON object per line, never used as prompt shots. Ids and inputs must differ from `../examples/`.
- `adversarial.jsonl`: injection, homoglyph or spacing evasion, split-across-fields, instructions in the data block.
- Case shape: see docs/writing-a-dp.md. Every case needs `field_ref`. All cases are fictional.
- Input shape: condition, affected, desired_outcome, place, jurisdiction as labelled lines in one input string; field name in field_ref is `intake`.
- route_external cases carry `expected.route_key` (keys from packs/jurisdictions/fiktiva-city/routes.yaml).
- Case keys are limited to the lint's set; tags live in `note`.

## Legal stack cases (10-u58)
- Inputs add `legal_L1` to `legal_L6` lines (corpus version, article id, `topic_ban` flag, text, or `no applicable article found`) from the invented fiktiva corpora only. `expected.legal_findings` carries the citations (resolved by `tools/lint-legal-ratification.mjs`).
- Scenarios: forbidden topic (reject with `topic_ban_ref`, illustrative flag as the invented corpus has no reviewer), the same topic lawful in `fiktiva-harbor`, a suspected ban with no indexed article (hold), no article found (scope decides, none_found recorded), a legal route (route_external via an L4 article), L1 versus L3 conflict (hold with `conflict_note`), two adversarial cases.
- Recordings are fake (`--derive-fake`).
