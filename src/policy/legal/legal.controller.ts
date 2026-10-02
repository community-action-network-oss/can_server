import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LegalRegistry } from './registry.js';
import { LegalCorporaDto } from './legal-corpora.dto.js';

@ApiTags('policy')
@Controller('v1/legal')
export class LegalController {
  constructor(private readonly registry: LegalRegistry) {}

  @Get('corpora')
  @ApiOperation({
    operationId: 'listLegalCorpora',
    summary: 'Legal corpus versions and hashes (no text)',
  })
  @ApiOkResponse({ type: LegalCorporaDto })
  async list(): Promise<LegalCorporaDto> {
    const rows = await this.registry.list();
    return {
      corpora: rows.map((r) => ({
        layer: r.layer,
        jurisdiction: r.jurisdiction,
        corpus_id: r.corpusId,
        version: r.version,
        hash: r.hash,
        state: r.state,
        activated_at: r.activatedAt?.toISOString() ?? null,
      })),
    };
  }
}
