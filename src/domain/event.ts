import { newId } from './ids.js';
import { PROTOCOL_VERSION } from './protocol.js';

export interface DomainEvent {
  id: string;
  objectId: string;
  objectType: string;
  eventType: string;
  originNodeId: string;
  actor: string | null;
  occurredAt: Date;
  protocolVersion: string;
  payload: Record<string, unknown>;
  prevHash: string | null;
}

export type NewEventInput = Pick<
  DomainEvent,
  'objectId' | 'objectType' | 'eventType' | 'originNodeId'
> &
  Partial<Pick<DomainEvent, 'actor' | 'payload' | 'prevHash' | 'occurredAt'>>;

export function createEvent(input: NewEventInput): DomainEvent {
  return {
    id: newId(),
    objectId: input.objectId,
    objectType: input.objectType,
    eventType: input.eventType,
    originNodeId: input.originNodeId,
    actor: input.actor ?? null,
    occurredAt: input.occurredAt ?? new Date(),
    protocolVersion: PROTOCOL_VERSION,
    payload: input.payload ?? {},
    prevHash: input.prevHash ?? null,
  };
}
