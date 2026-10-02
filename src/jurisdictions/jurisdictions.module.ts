import { Controller, Get, Header, Inject, Module } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { asc, eq } from 'drizzle-orm';
import { DB, type Db } from '../db/db.module.js';
import { jurisdiction } from '../db/schema.js';
import { ApiErrors } from '../platform/errors.js';

export class JurisdictionDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() kind!: string;
  @ApiProperty() isFictional!: boolean;
  @ApiProperty({ type: String, nullable: true }) emergencyNotice!:
    string | null;
}
export class JurisdictionListDto {
  @ApiProperty({ type: [JurisdictionDto] }) items!: JurisdictionDto[];
}

@ApiTags('jurisdictions')
@Controller('v1/jurisdictions')
export class JurisdictionsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({
    operationId: 'listJurisdictions',
    summary: 'Enabled jurisdictions, by name',
  })
  @ApiOkResponse({ type: JurisdictionListDto })
  @ApiErrors(429, 500)
  async list(): Promise<JurisdictionListDto> {
    const items = await this.db
      .select({
        id: jurisdiction.id,
        name: jurisdiction.name,
        kind: jurisdiction.kind,
        isFictional: jurisdiction.isFictional,
        emergencyNotice: jurisdiction.emergencyNotice,
      })
      .from(jurisdiction)
      .where(eq(jurisdiction.enabled, true))
      .orderBy(asc(jurisdiction.name), asc(jurisdiction.id));
    return { items };
  }
}

@Module({ controllers: [JurisdictionsController] })
export class JurisdictionsModule {}
