import { Injectable, Logger, HttpException } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export interface EnrichedIdentity {
  userId: string;
  roles: string[];
  storeId: string | null;
  status: string;
}

const CACHE_KEY_PREFIX = 'gw:enrich:';

@Injectable()
export class EnrichmentService {
  private readonly logger = new Logger(EnrichmentService.name);

  constructor(private readonly redis: RedisService) {}

  async enrich(firebaseUid: string): Promise<EnrichedIdentity> {
    const cached = await this.getFromCache(firebaseUid);
    if (cached) return cached;

    const identityUrl = process.env['IDENTITY_SERVICE_URL'];
    const url = `${identityUrl}/internal/users/by-firebase/${encodeURIComponent(firebaseUid)}`;

    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: { 'x-internal': '1' } });
    } catch (err: any) {
      this.logger.error(`Failed to reach Identity service: ${err?.message}`);
      throw new HttpException('Identity service unavailable', 503);
    }

    if (response.status === 404) {
      // Propagate 404 — caller decides whether to allow sync-profile or block
      throw new HttpException({ code: 'PROFILE_NOT_FOUND', message: 'No existe un usuario local para este firebaseUid. El usuario debe ejecutar sync-profile primero.' }, 404);
    }

    if (!response.ok) {
      this.logger.error(`Identity enrichment returned ${response.status}`);
      throw new HttpException('Identity enrichment failed', 502);
    }

    const body = (await response.json()) as EnrichedIdentity;
    await this.setInCache(firebaseUid, body);
    return body;
  }

  private async getFromCache(firebaseUid: string): Promise<EnrichedIdentity | null> {
    const client = this.redis.getClient();
    if (!client) return null;
    try {
      const raw = await client.get(`${CACHE_KEY_PREFIX}${firebaseUid}`);
      if (!raw) return null;
      return JSON.parse(raw) as EnrichedIdentity;
    } catch (err: any) {
      this.logger.warn(`Cache read error: ${err?.message}`);
      return null;
    }
  }

  private async setInCache(firebaseUid: string, identity: EnrichedIdentity): Promise<void> {
    const client = this.redis.getClient();
    if (!client) return;
    const ttl = parseInt(process.env['ENRICHMENT_CACHE_TTL_SECONDS'] ?? '60', 10);
    try {
      await client.setex(`${CACHE_KEY_PREFIX}${firebaseUid}`, ttl, JSON.stringify(identity));
    } catch (err: any) {
      this.logger.warn(`Cache write error: ${err?.message}`);
    }
  }

  async invalidate(firebaseUid: string): Promise<void> {
    const client = this.redis.getClient();
    if (!client) return;
    await client.del(`${CACHE_KEY_PREFIX}${firebaseUid}`).catch(() => undefined);
  }
}
