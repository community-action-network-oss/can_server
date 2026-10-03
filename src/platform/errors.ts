import {
  applyDecorators,
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  ValidationError,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { ErrorCode } from './error-codes.js';
import { log } from './logging/logger.js';

/** Throw this from any module; the filter turns it into the stable envelope. */
export class ApiException extends HttpException {
  constructor(
    status: number,
    readonly code: ErrorCode | (string & {}),
    message: string,
    readonly fieldErrors?: Record<string, string>,
    /** Additive envelope fields (for example limit, remaining, resetsAt); never personal data. */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message, status);
  }
}

export class ErrorBodyDto {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  fieldErrors?: Record<string, string>;
  @ApiPropertyOptional({ description: 'Reply limit (reply_limit_reached)' })
  limit?: number;
  @ApiPropertyOptional({ description: 'Replies left (reply_limit_reached)' })
  remaining?: number;
  @ApiPropertyOptional({
    description: 'ISO time the next slot frees (reply_limit_reached)',
  })
  resetsAt?: string;
  @ApiPropertyOptional({
    description: 'Seconds until retry is allowed (cooldown_active)',
  })
  retryAfterSeconds?: number;
}

export class ErrorResponseDto {
  @ApiProperty({ type: ErrorBodyDto }) error!: ErrorBodyDto;
}

/** Documents the shared error envelope on a route. */
export const ApiErrors = (...statuses: number[]) =>
  applyDecorators(
    ...(statuses.length ? statuses : [400, 401, 403, 404, 429, 500]).map((s) =>
      ApiResponse({ status: s, type: ErrorResponseDto }),
    ),
  );

const STATUS_CODE: Record<number, ErrorCode> = {
  400: 'validation_failed',
  401: 'unauthenticated',
  403: 'not_permitted',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
};

function flatten(
  errs: ValidationError[],
  prefix = '',
  out: Record<string, string> = {},
) {
  for (const e of errs) {
    const path = prefix + e.property;
    if (e.constraints) out[path] = Object.values(e.constraints)[0]!;
    if (e.children?.length) flatten(e.children, path + '.', out);
  }
  return out;
}

/** ValidationPipe exceptionFactory: class-validator errors keyed by field name. */
export const validationFactory = (errs: ValidationError[]) =>
  new ApiException(
    400,
    'validation_failed',
    'Request validation failed',
    flatten(errs),
  );

const isEnvelope = (b: unknown): boolean =>
  !!b &&
  typeof b === 'object' &&
  'error' in b &&
  typeof (b as { error: unknown }).error === 'object';

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let body: unknown = {
      error: { code: 'internal', message: 'Internal server error' },
    };
    if (e instanceof ApiException) {
      status = e.getStatus();
      body = {
        error: {
          code: e.code,
          message: e.message,
          ...(e.fieldErrors && { fieldErrors: e.fieldErrors }),
          ...e.extra,
        },
      };
    } else if (e instanceof HttpException) {
      status = e.getStatus();
      const raw = e.getResponse();
      // ponytail: modules that already build their own envelope (policy 503) or body (health 503) pass through; migrate them to ApiException.
      if (isEnvelope(raw) || status === 503) body = raw;
      else
        body = {
          error: {
            code:
              STATUS_CODE[status] ??
              (status >= 500 ? 'internal' : 'validation_failed'),
            message: status >= 500 ? 'Internal server error' : e.message,
          },
        };
    }
    if (status >= 500 && !(e instanceof HttpException))
      // Request id only in the log line, never the response body.
      log('error', 'unhandled', {
        requestId: res.getHeader('x-request-id'),
        kind: e instanceof Error ? e.name : typeof e,
        stack: e instanceof Error ? e.stack : undefined,
      });
    res.status(status).json(body);
  }
}
