import { createEvent } from './event.js';
import { newId } from './ids.js';
import { PROTOCOL_VERSION } from './protocol.js';

const V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('domain', () => {
  it('newId is a UUIDv7', () => {
    expect(newId()).toMatch(V7);
  });

  it('createEvent fills defaults', () => {
    const e = createEvent({
      objectId: newId(),
      objectType: 'problem',
      eventType: 'problem.created',
      originNodeId: 'n1',
    });
    expect(e.id).toMatch(V7);
    expect(e.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(e.actor).toBeNull();
    expect(e.prevHash).toBeNull();
    expect(e.payload).toEqual({});
    expect(e.occurredAt).toBeInstanceOf(Date);
  });

  it('createEvent keeps supplied values', () => {
    const e = createEvent({
      objectId: 'o',
      objectType: 't',
      eventType: 'x',
      originNodeId: 'n',
      actor: 'a',
      prevHash: 'h',
      payload: { k: 1 },
    });
    expect(e).toMatchObject({ actor: 'a', prevHash: 'h', payload: { k: 1 } });
  });
});
