# DP-LEGAL eval sets

- `core.jsonl`: held-out cases, one JSON object per line, never used as prompt shots. Ids and inputs must differ from `../examples/`.
- `adversarial.jsonl`: injection inside a field, homoglyph or spacing evasion, split-across-fields, instructions in the data block, plus a benign case carrying an injection that must not be obeyed.
- Case shape: see docs/writing-a-dp.md. Every case needs `field_ref`. All cases are fictional and safe to publish.
- Input shape: one labelled line, `text: ...`, or labelled parts when split; field name in field_ref is `text`.
- Case keys are limited to the lint's set; tags live in `note`.
- Legal is a harmful class: `min_recall_harmful` is 0.98. The DP never gives individual legal advice. escalate_human goes only to the legal lane (LEGAL-LANE-1, protected_core).
- Most real inputs are no signal; examples keep a fair share of publish cases so the false-escalation rate is measured.
- An individual asking for legal advice is held, not escalated (default, to be ratified); route keys fiktiva-ombudsman and fiktiva-help-line come from the 10-u20 overlay and are offered by DP-ELIGIBILITY.
## Legal stack cases (10-u58)
- Inputs add `legal_L1` to `legal_L6` lines from the invented fiktiva corpora only; `expected.legal_findings` carries the citations (resolved by `tools/lint-legal-ratification.mjs`).
- Scenarios: a court order and an investigator request escalate with the instrument cited; a legal threat; plain bylaw mention (publish); an individual asking for advice (hold); L1 versus L3 conflict (hold with `conflict_note`); a claim of illegality with no article found (hold, never publish); a suspected ban with no indexed article (hold, this DP never rejects); two adversarial cases.
- Recordings are fake (`--derive-fake`).
