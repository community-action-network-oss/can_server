import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq, isNull } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module.js';
import { account, accountRole } from '../../db/schema.js';
import { withTransaction } from '../../db/tx.js';
import { AuditPort } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors.js';
import {
  CLOCK,
  ID_GENERATOR,
  type Clock,
  type IdGenerator,
} from '../../platform/ports.js';
import type { AuthedRequest } from '../../platform/security/auth.guard.js';

export const HUMAN_ROLES = [
  'auditor',
  'labeler',
  'lane_member',
  'steward',
] as const;
export type HumanRole = (typeof HUMAN_ROLES)[number];

export const REQUIRE_ROLE_KEY = 'can:require-role';
/** Route needs ANY of these human roles. Pair with @Authenticated() on GET. Never grants publish, reject or override. */
export const RequireRole = (...roles: HumanRole[]) =>
  SetMetadata(REQUIRE_ROLE_KEY, roles);

@Injectable()
export class RoleService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(AuditPort) private readonly audit: AuditPort,
  ) {}

  /** Active roles. Steward is also implied by the base roles moderator and admin (03-u15). */
  async rolesOf(accountId: string): Promise<HumanRole[]> {
    const [rows, base] = await Promise.all([
      this.db
        .select({ role: accountRole.role })
        .from(accountRole)
        .where(
          and(
            eq(accountRole.accountId, accountId),
            isNull(accountRole.revokedAt),
          ),
        ),
      this.db
        .select({ role: account.role })
        .from(account)
        .where(eq(account.id, accountId)),
    ]);
    const out = new Set(rows.map((r) => r.role as HumanRole));
    if (base[0] && ['moderator', 'admin'].includes(base[0].role))
      out.add('steward');
    return HUMAN_ROLES.filter((r) => out.has(r));
  }

  async hasRole(accountId: string, role: HumanRole): Promise<boolean> {
    return (await this.rolesOf(accountId)).includes(role);
  }

  /** Admin-only. `grantedBy` null means a seed or test script; no public route calls this. */
  async grantRole(
    accountId: string,
    role: HumanRole,
    grantedBy: string | null,
  ): Promise<void> {
    await this.assertAdmin(grantedBy);
    await withTransaction(this.db, async (tx) => {
      const id = this.ids.next();
      await tx.insert(accountRole).values({
        id,
        accountId,
        role,
        grantedBy,
        grantedAt: this.clock.now(),
      });
      await this.audit.record(tx, {
        actorId: grantedBy,
        action: 'account.role.granted',
        subjectType: 'account',
        subjectId: accountId,
        detail: { role },
      });
    });
  }

  async revokeRole(
    accountId: string,
    role: HumanRole,
    revokedBy: string | null,
  ): Promise<void> {
    await this.assertAdmin(revokedBy);
    await withTransaction(this.db, async (tx) => {
      const done = await tx
        .update(accountRole)
        .set({ revokedAt: this.clock.now() })
        .where(
          and(
            eq(accountRole.accountId, accountId),
            eq(accountRole.role, role),
            isNull(accountRole.revokedAt),
          ),
        )
        .returning({ id: accountRole.id });
      if (!done.length) return;
      await this.audit.record(tx, {
        actorId: revokedBy,
        action: 'account.role.revoked',
        subjectType: 'account',
        subjectId: accountId,
        detail: { role },
      });
    });
  }

  private async assertAdmin(actorId: string | null) {
    if (actorId === null) return;
    const [a] = await this.db
      .select({ role: account.role })
      .from(account)
      .where(eq(account.id, actorId));
    if (a?.role !== 'admin')
      throw new ApiException(
        403,
        'not_permitted',
        'Only an admin can do that.',
      );
  }
}

/** Runs after AuthGuard. Denies with 403 not_permitted naming the role needed. */
@Injectable()
export class RequireRoleGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RoleService) private readonly roles: RoleService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const need = this.reflector.getAllAndOverride<HumanRole[] | undefined>(
      REQUIRE_ROLE_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!need?.length) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const have = req.auth ? await this.roles.rolesOf(req.auth.accountId) : [];
    if (!need.some((r) => have.includes(r)))
      throw new ApiException(
        403,
        'not_permitted',
        `This needs the ${need.join(' or ').replaceAll('_', ' ')} role.`,
      );
    return true;
  }
}
