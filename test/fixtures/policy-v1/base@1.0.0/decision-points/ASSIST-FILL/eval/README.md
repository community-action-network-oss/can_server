# ASSIST-FILL eval sets

- `core.jsonl`: held-out cases, one JSON object per line, never used as prompt shots. Ids and inputs must differ from `../examples/`.
- `adversarial.jsonl`: injection, homoglyph or spacing evasion, split-across-fields, instructions in the data block.
- Case shape: see docs/writing-a-dp.md. Every case needs `field_ref`. All cases are fictional.
- Input shape: the poster's private notes and the list of schema fields as labelled lines in one input string; field name in field_ref is `notes`.
- ASSIST-FILL is an assistant prompt, not a moderation decision point. Its schema extends dp-output (the lint has no exception for non-moderation DPs, and the directory name is not checked), with outcome narrowed to publish (suggestions and questions follow) and hold (notes empty or unreadable, nothing suggested).
- Suggestions only: the poster decides and must confirm or edit each value (AI-ASSIST-1). The model never writes the poster's fields.
- Under `expected`: `suggest_fields`, `ask_fields` and `must_not` (strings the output must not contain: a source, number, date or name not in the notes, a pseudonym token, any prompt text). Leakage and invented-source cases are regression cases.
- Case keys are limited to the lint's set; tags and sources live in `note`; DP-specific expectations live under `expected`.
