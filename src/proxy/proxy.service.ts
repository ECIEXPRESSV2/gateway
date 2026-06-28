import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as httpProxy from 'http-proxy';
import type { IncomingMessage, ServerResponse } from 'node:http';

@Injectable()
export class ProxyService implements OnModuleInit {
  private readonly logger = new Logger(ProxyService.name);
  private proxy: httpProxy;

  onModuleInit() {
    this.proxy = httpProxy.createProxyServer({
      changeOrigin: true,
      selfHandleResponse: false,
      // Preserve raw body for webhooks; we rewrite Content-Length manually in proxyReq.
    });

    this.proxy.on('proxyReq', (proxyReq: http.ClientRequest, req: IncomingMessage & { rawBody?: Buffer }) => {
      const body = req.rawBody;
      if (body && body.length > 0) {
        proxyReq.setHeader('Content-Length', body.length.toString());
        proxyReq.write(body);
        proxyReq.end();
      }
    });

    this.proxy.on('error', (err: Error, _req: IncomingMessage, res: ServerResponse | net.Socket) => {
      this.logger.error(`Proxy error: ${err.message}`);
      if (res instanceof http.ServerResponse && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'BAD_GATEWAY', message: 'Upstream service unavailable' }));
      }
    });
  }

  proxyHttp(
    req: IncomingMessage,
    res: ServerResponse,
    targetBase: string,
    rewrittenPath: string,
  ): void {
    const target = new URL(targetBase);
    const options: httpProxy.ServerOptions = {
      target: {
        protocol: target.protocol,
        host: target.hostname,
        port: target.port ? parseInt(target.port, 10) : (target.protocol === 'https:' ? 443 : 80),
      },
    };

    // Override the path by rewriting req.url before handing to proxy
    (req as any).url = rewrittenPath + (req.url?.includes('?') ? '?' + req.url.split('?')[1] : '');

    this.proxy.web(req, res, options);
  }

  proxyWsUpgrade(
    req: IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    targetBase: string,
    rewrittenPath: string,
  ): void {
    // Rewrite the URL for the WebSocket upgrade
    const qs = req.url?.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
    (req as any).url = rewrittenPath + qs;

    const target = new URL(targetBase);
    this.proxy.ws(req, socket, head, {
      target: {
        protocol: target.protocol === 'https:' ? 'wss:' : 'ws:',
        host: target.hostname,
        port: target.port ? parseInt(target.port, 10) : (target.protocol === 'https:' ? 443 : 80),
      },
    }, (err) => {
      if (err) {
        this.logger.error(`WS proxy error: ${err.message}`);
        socket.destroy();
      }
    });
  }

  getProxyInstance(): httpProxy {
    return this.proxy;
  }
}
