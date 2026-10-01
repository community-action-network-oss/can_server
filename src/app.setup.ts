import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { config } from './config.js';

/** Shared by main.ts, e2e tests and the OpenAPI generator. */
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableCors({ origin: config.corsOrigins });
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
