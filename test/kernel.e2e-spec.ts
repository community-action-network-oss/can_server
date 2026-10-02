import {
  Controller,
  Get,
  INestApplication,
  Post,
  Query,
  Body,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsInt, IsString } from 'class-validator';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { ApiException } from '../src/platform/errors.js';
import { clampLimit, decodeCursor } from '../src/platform/pagination.js';

class Dto {
  @IsString() name!: string;
  @IsInt() age!: number;
}

@Controller('_kernel')
class KernelTestController {
  @Get('page')
  page(@Query('cursor') c?: string, @Query('limit') l?: string) {
    if (c) decodeCursor(c);
    return { limit: clampLimit(l) };
  }
  @Get('api') api() {
    throw new ApiException(403, 'not_permitted', 'nope');
  }
  @Get('boom') boom(): never {
    throw new Error('secret internals');
  }
  @Post('dto') dto(@Body() b: Dto) {
    return b;
  }
}

const envelope = (
  body: { error: { code: string; message: string } },
  code: string,
) => {
  expect(Object.keys(body)).toEqual(['error']);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
};

describe('shared kernel (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [KernelTestController],
    }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
  });
  afterAll(() => app.close());
  const http = () => request(app.getHttpServer());

  it('unknown route is a not_found envelope with noindex', async () => {
    const res = await http().get('/nope').expect(404);
    envelope(res.body, 'not_found');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });
  it('bad cursor is validation_failed', async () => {
    const res = await http().get('/_kernel/page?cursor=!!').expect(400);
    envelope(res.body, 'validation_failed');
    expect(res.body.error.fieldErrors.cursor).toBeDefined();
  });
  it('limit 500 becomes 50', async () => {
    const res = await http().get('/_kernel/page?limit=500').expect(200);
    expect(res.body.limit).toBe(50);
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });
  it('ApiException keeps its status and code', async () => {
    const res = await http().get('/_kernel/api').expect(403);
    envelope(res.body, 'not_permitted');
  });
  it('dto errors carry fieldErrors by field name', async () => {
    const res = await http()
      .post('/_kernel/dto')
      .send({ age: 'x', extra: 1 })
      .expect(400);
    envelope(res.body, 'validation_failed');
    expect(Object.keys(res.body.error.fieldErrors).sort()).toEqual([
      'age',
      'extra',
      'name',
    ]);
  });
  it('unknown errors are 500 internal with no stack or detail', async () => {
    const res = await http().get('/_kernel/boom').expect(500);
    envelope(res.body, 'internal');
    expect(JSON.stringify(res.body)).not.toMatch(/secret|stack|at /);
  });
});
