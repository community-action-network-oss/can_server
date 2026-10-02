import {
  LegalLayerMissing,
  type LegalLayerId,
  type LegalStackLayer,
} from '../corpus.js';
import { legalRetrievalLimits, type LegalRetrievalLimits } from './limits.js';

/** Token estimate: ceil(chars / CHARS_PER_TOKEN). 4 is the usual rough figure for English; a seam, not a tokenizer. */
export const CHARS_PER_TOKEN = 4;
export const estimateTokens = (s: string) =>
  Math.ceil(s.length / CHARS_PER_TOKEN);

export interface TypedFields {
  topic?: string;
  place?: string;
  responsible_roles?: readonly string[];
  mechanism?: string;
  authority?: string;
}

export interface RetrievedArticle {
  article_id: string;
  text_sha256: string;
  text: string;
  /** True only when the index flags a ban AND the ban scope covers this item's topic. */
  topic_ban: boolean;
}

export interface RetrievedLayer {
  layer: LegalLayerId;
  /** null only for a declared not_applicable layer. */
  corpus_version: string | null;
  corpus_hash: string | null;
  articles: RetrievedArticle[];
  /** A recorded fact ("no applicable article found in L4 (version)"), not a pass. */
  noneFound: boolean;
  notApplicable: boolean;
}

export interface LegalRetrieval {
  layers: RetrievedLayer[];
  /** 0..1: best article match over the run, 0 when nothing was retrieved. */
  retrievalConfidence: number;
  /** Confidence under the floor AND the topic is risky: caller escalates to a stronger model, then hold. */
  escalate: boolean;
  /** Confidence under the floor on any topic (callers should prefer hold over silence). */
  lowConfidence: boolean;
  /** An article that must be included (or a matched one) did not fit the budget: never complete, so escalate is set. */
  truncated: boolean;
  tokens: number;
  limitsDefaulted: readonly string[];
}

export interface RetrieveInput {
  jurisdiction: string;
  at: Date;
  typedFields: TypedFields;
  dp: string;
  /** Per-call cap; the effective budget is min(this, limits.token_budget_per_run). */
  budgetTokens?: number;
  /** Parsed limits.yaml root of the active pack. Absent or without `legal.retrieval`: defaults, reported in limitsDefaulted. */
  packLimits?: unknown;
}

export interface StackSource {
  stackFor(jurisdiction: string, at: Date): Promise<LegalStackLayer[]>;
}

interface Entry {
  article_id: string;
  topics?: string[];
  actors?: string[];
  actions?: string[];
  constraint_kinds?: string[];
  always_for_dps?: string[];
  topic_ban?: boolean;
  ban_scope?: string[];
}

const tok = (s: string | undefined) =>
  (s ?? '')
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(Boolean);
const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Deterministic score: topic 4, actor 2, action 2, constraint kind 1, place 1 (weak topic hint).
 * An entry is a candidate only on a topic hit, or on actor AND action together (an actor alone is too weak).
 * Confidence: 0.5 for a topic hit plus up to 0.5 for the other hits (5 points saturate); 0.3 for actor+action only.
 */
function score(e: Entry, f: TypedFields) {
  const topic = tok(f.topic);
  const topics = arr(e.topics);
  const topicHit = topics.some((t) => topic.includes(t));
  const placeHit = topics.some((t) => tok(f.place).includes(t));
  const roles = [
    ...(f.responsible_roles ?? []).flatMap(tok),
    ...tok(f.authority),
  ];
  const mech = tok(f.mechanism);
  const actor = arr(e.actors).some((a) => roles.includes(a));
  const action = arr(e.actions).some((a) => mech.includes(a));
  const kind = arr(e.constraint_kinds).some((k) => mech.includes(k));
  const eligible = topicHit || (actor && action);
  const points = (actor ? 2 : 0) + (action ? 2 : 0) + (kind ? 1 : 0);
  return {
    eligible,
    score: (topicHit ? 4 : 0) + points + (placeHit ? 1 : 0),
    confidence: topicHit ? 0.5 + 0.5 * Math.min(1, points / 5) : 0.3,
    topicHit,
  };
}

/**
 * The few articles per layer that bind the item, within budget. Throws LegalLayerMissing when the stack has
 * any gap (use tryRetrieveLegal for the hold signal).
 * Seam: an embedding re-rank may reorder `ranked` below within the topic index candidates; out of scope here.
 */
