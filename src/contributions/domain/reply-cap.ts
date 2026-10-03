// D-85: at most 4 replies per account per problem per rolling 24 hours. Pure.

export const DEFAULT_REPLY_CAP = { count: 4, days: 1 } as const;
export type ReplyCap = { count: number; days: number };

const pos = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Reads `caps.replies_per_account_per_problem_per_day` from pack limits; any bad or missing part falls back to the default. */
export function replyCapFrom(limits: unknown): ReplyCap {
  const raw = (limits as { caps?: Record<string, unknown> } | null | undefined)
    ?.caps?.replies_per_account_per_problem_per_day as
    { count?: unknown; days?: unknown } | undefined;
  return {
    count: pos(raw?.count) ? Math.floor(raw.count) : DEFAULT_REPLY_CAP.count,
    days: pos(raw?.days) ? raw.days : DEFAULT_REPLY_CAP.days,
  };
}

export const replyWindowStart = (now: Date, cap: ReplyCap) =>
  new Date(now.getTime() - cap.days * 86_400_000);

export interface ReplyAllowance {
  limit: number;
  remaining: number;
  /** When the next slot frees (the oldest counted reply leaves the window); null if nothing is counted. */
  resetsAt: string | null;
}

/** `counted` = createdAt of every reply by this account on this problem inside the window (withdrawn or removed ones included). */
export function replyAllowance(
  cap: ReplyCap,
  counted: readonly Date[],
): ReplyAllowance {
  const t = counted.map((d) => d.getTime()).sort((a, b) => a - b);
  const over = Math.max(0, t.length - cap.count);
  const next = t[over]; // at the limit this is the oldest; over it, the reply whose exit brings us under
  return {
    limit: cap.count,
    remaining: Math.max(0, cap.count - t.length),
    resetsAt:
      next === undefined
        ? null
        : new Date(next + cap.days * 86_400_000).toISOString(),
  };
}
