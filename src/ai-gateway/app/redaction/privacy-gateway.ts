import { Inject, Injectable } from '@nestjs/common';
import { DB, type Db } from '../../../db/db.module.js';
import { AuditPort } from '../../../platform/audit/audit.service.js';
import { CLOCK, type Clock } from '../../../platform/ports.js';
import type { GatewayField } from '../../domain/types.js';
import { TokenStore } from '../../infra/token-store.js';
import { classify, type ZonedField } from '../zones.js';
import { PrivacyGatewayError } from './errors.js';
import { expand, redact, type RedactedSpan } from './redact.js';

export interface PrepareInput {
  /** The operation the tokens belong to: the moderation run id (uuid). */
  runId: string;
  dpId: string | null;
  stage: string;
  providerId: string;
  fields: readonly ZonedField[];
}

export interface Prepared {
  /** Sanitized, ready for GatewayInput.fields. */
  fields: GatewayField[];
  /** Per field: the replaced spans as offsets into the ORIGINAL text. Safe to store. */
  spans: Record<string, RedactedSpan[]>;
  redactionCount: number;
}

export interface Masked {
  fields: GatewayField[];
  spans: Record<string, RedactedSpan[]>;
  redactionCount: number;
}

/** Front half of the AI gateway (PRIV-GATEWAY-1): zone check, redaction, token store, audit event. */
@Injectable()
export class PrivacyGateway {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly tokens: TokenStore,
    private readonly audit: AuditPort,
  ) {}

  /**
   * Sanitize fields for one model call. Fail closed: any error (zone, redaction, store, audit) throws and
   * nothing is returned, so the caller holds the run. Writes the mapping and the audit event in one transaction.
   */
  async prepare(i: PrepareInput): Promise<Prepared> {
    try {
      const texts = i.fields.map((f) => ({
        fieldRef: f.fieldRef,
        text: classify(f),
      }));
      const r = redact(texts);
      await this.db.transaction(async (tx) => {
        await this.tokens.put(tx, i.runId, r.entries, this.clock.now());
        await this.audit.record(tx, {
          action: 'ai.gateway.call',
          subjectType: 'moderation_run',
          subjectId: i.runId,
          detail: {
            runId: i.runId,
            dpId: i.dpId,
            stage: i.stage,
            zone: 'sanitized',
            redactionCount: r.redactionCount,
            providerId: i.providerId,
          },
        });
      });
      return {
        fields: r.fields.map((f) => ({ fieldRef: f.fieldRef, text: f.text })),
        spans: Object.fromEntries(r.fields.map((f) => [f.fieldRef, f.spans])),
        redactionCount: r.redactionCount,
      };
    } catch (e) {
      if (e instanceof PrivacyGatewayError) throw e;
      throw new PrivacyGatewayError(
        'gateway_failure',
        'privacy gateway failed',
      );
    }
  }

  /**
   * Masked view for volunteers (12-u03): same redaction, no model call, so nothing is stored or audited
   * and the originals are discarded. Throws `gateway_failure` if it cannot mask with certainty;
   * the caller then shows nothing rather than raw text.
   */
  mask(fields: readonly { fieldRef: string; text: string }[]): Masked {
    const r = redact(fields);
    return {
      fields: r.fields.map((f) => ({ fieldRef: f.fieldRef, text: f.text })),
      spans: Object.fromEntries(r.fields.map((f) => [f.fieldRef, f.spans])),
      redactionCount: r.redactionCount,
    };
  }

  /** Put originals back into text that came from the model (a hint). Only for the person who owns the content. */
  async reexpand(
    runId: string,
    text: string,
    ownsContent: boolean,
  ): Promise<string> {
    if (!ownsContent) return text;
    return expand(text, await this.tokens.resolve(runId, this.clock.now()));
  }
}
