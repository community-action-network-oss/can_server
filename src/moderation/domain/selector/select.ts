import type { DpId } from '../outcome.js';
import type {
  ContentType,
  DpMode,
  EventKind,
  PriorityClass,
} from './events.js';
import { SELECTOR_TABLE, TABLE_ORDER } from './table.js';

export interface SelectInput {
  event: EventKind;
  /** The target kind: one of the content types of the decision-points.md matrix. */
  contentType: ContentType;
  /** Problem or stage state. A private `draft` edit runs lighter: advisory (async) except crisis and legal. */
  state?: string;
  /** Edited events only. Absent or empty means the diff is unknown, so nothing is narrowed. */
  changedFields?: readonly string[];
  /** Pack resolution is the caller's: packDps already belongs to this jurisdiction's active pack. */
  jurisdictionId?: string;
  /** Caller attests policy_version is unchanged since the prior run; only then are unchanged fields reusable. */
  policyVersionUnchanged?: boolean;
  /** Ids of the DP sections the active pack carries. */
  packDps: ReadonlySet<string>;
}

export interface SelectedDp {
  dpId: DpId;
  mode: DpMode;
  /** Fields to check; empty means the whole target. */
  fields: readonly string[];
  /** Bound fields whose prior complete run may be reused. */
  reusePrior: readonly string[];
  priorityClass: PriorityClass;
  /** The pack has no section for it: the caller must hold (fail closed), never skip. */
  missing: boolean;
}

const FIRST: readonly DpId[] = ['DP-CRISIS', 'DP-LEGAL'];

export function selectDps(i: SelectInput): SelectedDp[] {
  const diff =
    i.event === 'edited' && i.changedFields?.length ? i.changedFields : null;
  const out: SelectedDp[] = [];
  for (const dpId of TABLE_ORDER) {
    const rule = SELECTOR_TABLE[dpId];
    let mode = rule.on[i.event];
    if (!mode || !rule.types.includes(i.contentType)) continue;
    const bound = rule.fields?.[i.contentType];
    let fields: readonly string[] = [];
    let reusePrior: readonly string[] = [];
    if (diff) {
      fields = bound ? diff.filter((f) => bound.includes(f)) : diff;
      if (bound && !fields.length) continue;
      if (bound && i.policyVersionUnchanged)
        reusePrior = bound.filter((f) => !diff.includes(f));
    }
    const first = FIRST.includes(dpId);
    if (i.state === 'draft' && i.event === 'edited' && !first) mode = 'async';
    out.push({
      dpId,
      mode,
      fields,
      reusePrior,
      priorityClass:
        first && mode === 'blocking'
          ? 'crisis'
          : i.event === 'sample_tick'
            ? 'sample'
            : mode === 'async'
              ? 'async'
              : i.event === 'edited'
                ? 'update'
                : 'prepub',
      missing: !i.packDps.has(dpId),
    });
  }
  return out;
}
