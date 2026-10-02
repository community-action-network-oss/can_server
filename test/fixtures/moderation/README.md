# Moderation fixture packs (plan 09)

Built at test time by `test/support/moderation-fixtures.ts` from the committed `test/fixtures/policy-v1` export. Nothing here is policy content. Select packs only through `moderationFixtures()`.

- **v1**: `base`, `constitution`, `fiktiva-city` at 1.0.0 (a ratified copy of policy-v1, pinned hashes).
- **v2**: the same three packs at 1.1.0, with these FIXTURE-ONLY edits:
  - `base` `decision-points/DP-NAMING/pack-section.yaml` and `eval/thresholds.yaml`: `publish` confidence floor 0.90 to 0.85.
  - `base` `decision-points/DP-NAMING/examples/cases.json`: one added case `ex-NAME-FIXTURE-V2`.
  - `pack.yaml` version and parent refs bumped; manifests and ratifications regenerated.

## The flipping input

`mod-fixture-flip-01` (DP-NAMING, a ward clerk office alias). FakeModel returns `publish` at confidence 0.88. Under v1 the floor is 0.90 so the gated outcome is `hold`; under v2 the floor is 0.85 so it is `publish`. No other fixture input crosses a floor.

## Known gaps in policy-v1 (resync pending)

DP-RERESOLUTION is not in the committed export. The export carries no `prompt.alt.md`; appeal runs use the separate DP-APPEAL section.
