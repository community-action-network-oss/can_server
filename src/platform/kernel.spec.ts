import { PROTOCOL_VERSION } from '../domain/protocol.js';
import { buildProblemEvent } from './events.js';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';
import { FixedClock, SeqIds } from './testing.js';

describe('pagination', () => {
  it('round-trips cursors and rejects junk', () => {
    expect(decodeCursor(encodeCursor({ a: 1 }))).toEqual({ a: 1 });
    for (const s of ['!!', 'bm90anNvbg', encodeCursor([1] as never)])
      expect(() => decodeCursor(s)).toThrow(/cursor/i);
  });
  it('clamps limits', () => {
    expect(clampLimit(undefined)).toBe(20);
    expect(clampLimit('500')).toBe(50);
    expect(clampLimit('0')).toBe(20);
    expect(clampLimit('abc')).toBe(20);
    expect(clampLimit('7')).toBe(7);
  });
});

describe('buildProblemEvent', () => {
  it('sets prevHash null, node, protocol, clock and id', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const e = buildProblemEvent(
      {
        problemId: 'p',
        type: 'transitioned',
        actorId: 'u',
        from: 'a',
        to: 'b',
        reason: 'r',
        payload: { x: 1 },
      },
      { clock: new FixedClock(at), ids: new SeqIds(), originNodeId: 'n1' },
    );
    expect(e).toMatchObject({
      prevHash: null,
      originNodeId: 'n1',
      protocolVersion: PROTOCOL_VERSION,
      occurredAt: at,
      objectType: 'problem',
      payload: { from: 'a', to: 'b', reason: 'r', x: 1 },
    });
    expect(e.id).toMatch(/0001$/);
  });
});
