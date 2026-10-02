import { describe, expect, it } from 'vitest';
import { assertEscalationAllowed, isTerminalForState } from './outcome.js';

describe('outcome', () => {
  it('limits escalate_human to DP-CRISIS and DP-LEGAL', () => {
    assertEscalationAllowed('DP-CRISIS', 'escalate_human');
    assertEscalationAllowed('DP-LEGAL', 'escalate_human');
    expect(() =>
      assertEscalationAllowed('DP-TONE', 'escalate_human'),
    ).toThrow();
    assertEscalationAllowed('DP-TONE', 'reject');
  });
  it('hold is not terminal', () => {
    expect(isTerminalForState('hold')).toBe(false);
    expect(isTerminalForState('publish')).toBe(true);
  });
});
