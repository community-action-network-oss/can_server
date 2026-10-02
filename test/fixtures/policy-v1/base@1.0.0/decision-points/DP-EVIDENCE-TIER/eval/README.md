# DP-EVIDENCE-TIER eval sets

- `core.jsonl`: held-out cases, one JSON object per line, never used as prompt shots. Ids and inputs must differ from `../examples/`.
- `adversarial.jsonl`: injection inside a field, homoglyph or spacing evasion, split-across-fields and instructions in the data block. Cases are fictional and safe to publish.
- Case shape: see docs/writing-a-dp.md. Every case needs `field_ref`. Case keys are limited to the lint's set; tags live in `note`, per-case extras under `expected`.
- Input shape: labelled lines claim, source_description, source_category, tier_request and observation_date in one string; field name in field_ref is `claim`.
- Enforces only EVID-URL-1. EVIDENCE-TIERS is not a rule id (open question), so no case cites it.
- The `tier` output is PROVISIONAL: values come from the tier_request enum in content-schemas/stage_evidence (b0d923f) and verification (7adca17); names are open (OQ-evidence-tier-plain-language). Publish cases carry `expected.tier`.
- The metadata is stored data; the DP never fetches a URL.
- Thresholds: not a harmful class, so `min_recall_harmful` is 0.90. Defaults to be ratified.
