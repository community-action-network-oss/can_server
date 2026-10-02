import { SetMetadata } from '@nestjs/common';

export const PUBLIC_KEY = 'can:public';
export const AUTH_KEY = 'can:authenticated';
export const ROLES_KEY = 'can:roles';

/** Opts a route out of the session requirement (and CSRF: there is no session to ride). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** GET routes are open unless marked; non-GET routes always need a session unless @Public(). */
export const Authenticated = () => SetMetadata(AUTH_KEY, true);
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

export interface AuthContext {
  accountId: string;
  role: string;
  handle: string;
  token: string;
  /** true when the session came from the cookie (CSRF applies). */
  viaCookie: boolean;
}
