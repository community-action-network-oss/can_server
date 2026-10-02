import { HttpException } from '@nestjs/common';
import type { Masked } from '../../ai-gateway/app/redaction/privacy-gateway.js';
import { ApiException } from '../../platform/errors.js';

/** The only door from raw problem text to a volunteer. Production binds PrivacyGateway.mask; tests bind a fake. */
export interface ProblemMasker {
  mask(fields: readonly { fieldRef: string; text: string }[]): Masked;
}
export const PROBLEM_MASKER = Symbol('ProblemMasker');

/** Fail closed: any masker error shows nothing. */
export function maskOrFail(
  m: ProblemMasker,
  fields: readonly { fieldRef: string; text: string }[],
): Masked {
  try {
    return m.mask(fields);
  } catch (e) {
    if (e instanceof HttpException) throw e;
    throw new ApiException(
      503,
      'review_unavailable',
      'This cannot be shown safely right now.',
    );
  }
}