export async function retrieveLegal(
  registry: StackSource,
  input: RetrieveInput,
): Promise<LegalRetrieval> {
  const limits: LegalRetrievalLimits = legalRetrievalLimits(input.packLimits);
  const budget = Math.min(
    limits.token_budget_per_run,
    input.budgetTokens ?? Infinity,
  );
  const stack = await registry.stackFor(input.jurisdiction, input.at);
  const f = input.typedFields;
  let used = 0;
  let truncated = false;
  let best = 0;

  // Per-layer picks first (always-articles ahead of ranked), then budget in layer order so truncation is deterministic.
  const out: RetrievedLayer[] = stack.map((sl) => {
    const c = sl.corpus;
    if (!c)
      return {
        layer: sl.layer,
        corpus_version: null,
        corpus_hash: null,
        articles: [],
        noneFound: false,
        notApplicable: true,
      };
    return {
      layer: sl.layer,
      corpus_version: c.corpusVersion,
      corpus_hash: c.hash,
      articles: [],
      noneFound: true,
      notApplicable: false,
    };
  });

  const take = (
    lr: RetrievedLayer,
    sl: LegalStackLayer,
    e: Entry,
    conf: number,
  ) => {
    const a = sl.corpus!.articles.find((x) => x.article_id === e.article_id);
    if (!a) return false;
    const cost = estimateTokens(a.text);
    if (used + cost > budget) {
      truncated = true;
      return false;
    }
    used += cost;
    const ban = e.topic_ban === true;
    const scope = arr(e.ban_scope);
    lr.articles.push({
      article_id: a.article_id,
      text_sha256: a.text_sha256,
      text: a.text,
      topic_ban:
        ban && (!scope.length || scope.some((s) => tok(f.topic).includes(s))),
    });
    lr.noneFound = false;
    best = Math.max(best, conf);
    return true;
  };

  // Pass 1: always-articles of every layer, so budget truncation can never drop them for a ranked one.
  const entriesOf = (sl: LegalStackLayer) =>
    (sl.corpus?.topicIndex ?? []) as unknown as Entry[];
  const alwaysOf = (sl: LegalStackLayer) =>
    entriesOf(sl)
      .filter((e) => arr(e.always_for_dps).includes(input.dp))
      .sort((a, b) => a.article_id.localeCompare(b.article_id));
  stack.forEach((sl, i) => {
    for (const e of alwaysOf(sl)) take(out[i], sl, e, 1);
  });
  // Pass 2: ranked matches per layer, in layer order.
  stack.forEach((sl, i) => {
    if (!sl.corpus) return;
    const lr = out[i];
    const always = alwaysOf(sl);
    const ranked = entriesOf(sl)
      .filter((e) => !always.includes(e))
      .map((e) => ({ e, ...score(e, f) }))
      .filter((r) => r.eligible)
      .sort(
        (a, b) =>
          b.score - a.score || a.e.article_id.localeCompare(b.e.article_id),
      );
    for (const r of ranked) {
      if (lr.articles.length >= limits.max_articles_per_layer) break;
      // Budget stop: lower ranked articles are dropped, never skipped around.
      if (!take(lr, sl, r.e, r.confidence)) break;
    }
  });

  const retrievalConfidence = best;
  const lowConfidence = retrievalConfidence < limits.low_confidence_floor;
  const risky = tok(f.topic).some((t) => limits.risky_topics.includes(t));
  return {
    layers: out,
    retrievalConfidence,
    lowConfidence,
    escalate: (lowConfidence && risky) || truncated,
    truncated,
    tokens: used,
    limitsDefaulted: limits.defaulted,
  };
}

export type RetrieveOutcome =
  | { ok: true; retrieval: LegalRetrieval }
  | { ok: false; hold: true; reason: string; layer: LegalLayerId | null };

/** Fail closed (FAIL-CLOSED-AI-1): a missing layer or any retrieval failure is a hold for the run, never an empty legal section. */
export async function tryRetrieveLegal(
  registry: StackSource,
  input: RetrieveInput,
): Promise<RetrieveOutcome> {
  try {
    return { ok: true, retrieval: await retrieveLegal(registry, input) };
  } catch (e) {
    return {
      ok: false,
      hold: true,
      reason: e instanceof Error ? e.message : 'legal retrieval failed',
      layer: e instanceof LegalLayerMissing ? e.layer : null,
    };
  }
}

/**
 * Stage-output cache key part (09-u19): every layer's corpus version and hash plus the sorted retrieved article
 * ids with text hashes, so a corpus change (even on a layer that found nothing) invalidates cached decisions.
 */
export function legalCacheKeyPart(r: LegalRetrieval): string {
  const layers = r.layers.map(
    (l) => `${l.layer}=${l.corpus_version ?? 'n/a'}#${l.corpus_hash ?? ''}`,
  );
  const arts = r.layers
    .flatMap((l) =>
      l.articles.map(
        (a) => `${a.article_id}@${l.corpus_version}#${a.text_sha256}`,
      ),
    )
    .sort();
  return [...layers, ...arts].join('|');
}
