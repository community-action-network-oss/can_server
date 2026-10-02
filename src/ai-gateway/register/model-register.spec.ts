import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REGISTER,
  loadRegister,
  parseRegister,
} from './model-register.js';

const live = {
  ...DEFAULT_REGISTER[0],
  id: 'openrouter:m',
  provider: 'openrouter',
  free: false,
  costPerMtok: { in: 1, out: 2 },
  evalExpiry: '2027-01-01',
};

describe('model register', () => {
  it('default lists only fake-1 and loads when the default file is absent', () => {
    expect(loadRegister('config/model-register.json').map((e) => e.id)).toEqual(
      ['fake-1'],
    );
  });
  it('an explicit missing path is an error', () => {
    expect(() => loadRegister('nope.json')).toThrow(/invalid_register/);
  });
  it('accepts a valid live entry', () => {
    expect(parseRegister([...DEFAULT_REGISTER, live])).toHaveLength(2);
  });
  it.each([
    [[]],
    [[{ ...live, id: '' }]],
    [[live, live]],
    [[{ ...live, provider: 'x' }]],
    [[{ ...live, free: true }]],
    [[{ ...live, maxInput: 0 }]],
    [[{ ...live, dataCollection: 'maybe' }]],
    [[{ ...live, evalExpiry: null }]],
    [[{ ...live, costPerMtok: { in: -1, out: 0 } }]],
  ])('rejects %j', (r) => {
    expect(() => parseRegister(r)).toThrow(/invalid_register/);
  });
});
