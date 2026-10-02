import { parseYaml, type Yaml } from './yaml.js';
import {
  ENFORCEMENT,
  PackRefused,
  TIERS,
  type Enforcement,
  type Rule,
  type Tier,
} from './pack.js';

export interface ParsedRules {
  rules: Rule[];
  protectedCore: string[];
}

export function parseRules(yaml: string, source: string): ParsedRules {
  const doc = parseYaml(yaml) as {
    rules?: Record<string, Yaml>[];
    protected_core?: string[];
  } | null;
  const rules = (doc?.rules ?? []).map((r) => {
    const tier = r.tier as Tier;
    const enforcement = r.enforcement as Enforcement;
    if (
      typeof r.id !== 'string' ||
      !TIERS.includes(tier) ||
      !ENFORCEMENT.includes(enforcement)
    )
      throw new PackRefused(
        `${source}: malformed rule ${JSON.stringify(r.id)}`,
      );
    return { id: r.id, tier, enforcement, text: String(r.text ?? ''), source };
  });
  return { rules, protectedCore: doc?.protected_core ?? [] };
}

/**
 * Merge layers (base first) by rule id, stricter wins. A lower layer may add rules or raise
 * enforcement; it may not lower enforcement, move a rule's tier, or touch a protected_core rule.
 */
export function resolveLayers(
  layers: { name: string; parsed: ParsedRules }[],
): {
  rules: Rule[];
  protectedCore: string[];
} {
  const merged = new Map<string, Rule>();
  const protectedCore = new Set<string>();
  for (const [n, { name, parsed }] of layers.entries()) {
    for (const r of parsed.rules) {
      const prev = merged.get(r.id);
      if (prev) {
        if (protectedCore.has(r.id))
          throw new PackRefused(`${name}: touches protected core rule ${r.id}`);
        if (n === 0) throw new PackRefused(`${name}: duplicate rule ${r.id}`);
        if (r.tier !== prev.tier)
          throw new PackRefused(`${name}: changes tier of rule ${r.id}`);
        if (
          ENFORCEMENT.indexOf(r.enforcement) <
          ENFORCEMENT.indexOf(prev.enforcement)
        )
          throw new PackRefused(
            `${name}: weakens rule ${r.id} (${prev.enforcement} to ${r.enforcement})`,
          );
      }
      merged.set(r.id, r);
    }
    if (n === 0) parsed.protectedCore.forEach((id) => protectedCore.add(id));
    else if (parsed.protectedCore.length)
      throw new PackRefused(
        `${name}: only the base pack may list protected_core`,
      );
  }
  for (const id of protectedCore)
    if (!merged.has(id))
      throw new PackRefused(`protected_core lists unknown rule ${id}`);
  const rules = [...merged.values()].sort(
    (a, b) =>
      TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || (a.id < b.id ? -1 : 1),
  );
  return { rules, protectedCore: [...protectedCore].sort() };
}
