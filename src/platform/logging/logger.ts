import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const SENSITIVE =
  /email|code|token|cookie|authorization|password|secret|body|statement|narrative/i;

/** Masks values of sensitive keys at any depth (arrays and objects). */
export function redact(value: unknown, key = ''): unknown {
  if (SENSITIVE.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redact(v, k)]),
    );
  return value;
}

export type Sink = (line: string) => void;
const stdout: Sink = (line) => process.stdout.write(line + '\n');

export function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  fields: Record<string, unknown> = {},
  sink: Sink = stdout,
): void {
  sink(
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      msg,
      ...(redact(fields) as object),
    }),
  );
}

/** Reads or generates X-Request-Id, echoes it, logs one line per request (no headers or bodies). */
export function requestLogger(sink: Sink = stdout) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header('x-request-id');
    // Cap length and charset so a caller cannot inject into logs.
    const requestId =
      incoming && /^[\w.-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route?.path
        ? `${req.baseUrl}${req.route.path}`
        : 'unmatched';
      log(
        'info',
        'request',
        {
          requestId,
          method: req.method,
          route,
          status: res.statusCode,
          ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
        },
        sink,
      );
    });
    next();
  };
}
