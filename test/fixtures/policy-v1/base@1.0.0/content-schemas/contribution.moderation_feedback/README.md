# contribution.moderation_feedback

Reserved type. Appeals are used in slice 1, so this schema has no fields beyond `type` and is not offered to people.

The reserved marker is `x-checks.reserved: true` with `x-checks.status: "reserved"`. The meta schema only accepts the `x-ui`, `x-guidance`, `x-checks` and `x-version` extension keys, so the marker lives under `x-checks` rather than as a top-level `x-reserved`.

The renderer treats a schema with `x-checks.reserved` as unsupported: it must not show a form for it, and the server must refuse submissions of this type.
