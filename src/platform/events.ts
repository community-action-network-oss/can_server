import { createEvent, type DomainEvent } from '../domain/event.js';
import type { Clock, IdGenerator } from './ports.js';

export interface EventDeps {
  clock: Clock;
  ids: IdGenerator;
  originNodeId: string;
}

export interface ProblemEventInput {
  problemId: string;
  type: string;
  actorId: string | null;
  from?: string | null;
  to?: string | null;
  reason?: string | null;
  payload?: Record<string, unknown>;
}

/** Problem event row: prevHash always null (hashing is slice 2, DECENT-1), protocolVersion from domain. */
export function buildProblemEvent(
  i: ProblemEventInput,
  d: EventDeps,
): DomainEvent {
  return {
    ...createEvent({
      objectId: i.problemId,
      objectType: 'problem',
      eventType: i.type,
      originNodeId: d.originNodeId,
      actor: i.actorId,
      occurredAt: d.clock.now(),
      prevHash: null,
      payload: {
        ...(i.from !== undefined && { from: i.from }),
        ...(i.to !== undefined && { to: i.to }),
        ...(i.reason !== undefined && { reason: i.reason }),
        ...i.payload,
      },
    }),
    id: d.ids.next(),
  };
}
