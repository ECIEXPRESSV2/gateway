import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { WsProxyService } from './proxy/ws-proxy.service';
import * as http from 'node:http';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: ['error', 'warn', 'log'],
  });

  const corsOrigins = process.env['CORS_ORIGINS'];
  app.enableCors({
    origin: corsOrigins ? corsOrigins.split(',').map((o) => o.trim()) : '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Session-Id',
      'Idempotency-Key',
      'x-correlation-id',
      // El cliente puede enviar estos headers de identidad (clientes en migración
      // al modo gateway). El gateway SIEMPRE los descarta y reinyecta los reales
      // (ver header-injector.stripIdentityHeaders), así que permitirlos en CORS no
      // tiene impacto de seguridad; solo evita que el preflight del navegador
      // bloquee la petición cross-origin (frontend :5173 → gateway :3000).
      'x-user-id',
      'x-user-role',
      'x-user-store',
    ],
    credentials: true,
  });

  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  await app.listen(port, '0.0.0.0');

  // Set up WebSocket proxying (orders /communication + notifications /)
  // Must be done after listen() so the underlying HTTP server exists.
  const httpServer = app.getHttpServer() as http.Server;
  const wsProxy = app.get(WsProxyService);
  wsProxy.setupWsProxy(httpServer);

  console.log(`API Gateway listening on 0.0.0.0:${port}`);
}

bootstrap().catch((err) => {
  console.error('Fatal: Gateway failed to start', err);
  process.exit(1);
});
