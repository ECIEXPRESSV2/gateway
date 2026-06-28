import {
  Controller,
  All,
  Req,
  Res,
  HttpException,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { GatewayThrottlerGuard } from '../throttle/throttle.guard';
import { FirebaseService } from '../firebase/firebase.service';
import { EnrichmentService } from '../enrichment/enrichment.service';
import { ProxyService } from './proxy.service';
import {
  isBlockedPath,
  isPublicPath,
  isSyncProfilePath,
  resolveService,
  rewritePath,
} from './route-config';
import { injectHeaders, injectPublicHeaders, stripIdentityHeaders, ensureCorrelationId } from './header-injector';

@Controller()
@UseGuards(GatewayThrottlerGuard)
export class ProxyController {
  private readonly logger = new Logger(ProxyController.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly enrichment: EnrichmentService,
    private readonly proxy: ProxyService,
  ) {}

  @All('*path')
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const path = req.path;
    const method = req.method;

    // ── Step 1: Block internal/service-to-service routes ─────────────────────
    if (isBlockedPath(path)) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
      return;
    }

    // ── Step 2: Resolve target service ───────────────────────────────────────
    const resolved = resolveService(path);
    if (!resolved) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
      return;
    }
    const { service, targetBase } = resolved;
    const rewritten = rewritePath(service, path);

    // ── Step 3: Public routes — proxy without auth ────────────────────────────
    if (isPublicPath(path, method)) {
      injectPublicHeaders(req as any);
      this.proxy.proxyHttp(req as any, res as any, targetBase, rewritten);
      return;
    }

    // ── Step 4: Semi-public: sync-profile — validate token, forward Bearer ────
    // The user may not have a local profile yet (first login).
    // Identity handles the token directly; we do NOT enrich.
    if (isSyncProfilePath(path, method)) {
      const token = this.extractBearerToken(req);
      if (!token) {
        res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authorization header required' });
        return;
      }
      try {
        await this.firebase.verifyIdToken(token);
      } catch {
        res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or expired Firebase token' });
        return;
      }
      // Strip spoofed headers, add correlation ID, forward Bearer for Identity
      stripIdentityHeaders(req as any);
      ensureCorrelationId(req as any);
      req.headers['authorization'] = `Bearer ${token}`;
      this.proxy.proxyHttp(req as any, res as any, targetBase, rewritten);
      return;
    }

    // ── Step 5: All protected routes — validate token ─────────────────────────
    const token = this.extractBearerToken(req);
    if (!token) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authorization header required' });
      return;
    }

    let firebaseUid: string;
    try {
      const decoded = await this.firebase.verifyIdToken(token);
      firebaseUid = decoded.uid;
    } catch {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or expired Firebase token' });
      return;
    }

    // ── Step 6: Enrich (firebaseUid → local identity) ─────────────────────────
    let identity: { userId: string; roles: string[]; storeId: string | null; status: string };
    try {
      identity = await this.enrichment.enrich(firebaseUid);
    } catch (err: any) {
      if (err instanceof HttpException) {
        const status = err.getStatus();
        if (status === 404) {
          // User validated Firebase token but hasn't run sync-profile yet.
          res.status(403).json({
            code: 'PROFILE_NOT_FOUND',
            message: 'No existe un perfil local para este usuario. Ejecuta POST /identity/auth/sync-profile primero.',
          });
          return;
        }
      }
      this.logger.error(`Enrichment failed: ${err?.message}`);
      res.status(502).json({ code: 'ENRICHMENT_FAILED', message: 'Could not retrieve user identity' });
      return;
    }

    // ── Step 7: Reject inactive users ─────────────────────────────────────────
    if (identity.status !== 'ACTIVE') {
      res.status(403).json({
        code: 'USER_INACTIVE',
        status: identity.status,
        message: `Tu cuenta está ${identity.status}. Contacta al administrador.`,
      });
      return;
    }

    // ── Step 8: Inject headers per service ────────────────────────────────────
    injectHeaders(req as any, service, identity, token);

    // ── Step 9: Proxy HTTP ────────────────────────────────────────────────────
    this.proxy.proxyHttp(req as any, res as any, targetBase, rewritten);
  }

  private extractBearerToken(req: Request): string | null {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return null;
    return auth.slice(7).trim() || null;
  }
}
