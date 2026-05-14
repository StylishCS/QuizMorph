import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { Logger, ValidationPipe, type LogLevel } from '@nestjs/common';
import { AppModule } from './app.module';

function apiLogLevels(): LogLevel[] {
  const explicit = process.env.API_LOG_LEVEL?.trim();
  if (explicit) {
    const allowed: LogLevel[] = ['error', 'warn', 'log', 'debug', 'verbose'];
    const parts = explicit
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is LogLevel => (allowed as string[]).includes(s));
    if (parts.length) return parts;
  }
  if (process.env.NODE_ENV === 'production') {
    return ['error', 'warn', 'log'];
  }
  return ['error', 'warn', 'log', 'debug', 'verbose'];
}

async function bootstrap() {
  const levels = apiLogLevels();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 50 * 1024 * 1024 }),
    { logger: levels },
  );
  const boot = new Logger('Bootstrap');
  boot.log(`API logger levels: ${levels.join(', ')} (set API_LOG_LEVEL=e.g. log,warn,error,debug to override)`);

  // @ts-expect-error Duplicate fastify installations (Nest bundles one; @fastify/multipart types target hoisted fastify).
  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 },
  });
  const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
  app.enableCors({
    origin: corsOrigin,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = Number(process.env.API_PORT ?? 3001);
  const host = process.env.API_HOST ?? '0.0.0.0';
  await app.listen(port, host);
}

bootstrap();
