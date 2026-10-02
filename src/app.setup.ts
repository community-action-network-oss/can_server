import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { config } from './config.js';
import { ErrorFilter, validationFactory } from './platform/errors.js';
import { requestLogger } from './platform/logging/logger.js';

/** Shared by main.ts, e2e tests and the OpenAPI generator. */
export function configureApp(app: INestApplication): void {
  // Silent under tests; production and dev log one JSON line per request.
  if (config.nodeEnv !== 'test') app.use(requestLogger());
  app.use(
    (
      _req: unknown,
      res: { setHeader(k: string, v: string): void },
      next: () => void,
    ) => {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      next();
    },
  );
  app.useGlobalFilters(new ErrorFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      exceptionFactory: validationFactory,
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  if (config.trustProxy) (app as NestExpressApplication).set('trust proxy', 1);
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-CAN-CSRF',
      'X-CAN-Client',
    ],
  });
  app.enableShutdownHooks();
}

export function buildDocument(app: INestApplication): OpenAPIObject {
  const options = new DocumentBuilder()
    .setTitle('CAN server')
    .setDescription('Community Action Network node API')
    .setVersion('0.1.0')
    .build();
  return SwaggerModule.createDocument(app, options, {
    operationIdFactory: (_controller, method) => method,
  });
}
