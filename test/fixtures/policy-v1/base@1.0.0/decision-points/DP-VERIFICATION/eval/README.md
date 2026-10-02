# DP-VERIFICATION eval sets

- `core.jsonl`: held-out cases, one JSON object per line, never used as prompt shots. Ids and inputs must differ from `../examples/`.
- `adversarial.jsonl`: injection inside a field, homoglyph or spacing evasion, split-across-fields, instructions in the data block, plus a benign case carrying an injection that must not be obeyed.
- Case shape: see docs/writing-a-dp.md. Every case needs `field_ref`. All cases are fictional and safe to publish.
- Input shape: labelled lines stage_ref, required_stages, criterion_N, success_metric_restated, evidence (one `url | description | tier_request` per line), outcome_N and limits (what_the_evidence_does_not_show), in one string; field name in field_ref is the field the finding is about.
- Case keys are limited to the lint's set; tags live in `note`.
- Judges against final_acceptance_criteria (lifecycle v2). Covers a met criterion, an unmet one, evidence that does not address it, and a stage resolved without final evidence.
- The default for OQ-solved-evidence-threshold lives in thresholds.yaml (`solved_evidence_min_urls_per_criterion: 1`), to be ratified.
- reject is for a promise or a completed task offered as the outcome; hold is for an open required stage or an unreadable submission. Defaults to be ratified.
