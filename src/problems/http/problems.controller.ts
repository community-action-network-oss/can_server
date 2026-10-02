import { Controller, Get, Header, Inject, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import { problem } from '../../db/schema.js';
import {
  isPublicState,
  type State,
  STATES,
} from '../../domain/lifecycle/vocabulary.js';
import { ApiErrors, ApiException } from '../../platform/errors.js';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
} from '../../platform/pagination.js';
import {
  ListProblemsQueryDto,
  PublicProblemDto,
  PublicProblemPageDto,
} from './problems.dto.js';

type Row = typeof problem.$inferSelect;
const toDto = (r: Row): PublicProblemDto => ({
  id: r.id,
  title: r.title,
  state: r.state,
  publishedAt: r.publishedAt.toISOString(),
  help_needed: r.helpNeeded,
});

const PUBLIC_STATES = STATES.filter((s) => isPublicState(s));
const UUID = /^[0-9a-f-]{36}$/i;

// Same answer for every caller: no session, no profile, no per-person variation (spec 26 section 4).
@ApiTags('problems')
@Controller('v1/problems')
export class ProblemsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({
    operationId: 'listPublicProblems',
    summary:
      'Public problems, newest first, with help_needed; whole or by coarse region shard',
  })
  @ApiOkResponse({ type: PublicProblemPageDto })
  @ApiErrors(400, 429, 500)
  async list(@Query() q: ListProblemsQueryDto): Promise<PublicProblemPageDto> {
    const limit = clampLimit(q.limit);
    const conds = [
      sql`${problem.state} in (${sql.join(
        PUBLIC_STATES.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    ];
    if (q.region)
      conds.push(sql`${problem.helpNeeded}->>'coarse_place' = ${q.region}`);
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      const at = typeof c.at === 'string' ? new Date(c.at) : null;
      if (
        !at ||
        isNaN(at.getTime()) ||
        typeof c.id !== 'string' ||
        !UUID.test(c.id)
      )
        throw new ApiException(400, 'validation_failed', 'Invalid cursor', {
          cursor: 'Invalid cursor',
        });
      conds.push(
        or(
          lt(problem.publishedAt, at),
          and(eq(problem.publishedAt, at), lt(problem.id, c.id)),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(problem)
      .where(and(...conds))
      .orderBy(desc(problem.publishedAt), desc(problem.id))
      .limit(limit + 1);
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items: items.map(toDto),
      nextCursor:
        more && last
          ? encodeCursor({ at: last.publishedAt.toISOString(), id: last.id })
          : null,
    };
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'getPublicProblem',
    summary: 'One public problem with help_needed',
  })
  @ApiOkResponse({ type: PublicProblemDto })
  @ApiErrors(404, 429, 500)
  async get(@Param('id') id: string): Promise<PublicProblemDto> {
    const [r] = UUID.test(id)
      ? await this.db.select().from(problem).where(eq(problem.id, id))
      : [];
    if (!r || !isPublicState(r.state as State))
      throw new ApiException(404, 'not_found', 'Problem not found');
    return toDto(r);
  }
}
