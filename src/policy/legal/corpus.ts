/** Legal corpus types and errors (10-u55). Pure; no I/O. Shapes mirror can_policy legal-corpus.schema.json. */
export const LEGAL_LAYERS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'] as const;
export type LegalLayerId = (typeof LEGAL_LAYERS)[number];
export type LegalMode = 'binding' | 'reference';
export type CorpusStatus = 'index_only' | 'draft' | 'ratified';
export type CorpusState = 'shadow' | 'canary' | 'active' | 'retired';

export interface LegalArticle {
  article_id: string;
  article_key: string;
  heading: string;
  source_locator: string;
  text_sha256: string;
  /** The article body exactly as hashed by text_sha256 (retrieval, 10-u56). Never serialised to an output. */
  text: string;
}

export interface LoadedCorpus {
  id: string;
  layer: LegalLayerId;
  jurisdiction: string;
  version: string;
  /** D-83 pack hash, pack-relative, no parent. */
  hash: string;
  contentHash: string;
  mode: LegalMode;
  status: CorpusStatus;
  reviewed: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  fictional: boolean;
  /** `<id>@<semver>+<hash12>`, the citation corpus_version. */
  corpusVersion: string;
  articles: readonly LegalArticle[];
  /** Raw topic-index.json entries; retrieval is 10-u56. */
  topicIndex: readonly Record<string, unknown>[];
}

/** One layer of a jurisdiction `legal_stack`, as pinned. */
export interface LegalPin {
  layer: LegalLayerId;
  corpus: string | null;
  version?: string;
  pack_hash?: string;
  mode: LegalMode | 'not_applicable';
  acknowledged_index_only?: boolean;
  reason?: string;
}

/** A stack layer as served. `corpus: null` only for a declared `not_applicable`. */
export interface LegalStackLayer {
  layer: LegalLayerId;
  corpus: LoadedCorpus | null;
  mode: LegalMode | 'not_applicable';
  /** Binding on an index_only stub: the layer names articles but holds no vendored text (acknowledged). */
  indexOnly: boolean;
}

/** A corpus failed provenance, hash or review checks. Never loaded; the previous version keeps serving. */
export class LegalCorpusRefused extends Error {}

/** FAIL-CLOSED-AI-1: callers map this to `hold`, never to "no law applies". */
export class LegalLayerMissing extends Error {
  constructor(
    readonly jurisdiction: string,
    readonly layer: LegalLayerId | null,
    reason: string,
  ) {
    super(
      `legal stack for ${jurisdiction}${layer ? ` ${layer}` : ''}: ${reason}`,
    );
  }
}
