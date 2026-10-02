import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService } from '../../accounts/app/auth.service.js';
import { ApiException } from '../errors.js';
import { parseCookies, SESSION_COOKIE } from './cookies.js';
import { AUTH_KEY, PUBLIC_KEY, type AuthContext } from './decorators.js';

export type AuthedRequest = Request & { auth?: AuthContext };

/**
 * Resolves the session from Authorization: Bearer (native) or the cookie.
 * Non-GET routes need a session unless @Public(); GET routes only when @Authenticated().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets))
      return true;
    const needs =
      req.method !== 'GET' ||
      !!this.reflector.getAllAndOverride<boolean>(AUTH_KEY, targets);

    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const token = bearer ?? cookie;
    if (!token) {
      if (needs)
        throw new ApiException(401, 'unauthenticated', 'Sign in to continue.');
      return true;
    }
    try {
      const s = await this.auth.resolveSession(token);
      req.auth = { ...s, token, viaCookie: !bearer };
    } catch (e) {
      if (needs) throw e;
    }
    return true;
  }
}
