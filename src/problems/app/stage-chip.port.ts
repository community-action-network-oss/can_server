import type { ActiveStages } from '../../domain/lifecycle/vocabulary.js';

/** Stage chip data for active problems. The real one arrives with 12-u02; until then the label stays plain. */
export interface StageChipPort {
  chips(problemIds: string[]): Promise<Map<string, ActiveStages>>;
}
export const STAGE_CHIP = Symbol('StageChipPort');

export class NullStageChips implements StageChipPort {
  async chips(): Promise<Map<string, ActiveStages>> {
    return new Map();
  }
}
