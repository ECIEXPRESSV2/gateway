import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { RedisService } from '../redis/redis.service';

// In-memory record shape for fallback storage
interface MemRecord {
  count: number;
  expiresAt: number;
  blockedUntil: number;
}

// Shape returned by ThrottlerStorage
export interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

@Injectable()
export class GatewayThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(GatewayThrottlerStorage.name);
  private readonly memStore = new Map<string, MemRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(private readonly redis: RedisService) {
    // Periodically clean up expired in-memory entries
    this.cleanupInterval = setInterval(() => this.cleanupMemory(), 60_000);
    if (typeof this.cleanupInterval.unref === 'function') {
      this.cleanupInterval.unref();
    }
  }

  async increment(key: string, ttl: number, _limit: number, _blockDuration: number, _throttlerName: string): Promise<ThrottlerStorageRecord> {
    const client = this.redis.getClient();

    if (client) {
      return this.incrementRedis(client, key, ttl);
    }

    return this.incrementMemory(key, ttl);
  }

  private async incrementRedis(client: any, key: string, ttl: number): Promise<ThrottlerStorageRecord> {
    const redisKey = `gw:throttle:${key}`;
    try {
      const multi = client.multi();
      multi.incr(redisKey);
      multi.pttl(redisKey);
      const [[, count], [, pttl]] = await multi.exec() as [[null, number], [null, number]];

      if (count === 1) {
        await client.pexpire(redisKey, ttl);
      }

      const timeToExpire = pttl > 0 ? pttl : ttl;
      return {
        totalHits: count,
        timeToExpire,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    } catch (err: any) {
      this.logger.warn(`Redis throttle increment error: ${err?.message}`);
      return this.incrementMemory(key, ttl);
    }
  }

  private incrementMemory(key: string, ttl: number): ThrottlerStorageRecord {
    const now = Date.now();
    const existing = this.memStore.get(key);

    if (!existing || existing.expiresAt <= now) {
      const record: MemRecord = { count: 1, expiresAt: now + ttl, blockedUntil: 0 };
      this.memStore.set(key, record);
      return { totalHits: 1, timeToExpire: ttl, isBlocked: false, timeToBlockExpire: 0 };
    }

    existing.count += 1;
    return {
      totalHits: existing.count,
      timeToExpire: existing.expiresAt - now,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }

  private cleanupMemory(): void {
    const now = Date.now();
    for (const [key, record] of this.memStore.entries()) {
      if (record.expiresAt <= now) this.memStore.delete(key);
    }
  }
}
