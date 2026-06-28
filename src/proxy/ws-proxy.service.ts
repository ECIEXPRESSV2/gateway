// WS-AUTH: Estado del routing y autenticación WebSocket.
//
// RESUELTO — Routing entre servicios:
//   Cada servicio Socket.IO usa un path propio en vez del default /socket.io:
//     Orders:        path = /orders/socket.io
//     Notifications: path = /notifications/socket.io
//   El HTTP upgrade llega con ese path en la URL, por lo que el gateway puede
//   distinguir a qué servicio rutear sin ambigüedad. El token se valida con
//   ?token= en la query del upgrade (enviado por el cliente con query: { token }).
//
// LIMITACIÓN RESIDUAL — Doble autenticación en Orders:
//   El gateway valida el token desde ?token= durante el HTTP upgrade (capa TCP).
//   Después del upgrade, Socket.IO envía auth: { token } en el paquete CONNECT
//   (datos WS, transparente al gateway). Orders service valida ese auth.token con
//   identity-service como segunda verificación. En prod (vía gateway) la validación
//   del gateway es suficiente; la de Orders es redundante pero inofensiva.
//   Para eliminar la redundancia: añadir AUTH_DISABLED=true en el entorno de Orders
//   cuando está detrás del gateway y usar socket.handshake.query.userId (inyectado
//   y verificado por el gateway) en vez de re-validar el token.
//
// LIMITACIÓN RESIDUAL — Reconexión con token expirado:
//   Si Socket.IO reconecta automáticamente (red caída) y el token de 1h ya expiró,
//   el gateway rechaza la reconexión con 401. El cliente debe obtener un nuevo token
//   antes de reconectar. Socket.IO no tiene hook nativo para refrescar el token en
//   el query antes de reconectar; solución: deshabilitar autoConnect y reconectar
//   manualmente tras refresh de token.

import { Injectable, Logger } from '@nestjs/common';
import * as http from 'node:http';
import * as net from 'node:net';
import { URL } from 'node:url';
import { FirebaseService } from '../firebase/firebase.service';
import { EnrichmentService } from '../enrichment/enrichment.service';
import { ProxyService } from './proxy.service';

@Injectable()
export class WsProxyService {
  private readonly logger = new Logger(WsProxyService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly enrichment: EnrichmentService,
    private readonly proxy: ProxyService,
  ) {}

  setupWsProxy(server: http.Server): void {
    server.on('upgrade', async (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      const rawUrl = req.url ?? '/';
      const parsedUrl = new URL(rawUrl, 'http://localhost');
      const pathname = parsedUrl.pathname;

      let targetBase: string | undefined;
      let rewrittenPath: string;

      // Match by the custom Socket.IO path each service was configured with.
      // Clients connect with { path: '/orders/socket.io' } or { path: '/notifications/socket.io' };
      // the HTTP upgrade URL therefore starts with that path, making service routing unambiguous.
      // The path is forwarded as-is to the downstream service (no prefix stripping) because
      // each service listens at its own custom path, not at the default /socket.io.
      if (pathname.startsWith('/orders/socket.io')) {
        targetBase = process.env['ORDERS_SERVICE_URL'];
        rewrittenPath = pathname; // Orders service listens at /orders/socket.io
      } else if (pathname.startsWith('/notifications/socket.io')) {
        targetBase = process.env['NOTIFICATIONS_SERVICE_URL'];
        rewrittenPath = pathname; // Notifications service listens at /notifications/socket.io
      } else {
        // Not a WebSocket route we manage; let NestJS handle or ignore
        return;
      }

      if (!targetBase) {
        this.logger.error('Target service URL not configured for WS route');
        this.rejectSocket(socket, 503, 'Service Unavailable');
        return;
      }

      // Extract token from query param ?token=...
      // See TODO(ws-auth) above: Socket.IO sends auth.token in the CONNECT packet,
      // not in the HTTP upgrade request. We only support ?token= query param here.
      const token = parsedUrl.searchParams.get('token');

      if (!token) {
        this.logger.warn(`WS connection rejected: no ?token= in ${pathname}`);
        this.rejectSocket(socket, 401, 'Unauthorized: token required in ?token= query param');
        return;
      }

      let firebaseUid: string;
      try {
        const decoded = await this.firebase.verifyIdToken(token);
        firebaseUid = decoded.uid;
      } catch {
        this.logger.warn(`WS connection rejected: invalid Firebase token for ${pathname}`);
        this.rejectSocket(socket, 401, 'Unauthorized: invalid token');
        return;
      }

      let identity: { userId: string; status: string };
      try {
        identity = await this.enrichment.enrich(firebaseUid);
      } catch (err: any) {
        const status = err?.getStatus?.() ?? 500;
        if (status === 404) {
          this.rejectSocket(socket, 403, 'Forbidden: user profile not found');
        } else {
          this.rejectSocket(socket, 502, 'Bad Gateway: enrichment failed');
        }
        return;
      }

      if (identity.status !== 'ACTIVE') {
        this.logger.warn(`WS rejected: user not ACTIVE (${identity.status})`);
        this.rejectSocket(socket, 403, `Forbidden: user is ${identity.status}`);
        return;
      }

      // Inject userId into the query string so the downstream service picks it up.
      // For Notifications: replaces the insecure ?userId= query param with the verified one.
      parsedUrl.searchParams.set('userId', identity.userId);
      parsedUrl.searchParams.delete('token'); // don't forward the Firebase token downstream

      const finalPath = parsedUrl.pathname + '?' + parsedUrl.searchParams.toString();
      (req as any).url = finalPath;

      this.proxy.proxyWsUpgrade(req, socket, head, targetBase, rewrittenPath);
    });
  }

  private rewriteWsPath(servicePrefix: string, pathname: string): string {
    if (pathname === servicePrefix) return '/';
    if (pathname.startsWith(`${servicePrefix}/`)) return pathname.slice(servicePrefix.length);
    return pathname;
  }

  private rejectSocket(socket: net.Socket, statusCode: number, message: string): void {
    const statusText = statusCode === 401 ? 'Unauthorized' : statusCode === 403 ? 'Forbidden' : 'Error';
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${message}`,
    );
    socket.destroy();
  }
}
