import { describe, expect, it } from 'vitest';
import { classMembers, runKey, triggerClass } from './run-key.js';

const base = {
  targetId: 't',
  targetVersion: 1,
  dpId: 'DP-TONE',
  policyVersion: 'p',
};
describe('runKey', () => {
  it('shares one key across blocking triggers only', () => {
    expect(runKey({ ...base, trigger: 'submit_gate' })).toBe(
      runKey({ ...base, trigger: 'publish' }),
    );
    expect(runKey({ ...base, trigger: 'appeal' })).not.toBe(
      runKey({ ...base, trigger: 'replay' }),
    );
    expect(runKey({ ...base, trigger: 'appeal' })).not.toBe(
      runKey({ ...base, trigger: 'publish' }),
    );
  });
  it('lists class members', () => {
    expect(classMembers('appeal')).toEqual(['appeal']);
    expect(classMembers('review')).toContain('submit_gate');
    expect(triggerClass('sample')).toBe('sample');
  });
});
