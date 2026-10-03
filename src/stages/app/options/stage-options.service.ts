import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import { DB, type Db } from '../../../db/db.module.js';
import {
  account,
  contribution,
  problem,
  stage,
  stageOption,
} from '../../../db/schema.js';
import { ApiException } from '../../../platform/errors.js';
import { visibleToViewer } from '../../infra/stage-plan.repo.js';

const UUID = /^[0-9a-f-]{36}$/i;
const nf = () => new ApiException(404, 'not_found', 'Not found.');
type Opt = typeof stageOption.$inferSelect;
type Content = Record<string, unknown>;

const str = (v: unknown) =>
  typeof v === 'string'
    ? v
    : Array.isArray(v)
      ? v.map(String).join('\n')
      : null;
/** The stage_option schema and the contribution schema name a few fields differently; both are read here. */
const cost = (c: Content) => {
  const e = c.cost_estimate as { band?: string; amount?: number } | undefined;
  return e && typeof e === 'object'
    ? [e.band, e.amount].filter((x) => x !== undefined).join(' ')
    : str(c.cost);
};
const FIELDS: [string, (c: Content) => string | null][] = [
  ['mechanism', (c) => str(c.mechanism)],
  ['authority', (c) => str(c.authority_and_legal_basis ?? c.authority)],
  ['cost', cost],
  ['risks', (c) => str(c.risks_and_rights_impact ?? c.risks)],
];

/** Fixed order of creation, no scores or counts (RANK-1). Shows stored facts only, never model text. */
@Injectable()
export class StageOptionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(stageId: string, viewerId: string | null) {
    if (!UUID.test(stageId)) throw nf();
    const [r] = await this.db
      .select({ p: problem })
      .from(stage)
      .innerJoin(problem, eq(problem.id, stage.problemId))
      .where(eq(stage.id, stageId));
    if (!r || !visibleToViewer(r.p, viewerId)) throw nf();

    const rows = await this.db
      .select({ o: stageOption, handle: account.handle })
      .from(stageOption)
      .innerJoin(account, eq(account.id, stageOption.authorId))
      .where(eq(stageOption.stageId, stageId))
      .orderBy(asc(stageOption.createdAt), asc(stageOption.id));
    const ids = rows.map((x) => x.o.id);
    const imps = ids.length
      ? await this.db
          .select({ c: contribution, handle: account.handle })
          .from(contribution)
          .leftJoin(account, eq(account.id, contribution.authorId))
          .where(
            and(
              inArray(contribution.improvesOptionId, ids),
              or(
                eq(contribution.status, 'accepted'),
                viewerId
                  ? and(
                      eq(contribution.authorId, viewerId),
                      eq(contribution.status, 'pending_review'),
                    )
                  : undefined,
              ),
            ),
          )
          .orderBy(asc(contribution.createdAt), asc(contribution.id))
      : [];
    const under = new Map<string, typeof imps>();
    for (const i of imps) {
      const k = i.c.improvesOptionId!;
      under.set(k, [...(under.get(k) ?? []), i]);
    }

    const mine = (o: Opt) => !!viewerId && o.authorId === viewerId;
    const items = rows
      .filter(({ o }) => {
        if (o.status === 'public') return true;
        if (o.status === 'pending') return mine(o);
        // A withdrawn parent stays as a placeholder only to keep its improvements readable.
        return o.status === 'withdrawn' && under.has(o.id);
      })
      .map(({ o, handle }) => ({
        id: o.id,
        stageId: o.stageId,
        authorHandle: handle,
        status: o.status,
        pendingReview: o.status === 'pending',
        forLaterStage: o.forLaterStage,
        content: o.status === 'withdrawn' ? null : o.content,
        improvements: (under.get(o.id) ?? []).map(({ c, handle: h }) => ({
          id: c.id,
          authorHandle: h ?? '',
          pendingReview: c.status === 'pending_review',
          content: c.body,
          createdAt: c.createdAt.toISOString(),
        })),
        createdAt: o.createdAt.toISOString(),
      }));

    // Same for every viewer: public options only.
    const pub = rows.filter(({ o }) => o.status === 'public').map((x) => x.o);
    return {
      items,
      criteria: { order: 'created_at_asc', usesEngagementSignals: false },
      comparison:
        pub.length >= 2
          ? {
              rows: FIELDS.map(([field, get]) => ({
                field,
                cells: pub.map((o) => ({
                  optionId: o.id,
                  value: get(o.content),
                })),
              })),
            }
          : null,
    };
  }
}
