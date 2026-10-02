import { PrivacyGatewayError } from './redaction/errors.js';

/** Spec 14 data zones. Only `sanitized` text may enter a GatewayOutput, and only redaction produces it. */
export type Zone =
  'transient_raw' | 'restricted_evidence' | 'sanitized' | 'public' | 'audit';

/** Draft or member text, or published text: redacted before use. */
export interface RawField {
  zone: 'transient_raw' | 'public';
  fieldRef: string;
  text: string;
}

/** Restricted evidence contributes its tier and a description, never its content. */
export interface EvidenceField {
  zone: 'restricted_evidence';
  fieldRef: string;
  tier: string;
  description: string;
}

/** Anything else (audit, or a caller claiming `sanitized`) is refused by `classify`. */
export type ZonedField = RawField | EvidenceField;

const TIER = /^[A-Za-z0-9_-]{1,32}$/;

/** Throws `zone_violation` for a field that may not enter a model request. Returns the text to redact. */
export function classify(f: ZonedField): string {
  const z = (f as { zone?: string }).zone;
  if (z === 'transient_raw' || z === 'public') {
    if (typeof (f as RawField).text !== 'string')
      throw new PrivacyGatewayError('zone_violation', `${f.fieldRef}: no text`);
    return (f as RawField).text;
  }
  if (z === 'restricted_evidence') {
    const e = f as EvidenceField & Record<string, unknown>;
    // Content, text or any extra payload on restricted evidence is a bug in the caller.
    const extra = Object.keys(e).filter(
      (k) => !['zone', 'fieldRef', 'tier', 'description'].includes(k),
    );
    if (extra.length || !TIER.test(e.tier) || typeof e.description !== 'string')
      throw new PrivacyGatewayError(
        'zone_violation',
        `${f.fieldRef}: restricted evidence carries only tier and description`,
      );
    return `tier ${e.tier}: ${e.description}`;
  }
  throw new PrivacyGatewayError(
    'zone_violation',
    `${f.fieldRef}: zone ${String(z)} may not enter a model request`,
  );
}
