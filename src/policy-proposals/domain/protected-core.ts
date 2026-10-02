/** Ids touched by a proposal that are in the active pack's protected core, sorted, no duplicates. */
export function protectedHits(
  touched: readonly string[],
  protectedCore: readonly string[],
): string[] {
  const core = new Set(protectedCore);
  return [...new Set(touched.filter((id) => core.has(id)))].sort();
}

export const PROTECTED_CORE_TEXT =
  'This change touches the protected core (constitution I.2). Protected-core rules change only through the constitutional amendment process (VIII.2), not a policy proposal.';
