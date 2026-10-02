export const SESSION_COOKIE = 'can_session';
export const CSRF_COOKIE = 'can_csrf';
export const CSRF_HEADER = 'x-can-csrf';

export function parseCookies(
  header: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) {
      try {
        out[k] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // malformed value: ignore the cookie
      }
    }
  }
  return out;
}
