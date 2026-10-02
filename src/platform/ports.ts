import { newId } from '../domain/ids.js';

export interface Clock {
  now(): Date;
}
export interface IdGenerator {
  next(): string;
}

export const CLOCK = Symbol('Clock');
export const ID_GENERATOR = Symbol('IdGenerator');

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return newId();
  }
}
