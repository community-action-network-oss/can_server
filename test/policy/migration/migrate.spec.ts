import { describe, expect, it } from 'vitest';
import {
  applyMap,
  classifyBump,
  mappingKey,
  parseMap,
  type MigrationMap,
} from '../../../src/policy/migration/migrate.js';

const map = (
  fields: MigrationMap['fields'],
  rest: Partial<MigrationMap> = {},
) =>
  ({
    type: 'problem',
    from: '1.1.0',
    to: '2.0.0',
    fields,
    new_required: [],
    dropped: [],
    ...rest,
  }) as MigrationMap;
const f = (
  from_path: string,
  to_path: string,
  transform: 'copy' | 'split' | 'merge' | 'drop',
) => ({
  from_path,
  to_path,
  transform,
  note: '',
});

describe('classifyBump', () => {
  it.each([
    ['1.0.0', '1.0.0', 'none'],
    ['1.0.0', '1.0.1', 'patch'],
    ['1.0.9', '1.1.0', 'minor'],
    ['1.9.9', '2.0.0', 'major'],
    ['2.0.0', '1.9.0', 'rollback'],
    ['1.2.0', '1.1.9', 'rollback'],
  ])('%s to %s is %s', (a, b, want) => expect(classifyBump(a, b)).toBe(want));
  it('rejects a version that is not semver', () =>
    expect(() => classifyBump('1.0', '2.0.0')).toThrow());
});

describe('applyMap', () => {
  it('copy moves a value on its own and carries untouched answers', () => {
    const r = applyMap(
      { a: 'x', keep: 'k' },
      map([f('a', 'b', 'copy')]),
      new Set(),
    );
    expect(r.content).toEqual({ b: 'x', keep: 'k' });
    expect(r.mapping[0]).toMatchObject({
      carried_value: 'x',
      needs_confirmation: false,
    });
  });

  it('split copies one answer to every target once confirmed', () => {
    const m = map([f('a', 'b', 'split'), f('a', 'c', 'split')]);
    expect(
      applyMap({ a: 'x' }, m, new Set([mappingKey(m.fields[0])])).content,
    ).toEqual({ b: 'x' });
    expect(applyMap({ a: 'x' }, m, null).content).toEqual({ b: 'x', c: 'x' });
  });

  it('merge joins confirmed sources in order', () => {
    const m = map([f('a', 'z', 'merge'), f('b', 'z', 'merge')]);
    expect(applyMap({ a: 'one', b: 'two' }, m, null).content).toEqual({
      z: 'one\ntwo',
    });
    expect(
      applyMap({ a: 'one', b: 'two' }, m, new Set([mappingKey(m.fields[1])]))
        .content,
    ).toEqual({ z: 'two' });
  });

  it('drop never writes, and the lost answer is shown', () => {
    const r = applyMap(
      { a: 'x' },
      map([f('a', '', 'drop')], { dropped: ['a'] }),
      null,
    );
    expect(r.content).toEqual({});
    expect(r.dropped).toEqual(['a']);
    expect(r.mapping[0]).toMatchObject({
      carried_value: 'x',
      needs_confirmation: true,
    });
  });

  it('reports a newly required field as new_required until something fills it', () => {
    const m = map([f('a', 'b', 'copy')], { new_required: ['b', 'c'] });
    expect(applyMap({ a: 'x' }, m, null).new_required).toEqual(['c']);
    expect(applyMap({}, m, null).new_required).toEqual(['b', 'c']);
  });

  it('drops answers the target schema no longer has, and says so', () => {
    const r = applyMap({ a: 'x', old: 'y' }, map([f('a', 'b', 'copy')]), null, [
      'b',
    ]);
    expect(r.content).toEqual({ b: 'x' });
    expect(r.dropped).toEqual(['old']);
  });

  it('supports nested paths and refuses prototype keys', () => {
    expect(
      applyMap({ a: { b: 1 } }, map([f('a.b', '/c/d', 'copy')]), null).content,
    ).toEqual({ c: { d: 1 } });
    expect(() =>
      applyMap({}, map([f('__proto__.x', 'y', 'copy')]), null),
    ).toThrow();
  });
});

describe('parseMap', () => {
  const ok = JSON.stringify(map([f('a', 'b', 'copy')]));
  it('accepts a map for exactly this step', () =>
    expect(parseMap(ok, 'problem', '1.1.0', '2.0.0')?.fields).toHaveLength(1));
  it('accepts the transforms spelling', () =>
    expect(
      parseMap(
        ok.replace('"fields"', '"transforms"'),
        'problem',
        '1.1.0',
        '2.0.0',
      ),
    ).not.toBeNull());
  it('refuses a map for another step, bad json or a bad path', () => {
    expect(parseMap(ok, 'problem', '1.0.0', '2.0.0')).toBeNull();
    expect(parseMap('{', 'problem', '1.1.0', '2.0.0')).toBeNull();
    expect(
      parseMap(
        JSON.stringify(map([f('a', '__proto__', 'copy')])),
        'problem',
        '1.1.0',
        '2.0.0',
      ),
    ).toBeNull();
  });
});
