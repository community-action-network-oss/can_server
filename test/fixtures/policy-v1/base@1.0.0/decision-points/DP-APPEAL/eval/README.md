# DP-APPEAL eval sets

- `core.jsonl`: held-out cases, one JSON object per line, never used as prompt shots. Ids and inputs must differ from `../examples/`.
- `adversarial.jsonl`: injection, homoglyph or spacing evasion, split-across-fields, instructions in the data block.
- Case shape: see docs/writing-a-dp.md. Every case needs `field_ref`. All cases are fictional.
- Input shape: decision_ref, original_decision, optional rule_ids_disputed, what_is_wrong and outcome_sought as labelled lines in one input string; field name in field_ref is `what_is_wrong`.
- APPEALS ARE A PROTECTED RIGHT (APPEAL-1, APPEAL-2). No case may be held, revised or routed because of tone, length, missing rule ids or missing evidence. `max_false_reject` and `max_discourage_rate` are 0.0 and may never be raised. Under `expected`, `appeal_stays_open` is true in every case.
- `needs_revision` appears only for a missing or malformed decision_ref, and the appeal is saved and stays open. `hold` only means a human reads it with a summary. There is no `reject` outcome in this DP on purpose.
- Case keys are limited to the lint's set; tags and sources live in `note`; DP-specific expectations live under `expected`.
