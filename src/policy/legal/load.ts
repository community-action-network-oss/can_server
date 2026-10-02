import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  computePackHash,
  sha256,
  versionString,
  type PackFiles,
} from '../domain/hash.js';
import { parseYaml, type Yaml } from '../domain/yaml.js';
import {
  LEGAL_LAYERS,
  LegalCorpusRefused,
  type LegalArticle,
  type LoadedCorpus,
} from './corpus.js';

const str = { type: 'string', minLength: 1 };
const re = (pattern: string) => ({ type: 'string', pattern });
const date = re('^\\d{4}-\\d{2}-\\d{2}$');
// Closed copy of can_policy/schemas/legal-corpus.schema.json (server tests never read ../can_policy).
const CORPUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'layer',
    'jurisdiction',
    'instrument',
    'official_publisher',
    'source_url',
    'retrieval_date',
    'version',
    'effective_from',
    'effective_to',
    'language',
    'license',
    'content_hash',
    'mode',
    'status',
    'reviewed',
    'reviewer',
  ],
  properties: {
    id: re('^[a-z0-9][a-z0-9-]*$'),
    layer: { enum: [...LEGAL_LAYERS] },
    jurisdiction: re('^[a-z0-9][a-z0-9-]*$'),
    instrument: str,
    official_publisher: str,
    source_url: re('^https?://\\S+$'),
    retrieval_date: date,
    version: re('^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$'),
    effective_from: date,
    effective_to: { anyOf: [{ type: 'null' }, date] },
    language: re('^[a-z]{2,3}(-[A-Za-z0-9]+)*$'),
    translations: { type: 'array', items: { type: 'object' } },
    license: str,
    content_hash: re('^[0-9a-f]{64}$'),
    mode: { enum: ['binding', 'reference'] },
    status: { enum: ['index_only', 'draft', 'ratified'] },
    reviewed: { type: 'boolean' },
    reviewer: {
      anyOf: [
        { const: 'none' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'qualification', 'date', 'scope'],
          properties: { name: str, qualification: str, date, scope: str },
        },
      ],
    },
    fictional: { type: 'boolean' },
  },
};
const ARTICLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'article_id',
    'article_key',
    'heading',
    'language',
    'source_locator',
    'text_sha256',
  ],
  properties: {
    article_id: re('^L[1-6]/[a-z0-9-]+(/[a-z0-9-]+)+/[a-z0-9][a-z0-9.-]*$'),
    article_key: re('^[a-z0-9][a-z0-9.-]*$'),
    heading: str,
    language: re('^[a-z]{2,3}(-[A-Za-z0-9]+)*$'),
    source_locator: str,
    text_sha256: re('^[0-9a-f]{64}$'),
  },
};
const ajv = new Ajv2020({ strict: true, strictTypes: true, allErrors: true });
const vCorpus = ajv.compile(CORPUS_SCHEMA);
const vArticle = ajv.compile(ARTICLE_SCHEMA);

const dec = (b: Uint8Array) =>
  Buffer.from(b).toString('utf8').replace(/\r\n/g, '\n');
const bytes = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * Verify and compile a corpus dir (files keyed by pack-relative path). Throws LegalCorpusRefused on any
 * provenance gap, article without source_locator, content_hash or manifest mismatch, or unreviewed ratified claim.
 */
