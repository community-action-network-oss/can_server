import { describe, expect, it } from 'vitest';
import { canMove, mayManage, mayVerify, PATCHABLE } from './task-rules.js';

describe('task rules', () => {
  it('moves forward only; done and dropped are final; open needs a claim first', () => {
    expect(canMove('claimed', 'in_progress')).toBe(true);
    expect(canMove('in_progress', 'done')).toBe(true);
    expect(canMove('open', 'done')).toBe(false);
    expect(canMove('open', 'dropped')).toBe(true);
    expect(canMove('done', 'dropped')).toBe(false);
    expect(canMove('dropped', 'in_progress')).toBe(false);
    expect(PATCHABLE).not.toContain('claimed');
  });
  it('manage: assignee, poster or steward; verify: never the doer', () => {
    const w = {
      accountId: 'a',
      isSteward: false,
      isPoster: false,
      assigneeId: 'b',
    };
    expect(mayManage(w)).toBe(false);
    expect(mayManage({ ...w, assigneeId: 'a' })).toBe(true);
    expect(mayManage({ ...w, isPoster: true })).toBe(true);
    expect(mayVerify({ ...w, assigneeId: 'a' })).toBe(false);
    expect(mayVerify(w)).toBe(true);
  });
});
