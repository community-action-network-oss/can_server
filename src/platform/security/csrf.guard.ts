import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { ApiException } from '../errors.js';
import type { AuthedRequest } from './auth.guard.js';
import { CSRF_COOKIE, CSRF_HEADER, parseCookies } from './cookies.js';
import { PUBLIC_KEY } from './decorators.js';

const UNSAFE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Double submit: header X-CAN-CSRF must equal the can_csrf cookie. Cookie sessions only. */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!UNSAFE.has(req.method)) return true;
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ])
    )
      return true;
    if (!req.auth?.viaCookie) return true; // native bearer, or no session (auth guard decides)
    const cookie = parseCookies(req.headers.cookie)[CSRF_COOKIE] ?? '';
    const header = req.headers[CSRF_HEADER];
    const given = typeof header === 'string' ? header : '';
    const a = Buffer.from(cookie);
    const b = Buffer.from(given);
    if (!cookie || a.length !== b.length || !timingSafeEqual(a, b))
      throw new ApiException(
        403,
        'not_permitted',
        'Request could not be verified.',
      );
    return true;
  }
}
