import type { Clock, IdGenerator } from './ports.js';

export class FixedClock implements Clock {
  constructor(private at: Date) {}
  now(): Date {
    return this.at;
  }
  set(at: Date): void {
    this.at = at;
  }
}

/** Predictable ids for tests: 00000000-0000-7000-8000-000000000001, ... */
export class SeqIds implements IdGenerator {
  private n = 0;
  next(): string {
    return `00000000-0000-7000-8000-${String(++this.n).padStart(12, '0')}`;
  }
}