export function loadCorpus(
  files: PackFiles,
  expectedHash?: string,
): LoadedCorpus {
  const need = (p: string): string => {
    const f = files.get(p);
    if (!f) throw new LegalCorpusRefused(`missing ${p}`);
    return dec(f);
  };
  const yaml = (p: string): Record<string, Yaml> => {
    try {
      return parseYaml(need(p)) as Record<string, Yaml>;
    } catch (e) {
      if (e instanceof LegalCorpusRefused) throw e;
      throw new LegalCorpusRefused(`${p} does not parse`);
    }
  };

  const c = yaml('corpus.yaml');
  if (!vCorpus(c))
    throw new LegalCorpusRefused(
      `corpus.yaml fails provenance schema: ${ajv.errorsText(vCorpus.errors)}`,
    );
  const id = String(c.id);
  const layer = c.layer as LoadedCorpus['layer'];
  const jurisdiction = String(c.jurisdiction);
  if (!id.startsWith(`${jurisdiction}-`))
    throw new LegalCorpusRefused(`${id}: id must start with ${jurisdiction}-`);
  const prefix = `${layer}/${jurisdiction}/${id.slice(jurisdiction.length + 1)}`;

  const meta = yaml('pack.yaml');
  if (meta.name !== id || meta.version !== c.version)
    throw new LegalCorpusRefused(
      `${id}: pack.yaml does not describe ${id}@${String(c.version)}`,
    );

  const names = [...files.keys()]
    .filter((p) => /^articles\/[^/]+\.md$/.test(p))
    .sort(bytes);
  const articles: LegalArticle[] = [];
  const bodies: string[] = [];
  for (const p of names) {
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(dec(files.get(p)!));
    if (!m) throw new LegalCorpusRefused(`${p}: missing frontmatter`);
    const front = parseYaml(m[1]) as Record<string, Yaml>;
    if (!front?.source_locator)
      throw new LegalCorpusRefused(`${p}: article without source_locator`);
    if (!vArticle(front))
      throw new LegalCorpusRefused(`${p}: ${ajv.errorsText(vArticle.errors)}`);
    const key = p.slice('articles/'.length, -3);
    if (front.article_key !== key || front.article_id !== `${prefix}/${key}`)
      throw new LegalCorpusRefused(
        `${p}: article_id or article_key does not match the file`,
      );
    if (front.language !== c.language)
      throw new LegalCorpusRefused(`${p}: not in the authoritative language`);
    if (sha256(m[2]) !== front.text_sha256)
      throw new LegalCorpusRefused(
        `${p}: text_sha256 does not match the article text`,
      );
    articles.push({
      article_id: String(front.article_id),
      article_key: key,
      heading: String(front.heading),
      source_locator: String(front.source_locator),
      text_sha256: String(front.text_sha256),
    });
    bodies.push(m[2]);
  }
  if (sha256(bodies.join('')) !== c.content_hash)
    throw new LegalCorpusRefused(
      `${id}: content_hash does not match the article texts`,
    );

  if (c.status === 'ratified' && (!c.reviewed || c.reviewer === 'none'))
    throw new LegalCorpusRefused(`${id}: ratified without a review record`);
  if (c.status !== 'index_only' && !articles.length)
    throw new LegalCorpusRefused(
      `${id}: ${String(c.status)} corpus without articles`,
    );

  let topicIndex: Record<string, unknown>[] = [];
  if (files.has('topic-index.json')) {
    try {
      topicIndex = JSON.parse(need('topic-index.json')) as Record<
        string,
        unknown
      >[];
    } catch {
      throw new LegalCorpusRefused(`${id}: topic-index.json does not parse`);
    }
    const known = new Set(articles.map((a) => a.article_id));
    if (
      !Array.isArray(topicIndex) ||
      topicIndex.some((e) => !known.has(String(e.article_id)))
    )
      throw new LegalCorpusRefused(
        `${id}: topic-index.json names an article that is not in the corpus`,
      );
  } else if (articles.length)
    throw new LegalCorpusRefused(`${id}: missing topic-index.json`);

  const hash = computePackHash(files, null);
  if (expectedHash && hash !== expectedHash)
    throw new LegalCorpusRefused(
      `${id}: hash mismatch (pinned ${expectedHash.slice(0, 12)}, found ${hash.slice(0, 12)})`,
    );
  const manifest = JSON.parse(need('manifest.json')) as { pack_hash?: string };
  if (manifest.pack_hash !== hash)
    throw new LegalCorpusRefused(
      `${id}: manifest.json does not match the files`,
    );

  const version = String(c.version);
  return {
    id,
    layer,
    jurisdiction,
    version,
    hash,
    contentHash: String(c.content_hash),
    mode: c.mode as LoadedCorpus['mode'],
    status: c.status as LoadedCorpus['status'],
    reviewed: c.reviewed as boolean,
    effectiveFrom: String(c.effective_from),
    effectiveTo: c.effective_to === null ? null : String(c.effective_to),
    fictional: c.fictional === true,
    corpusVersion: versionString(id, version, hash),
    articles,
    topicIndex,
  };
}
