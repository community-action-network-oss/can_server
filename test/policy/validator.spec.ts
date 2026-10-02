import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StructuredContentValidator } from '../../src/policy/app/structured-content-validator.js';
import { FIXTURE_DIR } from './helpers.js';

const base = JSON.parse(
  readFileSync(
    join(FIXTURE_DIR, 'base@0.0.1/content-schemas/problem/schema.json'),
    'utf8',
  ),
);
const v110 = {
  ...base,
  'x-version': '1.1.0',
  $comment: 'adds a required field',
  required: [...base.required, 'extra'],
  properties: { ...base.properties, extra: { type: 'string', maxLength: 5 } },
};
const ok = {
  title: 'Unlit crossing',
  structural_statement: 'Lights go unrepaired.',
  scope: 'street',
  assumptions: 'None.',
};
const val = new StructuredContentValidator();
const run = (b: unknown, mode?: 'draft' | 'submit') =>
  val.validate('h-base', base, b, mode);

describe('StructuredContentValidator', () => {
  it('accepts a valid body under strict mode with x-* keywords', () => {
    expect(run(ok)).toEqual([]);
  });
  it('reports a JSON pointer per violation', () => {
    const v = run({
      ...ok,
      title: 'x'.repeat(121),
      scope: 'planet',
      stray: 1,
    });
    expect(v.map((x) => x.pointer).sort()).toEqual([
      '/scope',
      '/stray',
      '/title',
    ]);
  });
  it('names missing fields by pointer on submit, skips them on draft', () => {
    const { assumptions: _a, ...rest } = ok;
    expect(run(rest).map((x) => x.pointer)).toEqual(['/assumptions']);
    expect(run(rest, 'draft')).toEqual([]);
    expect(run({ ...rest, scope: 'x' }, 'draft').map((x) => x.pointer)).toEqual(
      ['/scope'],
    );
  });
  it('never echoes a limit value in a message', () => {
    const msgs = run({ ...ok, title: 'x'.repeat(500) })
      .map((x) => x.message)
      .join(' ');
    expect(msgs).not.toMatch(/\d/);
  });
  it('validates by the schema it is given: valid under 1.0.0, invalid under 1.1.0', () => {
    expect(val.validate('h-110', v110, ok)).toEqual([
      { pointer: '/extra', message: 'This is required.' },
    ]);
    expect(run(ok)).toEqual([]);
  });
  it('two versions sharing an $id do not collide', () => {
    expect(() => val.validate('h-other', { ...base }, ok)).not.toThrow();
  });
  it('rejects a non-object body', () => {
    expect(run('text')[0]?.pointer).toBe('');
  });
});

describe('validator code names no content field', () => {
  it('src/policy has no problem field names', () => {
    const names =
      /\b(structural_statement|assumptions|desiredOutcome|coarseArea|condition|affected|observed|uncertain)\b/;
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((e) => {
        const p = join(d, e);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    for (const f of walk(join(process.cwd(), 'src/policy')))
      expect(readFileSync(f, 'utf8'), f).not.toMatch(names);
  });
});

describe('StructuredContentValidator against real can_policy schemas', () => {
  const dir = join(import.meta.dirname, '../../../can_policy/content-schemas');
  const present = (() => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  })();
  const maybe = present ? it : it.skip; // skipped: ../can_policy not checked out
  maybe('compiles every real content schema under strict mode', () => {
    const bad: string[] = [];
    for (const name of readdirSync(dir)) {
      try {
        const schema = JSON.parse(
          readFileSync(join(dir, name, 'schema.json'), 'utf8'),
        );
        new StructuredContentValidator().validate('real-' + name, schema, {});
      } catch (e) {
        if (!/ENOENT|ENOTDIR/.test((e as Error).message))
          bad.push(`${name}: ${(e as Error).message}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
