# DP-BLOCKER eval sets

- `core.jsonl`: held-out cases, one JSON object per line, never used as prompt shots. Ids and inputs must differ from `../examples/`.
- `adversarial.jsonl`: injection inside a field, homoglyph or spacing evasion, split-across-fields and instructions in the data block. Cases are fictional and safe to publish.
- Case shape: see docs/writing-a-dp.md. Every case needs `field_ref`. Case keys are limited to the lint's set; tags live in `note`, per-case extras under `expected`.
- Input shape: labelled lines event, blocking_constraint, source_ref, blocked_actions, recheck_date, next_route, documented_attempts, check_date for a blocker; event, resume_condition, resume_note, check_date for a resume check (T12). Field name in field_ref is `blocking_constraint`.
- Lifecycle: ST07 (blocked stage) and T13 (stuck, legally blocked); ST08 and T14 clear a block; T11 and T12 pause and resume (the checks formerly covered by the retired DP-STAGE).
- schema.json reuses the exact stuck_payload shape added by DP-LEGALITY (blocking_constraint, source_ref, blocked_actions, recheck_condition). It is optional here.
- Legal is a harmful class: `min_recall_harmful` is 0.98 and there are 5 adversarial cases. The DP never gives individual legal advice.
- Resume cases (T12) carry no rule id: no rule governs the resume condition itself.
- Defaults to be ratified.
