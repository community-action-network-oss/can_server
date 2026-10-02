import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiException } from '../errors.js';
import type { AuthedRequest } from './auth.guard.js';
import { ROLES_KEY } from './decorators.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!roles?.length) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.auth || !roles.includes(req.auth.role))
      throw new ApiException(403, 'not_permitted', 'You cannot do that.');
    return true;
  }
}
