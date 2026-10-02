import { randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import { config } from '../../config.js';
import { ApiErrors, ApiException } from '../../platform/errors.js';
import type { AuthedRequest } from '../../platform/security/auth.guard.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
} from '../../platform/security/cookies.js';
import { Authenticated, Public } from '../../platform/security/decorators.js';
import {
  RATE_LIMITER,
  type RateLimiter,
} from '../../platform/security/rate-limiter.js';
import { AuthService } from '../app/auth.service.js';
import { hashToken } from '../infra/crypto.js';
import {
  CodeRequestedDto,
  HandleDto,
  MeDto,
  RequestCodeDto,
  SignUpDto,
  SignUpResponseDto,
  VerifyDto,
  VerifyResponseDto,
} from './auth.dto.js';

const WINDOW = 10 * 60_000;
const EMAIL_LIMIT = 5;
const IP_LIMIT = 20;
const DAY = 86_400_000;

const isNative = (req: Request) => req.headers['x-can-client'] === 'native';

@ApiTags('auth')
@Controller('v1')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  /** Per email (hashed, never stored raw) and per IP. Over the limit: 429 + Retry-After. */
  private async limit(req: Request, res: Response, email: string) {
    // email is already validated; hash so the limiter never holds an address
    const key = `email:${hashToken(email.trim().toLowerCase()).toString('hex')}`;
    const ok =
      (await this.limiter.hit(key, EMAIL_LIMIT, WINDOW)) &&
      (await this.limiter.hit(`ip:${req.ip ?? 'unknown'}`, IP_LIMIT, WINDOW));
    if (!ok) {
      res.setHeader('Retry-After', String(WINDOW / 1000));
      throw new ApiException(
        429,
        'rate_limited',
        'Too many attempts. Try again later.',
      );
    }
  }

  @Public()
  @Post('auth/signup')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'signUp',
    summary: 'Sign up with an invite; a code is mailed',
  })
  @ApiOkResponse({ type: SignUpResponseDto })
  @ApiErrors()
  async signUp(
    @Body() body: SignUpDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignUpResponseDto> {
    await this.limit(req, res, body.email);
    return this.auth.signUp(body);
  }

  @Public()
  @Post('auth/code')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'requestCode',
    summary: 'Ask for a sign-in code',
  })
  @ApiOkResponse({ type: CodeRequestedDto })
  @ApiErrors()
  async requestCode(
    @Body() body: RequestCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CodeRequestedDto> {
    await this.limit(req, res, body.email);
    await this.auth.requestCode(body);
    return { message: 'If that address can sign in, we sent a code' };
  }

  @Public()
  @Post('auth/verify')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'verifyCode',
    summary: 'Exchange a code for a session',
  })
  @ApiHeader({
    name: 'X-CAN-Client',
    required: false,
    description: '"native" returns the token in the body and sets no cookies.',
  })
  @ApiOkResponse({ type: VerifyResponseDto })
  @ApiErrors()
  async verifyCode(
    @Body() body: VerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VerifyResponseDto> {
    await this.limit(req, res, body.email);
    const native = isNative(req);
    const out = await this.auth.verifyCode({
      ...body,
      clientKind: native ? 'native' : 'web',
    });
    if (native) return out;
    const base: CookieOptions = {
      sameSite: 'lax',
      secure: config.cookieSecure,
      maxAge: config.sessionAbsoluteDays * DAY,
    };
    res.cookie(SESSION_COOKIE, out.token, {
      ...base,
      httpOnly: true,
      path: '/v1',
    });
    res.cookie(CSRF_COOKIE, randomBytes(32).toString('base64url'), {
      ...base,
      httpOnly: false,
      path: '/',
    });
    return { handle: out.handle, role: out.role };
  }

  @Post('auth/logout')
  @HttpCode(204)
  @ApiOperation({ operationId: 'logout', summary: 'End the current session' })
  @ApiNoContentResponse()
  @ApiErrors()
  async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(req.auth!.token);
    res.clearCookie(SESSION_COOKIE, { path: '/v1' });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
  }

  @Get('me')
  @Authenticated()
  @ApiOperation({
    operationId: 'getMe',
    summary: 'The signed-in account (handle and role only)',
  })
  @ApiOkResponse({ type: MeDto })
  @ApiErrors()
  me(@Req() req: AuthedRequest): MeDto {
    return { handle: req.auth!.handle, role: req.auth!.role };
  }

  @Post('me/handle/regenerate')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'regenerateHandle',
    summary: 'Get a new generated handle (once)',
  })
  @ApiOkResponse({ type: HandleDto })
  @ApiErrors()
  regenerateHandle(@Req() req: AuthedRequest): Promise<HandleDto> {
    return this.auth.regenerateHandle(req.auth!.accountId);
  }
}
