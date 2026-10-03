import { Injectable } from '@nestjs/common';
import type { LegalRetrieval } from '../../../policy/legal/index.js';

/** What a judged reading of one layer says. `unjudged` is never permission (FAIL-CLOSED-AI-1). */
export type JudgedFinding = 'constrains' | 'permits' | 'unjudged';
export type RetrievedLayer = LegalRetrieval['layers'][number];

/** Seam for the DP-LEGALITY judge (09-u41). Gets a layer that retrieved at least one article; never article text out. */
export interface LegalJudgePort {
  judge(layer: RetrievedLayer): Promise<JudgedFinding>;
}
export const LEGAL_JUDGE = Symbol('LegalJudgePort');

/** Default until DP-LEGALITY exists: a topic ban constrains, any other retrieved article is unjudged, never `permits`. */
@Injectable()
export class FailClosedLegalJudge implements LegalJudgePort {
  async judge(layer: RetrievedLayer): Promise<JudgedFinding> {
    return layer.articles.some((a) => a.topic_ban) ? 'constrains' : 'unjudged';
  }
}
