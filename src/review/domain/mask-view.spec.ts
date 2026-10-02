import { describe, expect, it } from 'vitest';
import { applyMasked, collectStrings } from './mask-view.js';

describe('mask-view', () => {
  const v = { a: 'x', b: ['y', { c: 'z' }], n: 3, e: '' };
  it('collects pointers and applies a mask, dropping unreturned leaves', () => {
    const f = collectStrings(v, '/content');
    expect(f.map((x) => x.fieldRef)).toEqual([
      '/content/a',
      '/content/b/0',
      '/content/b/1/c',
    ]);
    const m = new Map(f.map((x) => [x.fieldRef, x.text.toUpperCase()]));
    expect(applyMasked(v, '/content', m)).toEqual({
      a: 'X',
      b: ['Y', { c: 'Z' }],
      n: 3,
      e: '',
    });
    expect(applyMasked(v, '/content', new Map()).a).toBe('');
  });
});
