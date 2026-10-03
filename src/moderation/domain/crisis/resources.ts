/** Static crisis resources (CRISIS-STATIC-1): no network, no model. Fictional fallback until 05-u09. */
export const FALLBACK_CRISIS_NOTICE =
  'If someone is in danger, contact your local emergency services now. Your text is kept; nothing is published.';

export interface StaticCrisisResources {
  /** `emergencyNotice` is the jurisdiction row's `emergency_notice`. Never throws, never empty. */
  noticeFor(emergencyNotice: string | null | undefined): string;
}

export const staticCrisisResources: StaticCrisisResources = {
  noticeFor: (n) =>
    typeof n === 'string' && n.trim() ? n : FALLBACK_CRISIS_NOTICE,
};
