import type { GatewayOutput, GatewayOutputFields } from './types.js';

/** Mint a GatewayOutput. Only src/ai-gateway/app/prompt-builder.ts may call this (test/architecture). */
export const mintGatewayOutput = (v: GatewayOutputFields): GatewayOutput =>
  Object.freeze({ ...v }) as unknown as GatewayOutput;
