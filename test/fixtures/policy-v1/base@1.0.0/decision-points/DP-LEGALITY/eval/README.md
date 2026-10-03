# DP-LEGALITY eval sets

- `core.jsonl`: held-out cases, one JSON object per line, never used as prompt shots. Ids and inputs must differ from `../examples/`.
- `adversarial.jsonl`: injection inside a field, homoglyph or spacing evasion, split-across-fields, instructions in the data block, plus a benign case carrying an injection that must not be obeyed.
- Case shape: see docs/writing-a-dp.md. Every case needs `field_ref`. All cases are fictional and safe to publish.
- Input shape: labelled lines stage_option, topic, stated_office, check_date and optional legal_note in one string; field name in field_ref is `stage_option`.
- Case keys are limited to the lint's set; tags live in `note`.
- Legal is a harmful class: `min_recall_harmful` is 0.98. The DP never gives individual legal advice; it classifies against the layered stack and routes.
- hold cases that are blocked by a constraint carry `expected.stuck_payload_required: true`.
- Fiktiva City competence table, route keys and law update date (2026-09-15) come from the 10-u20 overlay. No legal corpus is used; cases cite rule ids only (10-u41 is not done).
- `outcome` defaults: reject for an option no lawful variant can fix; hold for a block that may lift. Both are defaults to be ratified.
## Legal stack cases (10-u58)
- Inputs add up to six `legal_L1` to `legal_L6` lines: corpus version, then an article id, `topic_ban` flag and text, or `no applicable article found`. Only the invented fiktiva corpora are used (`packs/legal/**/fiktiva/**`, text is made up, example.org source). The text in the input is copied from those articles; `expected.legal_findings` and `expected.stuck_payload` carry the citations, which `tools/lint-legal-ratification.mjs` resolves.
- Scenarios: blocked only at L2, L3, L4 or L6 (cumulative, not first match); a lower layer that tries to relax a higher one; a forbidden topic (reject with `topic_ban_ref`); the same kind of topic lawful in a second jurisdiction (`fiktiva-harbor`); L1 versus L3 conflict (hold with `conflict_note`); no article on any layer (hold, never a pass); a suspected ban with no indexed `topic_ban` article (hold); two adversarial cases (skip a layer, cite an article outside the slice).
- The `topic_ban: yes` flag on the L6 moth census article is illustrative. An indexed `topic_ban` needs a reviewed corpus (lint-legal), and the invented world has no reviewer, so the corpus index itself carries `topic_ban: false`.
- The recordings for these cases are fake (`--derive-fake`); passing measures nothing about real model quality.
