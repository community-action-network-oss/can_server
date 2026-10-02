import { NEWS_HOSTS, OFFICIAL_SUFFIXES } from './hosts.js';

export type EvidenceCategory = 'official_page' | 'news' | 'other';
export type UrlResult =
  | { ok: true; normalized: string; category: EvidenceCategory }
  | { ok: false; reason: string };

export const MAX_URL_LENGTH = 2048;
const TRACKING = /^(?:utm_.*|fbclid)$/i;

/** EVID-URL-1: URL only, no upload. IP literals and punycode hosts are refused outright (stricter than private-only). */
export function checkEvidenceUrl(raw: string, opts: { allowHttp?: boolean } = {}): UrlResult {
  const bad = (reason: string): UrlResult => ({ ok: false, reason });
  const s = raw.trim();
  if (s.length === 0 || s.length > MAX_URL_LENGTH) return bad('length');
  let u: URL;
  try { u = new URL(s); } catch { return bad('unparseable'); }
  if (u.protocol !== 'https:' && !(opts.allowHttp && u.protocol === 'http:')) return bad('scheme');
  if (u.username || u.password) return bad('credentials');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || /^[\d.]+$/.test(host) || /^0x/i.test(host.split('.').pop()!)) return bad('ip_literal');
  if (!host.includes('.')) return bad('host');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return bad('local_host');
  if (host.split('.').some((l) => l.startsWith('xn--'))) return bad('punycode');
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.hostname = host;
  const category: EvidenceCategory = OFFICIAL_SUFFIXES.some((x) => host.endsWith(x))
    ? 'official_page'
    : NEWS_HOSTS.some((h) => host === h || host.endsWith('.' + h)) ? 'news' : 'other';
  return { ok: true, normalized: u.toString(), category };
}
