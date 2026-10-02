# _common

Shared pieces for content schemas. Not a content type.

`schema.json` holds `$defs.contribution_common`: target, claim, basis, evidence_refs, uncertainty and assumptions, shared by every `contribution.<type>` schema.

The fragment is inlined, not referenced: the pack tooling compiles each schema on its own, so a relative `$ref` would not resolve. Each type schema carries an identical copy of these properties. `test/schema-contribution-a.test.mjs` fails if a copy drifts from this file, so edit here first and copy the change into each type.

Message ids use the `schema.contribution.common.` prefix. Every type's `messages.en.json` repeats those ids.
