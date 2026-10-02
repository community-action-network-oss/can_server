import { describe, expect, it } from 'vitest';
import { DpRegistry, RERESOLUTION_MAP } from '../../app/dp-registry.js';
import { PolicyStore } from '../../../policy/app/policy-store.js';
import { PolicyUnavailable } from '../../../policy/domain/pack.js';
import { FsPackSource } from '../../../policy/infra/fs-pack-source.js';
import { moderationFixtures } from '../../../../test/support/moderation-fixtures.ts';
import { selectDps } from './select.js';

async function registry() {
  const fx = moderationFixtures();
  const src = new FsPackSource(fx.dir);
  const store = new PolicyStore(src);
  await store.activate('default', {
    name: 'fiktiva-city',
    version: '1.0.0',
    hash: fx.v1.hash,
  });
  return { reg: new DpRegistry(store, src), store };
}

describe('DpRegistry over the committed pack', () => {
  it('reads whatever DP sections the pack carries and reports the rest as missing', async () => {
    const { reg } = await registry();
    const v = await reg.forJurisdiction('default');
    expect([...v.dps.keys()].every((k) => k.startsWith('DP-'))).toBe(true); // ASSIST-FILL is not a DP
    expect(v.dps.size + v.missing.length).toBeGreaterThanOrEqual(27);
    const naming = v.dps.get('DP-NAMING')!;
    expect(naming.mode).toBe('blocking');
    expect(naming.ruleIds).toEqual(['NAME-1']);
    expect(naming.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(naming.contentTypes).toContain('problem');
    expect(v.dps.get('DP-LEGAL')!.outcomes).not.toContain('reject');
    expect(v.missing).toContain('DP-RERESOLUTION');
    expect(v.missing).toContain('DP-PUBLISH');
    expect(v.missing).not.toContain('DP-NAMING');
    expect(v.invalid).toEqual([]);
    expect(await reg.forJurisdiction('default')).toBe(v); // cached by pack hash
  });

  it('the selector holds on a DP the pack lacks', async () => {
    const { reg } = await registry();
    const v = await reg.forJurisdiction('default');
    const r = selectDps({
      event: 'policy_changed',
      contentType: 'problem',
      packDps: new Set(v.dps.keys()),
    });
    expect(r.find((x) => x.dpId === 'DP-RERESOLUTION')!.missing).toBe(true);
    expect(r.find((x) => x.dpId === 'DP-CRISIS')!.missing).toBe(false);
  });

  it('fails closed when no pack is active', async () => {
    const empty = new DpRegistry(
      new PolicyStore(new FsPackSource(moderationFixtures().dir)),
      new FsPackSource(moderationFixtures().dir),
    );
    expect(() => empty.forJurisdiction('x')).toThrow(PolicyUnavailable);
  });

  it('maps DP-RERESOLUTION names onto shared outcomes', () => {
    expect(RERESOLUTION_MAP).toEqual({
      keep: 'publish',
      annotate: 'needs_revision',
      reopen: 'route_external',
      hold: 'hold',
    });
  });
});
