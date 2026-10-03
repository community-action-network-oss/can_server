// Contribution type enum (docs/spec/01-slice-1-brief.md section 6). Single source: the stages matrix (12-u01).
import {
  CONTRIBUTION_TYPES,
  type ContributionType,
} from '../../stages/domain/contribution-matrix.js';

export { CONTRIBUTION_TYPES, type ContributionType };

/** Reserved: people use appeals in slice 1; only the system may write this type. */
export const RESERVED_TYPES: readonly ContributionType[] = [
  'moderation_feedback',
];

export const USER_TYPES: readonly ContributionType[] =
  CONTRIBUTION_TYPES.filter((t) => !RESERVED_TYPES.includes(t));

export const CONTRIBUTION_STATUSES = [
  'pending_review',
  'accepted',
  'hidden',
  'tombstoned',
] as const;
export type ContributionStatus = (typeof CONTRIBUTION_STATUSES)[number];

/** Who wrote it. A system actor (for example `news_watch`, D-79) carries a label instead of an account. */
export type ContributionAuthor =
  { kind: 'account'; accountId: string } | { kind: 'system'; label: string };
