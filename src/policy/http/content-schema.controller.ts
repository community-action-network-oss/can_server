import {
  Controller,
  Get,
  HttpException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ContentSchemaRegistry } from '../app/content-schema-registry.js';
import { ContentSchemaNotFound, PolicyUnavailable } from '../domain/pack.js';
import {
  ContentSchemaDto,
  ContentSchemaQueryDto,
  ErrorEnvelopeDto,
} from './content-schema.dto.js';

const fail = (status: number, code: string, message: string) =>
  new HttpException({ error: { code, message } }, status);

@ApiTags('policy')
@Controller('v1/content-schemas')
export class ContentSchemaController {
  constructor(private readonly registry: ContentSchemaRegistry) {}

  @Get(':type')
  @ApiOperation({
    operationId: 'getContentSchema',
    summary: 'Active content schema for a type',
  })
  @ApiOkResponse({ type: ContentSchemaDto })
  @ApiNotFoundResponse({ type: ErrorEnvelopeDto })
  @ApiServiceUnavailableResponse({ type: ErrorEnvelopeDto })
  get(
    @Param('type') type: string,
    @Query() q: ContentSchemaQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): ContentSchemaDto {
    try {
      const out = this.registry.get(type, {
        jurisdiction: q.jurisdiction,
        version: q.version,
      });
      res.setHeader('ETag', `"${out.schema_hash}"`);
      res.setHeader('Cache-Control', 'no-cache');
      return out;
    } catch (e) {
      if (e instanceof ContentSchemaNotFound)
        throw fail(404, 'not_found', e.message);
      if (e instanceof PolicyUnavailable)
        throw fail(503, 'policy_unavailable', e.message);
      throw e;
    }
  }
}
