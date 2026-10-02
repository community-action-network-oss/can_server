import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LegalCorpusRefused,
  LegalLayerMissing,
} from '../../src/policy/legal/corpus.js';
import { loadCorpus } from '../../src/policy/legal/load.js';
import {
  parseLegalStack,
  readCorpusDir,
} from '../../src/policy/legal/registry.js';
import {
  FIKTIVA_DIRS,
  dirOf,
  edit,
  fiktivaStack,
  reseal,
  tmpCopy,
} from './support.js';

const union = () => dirOf('L2-supranational', 'union');
const art = (d: string) => join(d, 'articles/art-4.md');

describe('loadCorpus', () => {
  it('loads every fictional corpus with hashes that match the manifest and the pins', async () => {
    const pins = parseLegalStack('fiktiva-city', fiktivaStack());
    for (const [i, [l, n]] of FIKTIVA_DIRS.entries()) {
      const c = loadCorpus(await readCorpusDir(dirOf(l, n)), pins[i].pack_hash);
      expect(c.layer).toBe(pins[i].layer);
      expect(c.fictional).toBe(true);
      expect(c.corpusVersion).toMatch(/^fiktiva-\w+@0\.1\.0\+[0-9a-f]{12}$/);
    }
  });

  it('keeps the invented articles the unit needs', async () => {
    const l5 = loadCorpus(await readCorpusDir(dirOf('L5-regional', 'region')));
    expect(l5.status).toBe('index_only');
    const l6 = loadCorpus(await readCorpusDir(dirOf('L6-city', 'bylaws')));
    expect(l6.topicIndex[0]).toMatchObject({ topic_ban: true });
    expect(l6.reviewed).toBe(true);
  });

  it('refuses a tampered article', async () => {
    const d = tmpCopy(union());
    edit(art(d), (s) => s.replace('No public body', 'Any public body'));
    await expect(readCorpusDir(d).then((f) => loadCorpus(f))).rejects.toThrow(
      LegalCorpusRefused,
    );
  });

  it('refuses an article without source_locator', async () => {
    const d = tmpCopy(union());
    edit(art(d), (s) => s.replace(/^source_locator:.*\n/m, ''));
    await expect(readCorpusDir(d).then((f) => loadCorpus(f))).rejects.toThrow(
      /source_locator/,
    );
  });

  it('refuses a corpus missing a provenance field', async () => {
    const d = tmpCopy(union());
    edit(join(d, 'corpus.yaml'), (s) => s.replace(/^license:.*\n/m, ''));
    await expect(readCorpusDir(d).then((f) => loadCorpus(f))).rejects.toThrow(
      /provenance/,
    );
  });

  it('refuses a changed corpus that still claims the old hashes, and a wrong pin', async () => {
    const d = tmpCopy(union());
    edit(join(d, 'README.md'), (s) => s + 'x');
    const files = await readCorpusDir(d);
    expect(() => loadCorpus(files)).toThrow(/manifest/);
    const ok = await readCorpusDir(union());
    expect(() => loadCorpus(ok, 'f'.repeat(64))).toThrow(/hash mismatch/);
  });

  it('loads a legitimately resealed new version', async () => {
    const d = tmpCopy(union());
    edit(art(d), (s) => s.replace('No public body', 'No city body'));
    const hash = await reseal(d, '0.2.0');
    expect(loadCorpus(await readCorpusDir(d), hash).version).toBe('0.2.0');
  });

  it('refuses a ratified corpus without a review record', async () => {
    const d = tmpCopy(union());
    edit(join(d, 'corpus.yaml'), (s) =>
      s
        .replace('status: draft', 'status: ratified')
        .replace('reviewed: true', 'reviewed: false'),
    );
    const hash = await reseal(d, '0.1.0');
    await expect(
      readCorpusDir(d).then((f) => loadCorpus(f, hash)),
    ).rejects.toThrow(/review/);
  });
});

describe('parseLegalStack', () => {
  it('returns six ordered pins', () => {
    expect(parseLegalStack('j', fiktivaStack()).map((p) => p.layer)).toEqual([
      'L1',
      'L2',
      'L3',
      'L4',
      'L5',
      'L6',
    ]);
  });
  it('rejects five layers, a bare null corpus and not_applicable outside L2 and L5', () => {
    const six = fiktivaStack() as Record<string, unknown>[];
    expect(() => parseLegalStack('j', six.slice(0, 5) as never)).toThrow(
      LegalLayerMissing,
    );
    expect(() =>
      parseLegalStack(
        'j',
        six.map((p, i) =>
          i === 3 ? { layer: 'L4', corpus: null, mode: 'binding' } : p,
        ) as never,
      ),
    ).toThrow(/reason/);
    expect(() =>
      parseLegalStack(
        'j',
        six.map((p, i) =>
          i === 3
            ? { layer: 'L4', corpus: null, mode: 'not_applicable', reason: 'x' }
            : p,
        ) as never,
      ),
    ).toThrow(/L2 and L5/);
  });
});
