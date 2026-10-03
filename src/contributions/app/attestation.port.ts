import { Injectable } from '@nestjs/common';

export interface Attestation {
  impactLabel: 'guest' | string;
  proofType: 'none' | string;
}

/** 14-u02 replaces the null object with the location attestation service. Failure or doubt means guest (IMPACT-1). */
export interface ContributionAttestationPort {
  attest(accountId: string, payload: unknown): Promise<Attestation>;
}
export const ATTESTATION_PORT = Symbol('ContributionAttestationPort');

@Injectable()
export class NullAttestation implements ContributionAttestationPort {
  async attest(): Promise<Attestation> {
    return { impactLabel: 'guest', proofType: 'none' };
  }
}
