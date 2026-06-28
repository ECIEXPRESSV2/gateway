import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;

  onModuleInit() {
    const url = process.env['REDIS_URL'];
    if (!url) {
      this.logger.warn('REDIS_URL not set — Redis disabled. Rate limiting and enrichment cache will use in-memory fallback.');
      return;
    }

    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });

    this.client.on('error', (err) => {
      this.logger.warn(`Redis connection error (degrading to memory): ${err.message}`);
    });

    this.client.connect().catch((err) => {
      this.logger.warn(`Redis connect failed (degrading to memory): ${err.message}`);
      this.client = null;
    });
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit().catch(() => undefined);
    }
  }

  getClient(): Redis | null {
    if (!this.client || this.client.status !== 'ready') return null;
    return this.client;
  }

  isAvailable(): boolean {
    return this.client !== null && this.client.status === 'ready';
  }
}
