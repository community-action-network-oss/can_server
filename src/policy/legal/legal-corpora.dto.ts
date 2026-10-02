import { ApiProperty } from '@nestjs/swagger';

/** Versions and hashes only. Never article text or the topic index. */
export class LegalCorpusVersionDto {
  @ApiProperty({ enum: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'] }) layer!: string;
  @ApiProperty() jurisdiction!: string;
  @ApiProperty() corpus_id!: string;
  @ApiProperty() version!: string;
  @ApiProperty({ description: 'pack hash (D-83)' }) hash!: string;
  @ApiProperty({ enum: ['shadow', 'canary', 'active', 'retired'] })
  state!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  activated_at!: string | null;
}

export class LegalCorporaDto {
  @ApiProperty({ type: [LegalCorpusVersionDto] })
  corpora!: LegalCorpusVersionDto[];
}
