# Moderation schema notes (09-u03)

- `moderation_run`: one immutable row per run (runtime.md "Run record"). No raw text: `outputs` holds offsets and codes. Only `public_explanation` and `revision_hint` are text, output-gated by a later unit.
- Idempotency: unique `(target_id, target_version, dp_id, policy_version, trigger)` where `shadow = false`.
- `can_app_rw` may INSERT and UPDATE only `status` and `held_reason` (column grant); DELETE is revoked.
- `moderation_decision` stays insert-only. Added `run_id` (fk), `dp_id`, `confidence`, `model_id`, `prompt_hash`, `transitional` (replaces `interim`, which is kept so old rows stay untouched), `superseded_by` (only settable at insert).
- Legacy outcomes `published`, `rejected` stay valid; the six AI outcomes are added. Any outcome other than `needs_revision`, `published`, `rejected` needs a `run_id`. MOD-EXPLAIN-1 field_ref/hint applies to `needs_revision`, `reject`, `rejected`.
- `escalate_human` only for DP-CRISIS and DP-LEGAL, on runs and decisions.
- `MailDecisionNotifier` reads `appealable_until` from the newest decision row; unchanged.
- The human queue and decision routes from 03-u09 no longer exist (asserted 404 in `test/moderation-read.e2e-spec.ts`).
