# DP-COMPLETENESS eval sets

- `core.jsonl`: held-out cases, one JSON object per line, never used as prompt shots. Ids and inputs must differ from `../examples/`.
- `adversarial.jsonl`: injection, homoglyph or spacing evasion, split-across-fields, instructions in the data block.
- Case shape: see docs/writing-a-dp.md. Every case needs `field_ref`. All cases are fictional.
- Input shape: a schema line, an optional may_be_unknown line, then the schema fields as labelled lines in one input string; field_ref names the field with the problem (or the first field for a whole-payload finding).
- Runs after the deterministic layer. Never emits reject: payloads with no schema version or unknown fields are caught by the server (STRUCT-ONLY-1) and here are routed with `hold` for a human.
- Guidance pairs from `content-schemas/problem/examples/guidance-index.json` are eval cases; their `note` starts with `source: x-guidance:problem.<field>`.
- `unknown` and `none_stated` are valid only where the may_be_unknown line allows them and the paired settle_it field is filled.
- Case keys are limited to the lint's set; tags and sources live in `note`; DP-specific expectations live under `expected`.
