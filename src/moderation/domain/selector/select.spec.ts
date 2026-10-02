import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DP_IDS } from '../outcome.js';
import {
  CONTENT_TYPES,
  EVENT_KINDS,
  type ContentType,
  type EventKind,
} from './events.js';
import { selectDps, type SelectedDp } from './select.js';
import { SELECTOR_TABLE } from './table.js';

const ALL_PACK = new Set<string>(DP_IDS);
const sel = (
  event: EventKind,
  contentType: ContentType,
  o: Partial<Parameters<typeof selectDps>[0]> = {},
): SelectedDp[] => selectDps({ event, contentType, packDps: ALL_PACK, ...o });
const ids = (r: SelectedDp[]) => r.map((x) => x.dpId).sort();

interface Case {
  name: string;
  input: Parameters<typeof sel>[2] & {
    event: EventKind;
    contentType: ContentType;
  };
  expect: string[];
}
const { cases } = JSON.parse(
  readFileSync('test/fixtures/moderation/selector-table.json', 'utf8'),
) as { cases: Case[] };

describe('selector table cases', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    expect(ids(sel(c.input.event, c.input.contentType, c.input))).toEqual(
      c.expect,
    );
  });
});

describe('selector rules', () => {
  it('runs crisis and legal first', () => {
    const r = sel('review_requested', 'problem');
    expect(r.slice(0, 2).map((x) => x.dpId)).toEqual(['DP-CRISIS', 'DP-LEGAL']);
    expect(r[0].priorityClass).toBe('crisis');
  });

  it('narrows fields to the diff and marks reusable ones only when the policy version is unchanged', () => {
    const fr = (v: boolean) =>
      sel('edited', 'problem', {
        changedFields: ['scope'],
        policyVersionUnchanged: v,
      }).find((x) => x.dpId === 'DP-FRAMING')!;
    expect(fr(true).fields).toEqual(['scope']);
    expect(fr(true).reusePrior).toContain('condition');
    expect(fr(true).reusePrior).not.toContain('scope');
    expect(fr(false).reusePrior).toEqual([]);
  });

  it('a missing DP is surfaced, never skipped', () => {
    const pack = new Set(ALL_PACK);
    pack.delete('DP-PRIVACY');
    const r = sel('review_requested', 'problem', { packDps: pack });
    expect(r.find((x) => x.dpId === 'DP-PRIVACY')?.missing).toBe(true);
    expect(r.filter((x) => x.missing)).toHaveLength(1);
  });

  it('a private draft edit is advisory except crisis and legal', () => {
    const r = sel('edited', 'problem', {
      state: 'draft',
      changedFields: ['condition'],
    });
    for (const x of r)
      expect(x.mode).toBe(
        x.dpId === 'DP-CRISIS' || x.dpId === 'DP-LEGAL' ? 'blocking' : 'async',
      );
  });

  it('classes: edit is update, policy change is async, sampling is sample', () => {
    expect(
      sel('edited', 'problem').find((x) => x.dpId === 'DP-FRAMING')!
        .priorityClass,
    ).toBe('update');
    expect(
      sel('policy_changed', 'problem').find((x) => x.dpId === 'DP-FRAMING')!
        .priorityClass,
    ).toBe('async');
    expect(
      sel('sample_tick', 'contribution').every(
        (x) => x.priorityClass === 'sample',
      ),
    ).toBe(true);
  });

  it('DP-PUBLISH only on publication_requested', () => {
    for (const e of EVENT_KINDS)
      for (const t of CONTENT_TYPES)
        if (e !== 'publication_requested')
          expect(ids(sel(e, t))).not.toContain('DP-PUBLISH');
  });
});

describe('table vs catalog', () => {
  it('has a row for every DP id and every DP is reachable from some event', () => {
    expect(Object.keys(SELECTOR_TABLE).sort()).toEqual([...DP_IDS].sort());
    const reached = new Set<string>();
    for (const e of EVENT_KINDS)
      for (const t of CONTENT_TYPES)
        sel(e, t).forEach((x) => reached.add(x.dpId));
    expect([...DP_IDS].filter((d) => !reached.has(d))).toEqual([]);
  });

  const doc = '../docs/design/ai/decision-points.md';
  it.skipIf(!existsSync(doc))(
    'matches the catalog of decision-points.md and DP-STAGE is gone',
    () => {
      const md = readFileSync(doc, 'utf8');
      const catalog = md.slice(
        md.indexOf('## Catalog'),
        md.indexOf('## Which DPs apply'),
      );
      const found = [...catalog.matchAll(/^\| (DP-[A-Z-]+) \|/gm)].map(
        (m) => m[1],
      );
      expect(found.sort()).toEqual([...DP_IDS].sort());
      expect(found).not.toContain('DP-STAGE');
      expect(Object.keys(SELECTOR_TABLE)).not.toContain('DP-STAGE');
    },
  );

  const dpDir = '../can_policy/decision-points';
  it.skipIf(!existsSync(dpDir))(
    'every DP directory of can_policy is in the catalog',
    () => {
      const dirs = readdirSync(dpDir).filter((d) => d.startsWith('DP-'));
      expect(
        dirs.filter((d) => !(DP_IDS as readonly string[]).includes(d)),
      ).toEqual([]);
    },
  );
});

describe('purity', () => {
  it('selector sources import no Nest, Drizzle, pg or I/O', () => {
    for (const f of ['events.ts', 'table.ts', 'select.ts']) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      expect(imports.filter((i) => !i.startsWith('.'))).toEqual([]);
    }
  });
});
