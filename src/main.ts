import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { buildDocument, configureApp } from './app.setup.js';
import { config } from './config.js';

const app = await NestFactory.create(AppModule);
configureApp(app);
SwaggerModule.setup('docs', app, buildDocument(app));
await app.listen(config.port);
