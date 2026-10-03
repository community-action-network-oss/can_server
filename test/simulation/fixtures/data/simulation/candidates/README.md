# Labeled example candidates

Files: `simulation/candidates/<run_id>/<id>.json`, format in `schemas/candidate.schema.json`. Data only: nothing here changes policy.

## Lifecycle
1. A simulation miss (false publish, false reject, injection success, leak, poor hint, fail open) becomes a `candidate`.
2. An auditor-labeler confirms it (randomized, context-masked label task): `status: confirmed` plus `confirmed_by_label_task`. Otherwise `rejected`.
3. A policy PR (issue template `policy-pr-draft`) moves a confirmed case into `decision-points/<DP>/eval/regression.jsonl` or `adversarial.jsonl`, or into an example. The row `id` equals the candidate id and provenance is `simulation`. CI gates apply: eval, replay, protected-core refusal.
4. A fixed case can only be retired by its own ratified PR.

A candidate is never a ratified example and never enters `decision-points/**` directly.

## Rules
- No personal data: inputs derive from synthetic seeds and personas. Free text may not contain `@`, `://`, `www.`, `http`, or a run of 7 or more digits.
- Planted attack data (for example `adv-doxx`) is referenced by `attack_ref.row_id`, never copied; lint fails if the input contains a payload or canary of the referenced persona.
- `rule_ids` must be in the DP's `enforces`; jurisdictions are `fiktiva-*` or seed jurisdictions.
- `recording_kind: fake` (all recordings tonight) forces `satisfies_graduation: false`; a fake-derived candidate never counts towards graduation (`simulation/thresholds.yaml` `fake_recordings_satisfy: false`).
