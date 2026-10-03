import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crisisFirst } from '../../app/crisis-first.js';
import { detectCrisis, detectLegalProcess } from './detect.js';
import { FALLBACK_CRISIS_NOTICE, staticCrisisResources } from './resources.js';

const fx = JSON.parse(
  readFileSync('test/fixtures/moderation/crisis/cases.json', 'utf8'),
) as {
  crisis: { id: string; text: string; level: string }[];
  legal: { id: string; text: string; hit: boolean }[];
};
const f = (text: string) => [{ ref: '/statement', text }];

describe('detectCrisis fixtures', () => {
  for (const c of fx.crisis)
    it(c.id, () => {
      expect(detectCrisis(f(c.text), 'en').level).toBe(c.level);
    });
  it('unknown language still runs every lexicon', () => {
    expect(detectCrisis(f('Ik ga mezelf doden'), 'xx').level).toBe('imminent');
  });
  it('pack terms extend the lexicon', () => {
    const extra = [
      {
        category: 'distress' as const,
        level: 'clear' as const,
        phrases: ['zork'],
      },
    ];
    expect(detectCrisis(f('zork'), 'en', extra).level).toBe('clear');
  });
  it('spans carry offsets and refs, not text', () => {
    const r = detectCrisis(f('I want to die'), 'en');
    expect(Object.keys(r.spans[0]!).sort()).toEqual([
      'category',
      'end',
      'ref',
      'start',
    ]);
  });
});

describe('detectLegalProcess fixtures', () => {
  for (const c of fx.legal)
    it(c.id, () => expect(detectLegalProcess(f(c.text)).hit).toBe(c.hit));
});

describe('crisisFirst', () => {
  it('imminent: resources, hold, lane, escalate', () => {
    expect(
      crisisFirst({ fields: f('going to kill myself tonight') }),
    ).toMatchObject({
      route: 'static_resources',
      hold: true,
      lane: true,
      crisis: 'escalate_human',
    });
  });
  it('clear: route_external and hold, no lane', () => {
    expect(crisisFirst({ fields: f('I want to die') })).toMatchObject({
      route: 'static_resources',
      hold: true,
      lane: false,
      crisis: 'route_external',
    });
  });
  it('possible: hold, no resources, no lane', () => {
    expect(crisisFirst({ fields: f('I feel hopeless') })).toMatchObject({
      route: 'none',
      hold: true,
      lane: false,
      crisis: 'hold',
    });
  });
  it('none: no hold from this layer, and never a publish outcome', () => {
    const r = crisisFirst({ fields: f('The bus stop has no shelter') });
    expect(r).toMatchObject({
      route: 'none',
      hold: false,
      lane: false,
      crisis: null,
      legal: null,
    });
  });
  it('legal process: lane and escalate, no resources', () => {
    expect(crisisFirst({ fields: f('a court order arrived') })).toMatchObject({
      route: 'none',
      hold: true,
      lane: true,
      legal: 'escalate_human',
    });
  });
  it('any error gives static resources and hold', () => {
    const bad = { fields: null } as unknown as Parameters<
      typeof crisisFirst
    >[0];
    expect(crisisFirst(bad)).toMatchObject({
      route: 'static_resources',
      hold: true,
      error: true,
    });
  });
  it('result carries codes only', () => {
    const s = JSON.stringify(
      crisisFirst({ fields: f('I want to die, call me on 0612345678') }),
    );
    expect(s).not.toContain('call me');
  });
});

describe('static resources', () => {
  it('uses the jurisdiction notice, else the baked fallback', () => {
    expect(staticCrisisResources.noticeFor('Call 112')).toBe('Call 112');
    for (const n of [null, undefined, '  '])
      expect(staticCrisisResources.noticeFor(n)).toBe(FALLBACK_CRISIS_NOTICE);
  });
});

describe('import graph', () => {
  const files = [
    ...readdirSync('src/moderation/domain/crisis')
      .filter((n) => n.endsWith('.ts') && !n.endsWith('.spec.ts'))
      .map((n) => join('src/moderation/domain/crisis', n)),
    'src/moderation/app/crisis-first.ts',
  ];
  it('has no model, gateway, Nest, db or legal-corpus import', () => {
    for (const file of files) {
      const imports = [
        ...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g),
      ].map((m) => m[1]!);
      for (const i of imports)
        expect(i, file).not.toMatch(
          /ai-gateway|@nestjs|drizzle|\/db\/|policy\/legal|infra/,
        );
    }
  });
});
