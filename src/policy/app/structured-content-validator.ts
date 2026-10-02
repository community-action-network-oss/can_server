import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from 'ajv/dist/2020.js';

export interface Violation {
  pointer: string;
  message: string;
}

/** Fixed wording per keyword: never echoes schema parameters, so no limit value leaks. */
const WORDS: Record<string, string> = {
  required: 'This is required.',
  type: 'This has the wrong type.',
  enum: 'This is not an allowed choice.',
  const: 'This is not an allowed choice.',
  maxLength: 'This is too long.',
  minLength: 'This is too short.',
  maxItems: 'There are too many items.',
  minItems: 'There are too few items.',
  pattern: 'This is not in the expected shape.',
  additionalProperties: 'This field is not part of the form.',
};
/** Draft saves are partial, so only completeness-shaped keywords are skipped. */
const SKIPPED_IN_DRAFT = new Set(['required', 'oneOf', 'anyOf', 'if']);
// top-level version/pack (no-op keywords) are can_policy pack metadata, not validation
const KEYWORDS = [
  'x-ui',
  'x-guidance',
  'x-checks',
  'x-version',
  'version',
  'pack',
];

const esc = (s: string) => s.replaceAll('~', '~0').replaceAll('/', '~1');
const pointer = (e: ErrorObject) => {
  const p = e.params as Record<string, string>;
  if (e.keyword === 'required')
    return `${e.instancePath}/${esc(p.missingProperty)}`;
  if (e.keyword === 'additionalProperties')
    return `${e.instancePath}/${esc(p.additionalProperty)}`;
  return e.instancePath;
};

export class StructuredContentValidator {
  private readonly cache = new Map<string, ValidateFunction>();

  /** Compiled schemas are cached by schema hash. One Ajv per schema, so two versions sharing an $id never collide. */
  private compile(hash: string, schema: Record<string, unknown>) {
    let v = this.cache.get(hash);
    if (!v) {
      // strictTypes off: real can_policy if/then branches say `required`/`minItems` without a type; unknown keywords stay rejected
      const ajv = new Ajv2020({
        strict: true,
        strictTypes: false,
        allErrors: true,
      });
      for (const keyword of KEYWORDS) ajv.addKeyword({ keyword }); // annotations: no-ops
      // legacy top-level `id` is rejected by Ajv; the policy store already keys by name, so drop it
      const { id: _id, ...rest } = schema;
      v = ajv.compile(rest);
      this.cache.set(hash, v);
    }
    return v;
  }

  validate(
    hash: string,
    schema: Record<string, unknown>,
    body: unknown,
    mode: 'draft' | 'submit' = 'submit',
  ): Violation[] {
    const fn = this.compile(hash, schema);
    if (fn(body)) return [];
    const out = new Map<string, Violation>();
    for (const e of fn.errors ?? []) {
      if (mode === 'draft' && SKIPPED_IN_DRAFT.has(e.keyword)) continue;
      const p = pointer(e);
      if (!out.has(p))
        out.set(p, {
          pointer: p,
          message: WORDS[e.keyword] ?? 'This is not valid.',
        });
    }
    return [...out.values()];
  }
}
