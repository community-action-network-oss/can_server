# DP-DECISION-RECORD eval sets

- `core.jsonl`: held-out cases, one JSON object per line, never used as prompt shots. Ids and inputs must differ from `../examples/`.
- `adversarial.jsonl`: injection inside a field, homoglyph or spacing evasion, split-across-fields, instructions in the data block, plus a benign case carrying an injection that must not be obeyed.
- Case shape: see docs/writing-a-dp.md. Every case needs `field_ref`. All cases are fictional and safe to publish.
- Input shape: labelled lines named after the decision_record fields plus stage_decision_method (from the stage metadata), one per line, in one string; legal_gate_record is written `layer=...; result=...; checked=...; source=...`. field name in field_ref is the field the finding is about.
- Case keys are limited to the lint's set; tags live in `note`.
- A missing required part is hold (DECISION-REC-1 enforcement is hold); a present but wrong part is needs_revision. Defaults to be ratified.
- The DP never judges whether the decision is good.
