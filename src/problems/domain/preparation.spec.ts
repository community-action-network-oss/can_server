import { describe, expect, it } from 'vitest';
import { changedPaths, partOf, planErrors } from './preparation.js';

describe('preparation', () => {
  it('sorts pointers into readiness parts', () => {
    expect(partOf('/sources/0/uri')).toBe('sources');
    expect(partOf('/final_acceptance_criteria')).toBe('criteria');
    expect(partOf('/stage_plan/2/depends_on')).toBe('stages');
    expect(partOf('/stage_planning')).toBe('facts');
    expect(partOf('title')).toBe('facts');
  });
  it('lists the recommendation paths that changed', () => {
    const node = (name: string, c: string) => ({
      name,
      acceptance_criteria: [{ statement: c }],
    });
    expect(
      changedPaths({ scope: 'a', place: 1 }, { scope: 'b', place: 1 }),
    ).toEqual(['scope']);
    expect(
      changedPaths(
        { stage_plan: [node('a', 'x'), node('b', 'y')] },
        { stage_plan: [node('a', 'x'), node('b', 'z')] },
      ),
    ).toEqual(['stage_plan', 'stage_plan.b', 'stage_plan.b.criteria']);
  });
  it('points plan issues at the stage index', () => {
    const nodes = [{ name: 'a' }, { name: 'b' }];
    expect(
      planErrors(
        [{ code: 'dangling_edge', stageId: 'b', missing: 'z' }],
        nodes,
      ),
    ).toEqual({
      '/stage_plan/1/depends_on': expect.any(String),
    });
  });
});
