import { describe, expect, it } from 'vitest';
import { protectedHits } from './protected-core.js';
import { REPLAY_REPORT_SCHEMA } from './replay-report.schema.js';
import {
  STAGES,
  TRANSITIONS,
  blockedTarget,
  canTransition,
  panelStatus,
} from './stages.js';
import { readFileSync } from 'node:fs';

describe('stage transition table', () => {
  const legal = [
    'submitted>eval',
    'submitted>rejected',
    'submitted>withdrawn',
    'eval>replay',
    'eval>rejected',
    'eval>withdrawn',
    'replay>eval',
    'replay>ratification',
    'replay>rejected',
    'replay>withdrawn',
    'ratification>eval',
    'ratification>replay',
    'ratification>shadow',
    'ratification>rejected',
    'ratification>withdrawn',
    'shadow>canary',
    'shadow>rejected',
    'canary>full',
    'canary>shadow',
    'canary>rejected',
  ];
  it.each(STAGES.flatMap((a) => STAGES.map((b) => [a, b] as const)))(
    '%s -> %s',
    (a, b) => {
      expect(canTransition(a, b)).toBe(legal.includes(`${a}>${b}`));
    },
  );
  it('terminal stages and self moves have no edges', () => {
    for (const s of ['full', 'rejected', 'withdrawn'] as const)
      expect(TRANSITIONS[s]).toEqual([]);
    for (const s of STAGES) expect(canTransition(s, s)).toBe(false);
  });
  it('a blocked report targets its own stage unless already there', () => {
    expect(blockedTarget('eval', 'ratification')).toBe('eval');
    expect(blockedTarget('replay', 'replay')).toBeNull();
  });
  it('panel status keys', () => {
    expect(panelStatus('ratification')).toBe('waiting_for_panel');
    expect(panelStatus('canary')).toBe('ratified');
    expect(panelStatus('withdrawn')).toBe('closed');
    expect(panelStatus('eval')).toBe('not_started');
  });
});

describe('protected core and report schema copy', () => {
  it('finds hits once, sorted', () => {
    expect(protectedHits(['B-1', 'A-1', 'A-1', 'C-1'], ['A-1', 'B-1'])).toEqual(
      ['A-1', 'B-1'],
    );
    expect(protectedHits(['X-1'], ['A-1'])).toEqual([]);
  });
  it('the embedded replay schema equals the fixture copy', () => {
    const f = JSON.parse(
      readFileSync(
        'test/fixtures/policy-proposals/replay-report.schema.json',
        'utf8',
      ),
    );
    expect(REPLAY_REPORT_SCHEMA).toEqual(f);
  });
});
