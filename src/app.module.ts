import { Module } from '@nestjs/common';
import { FirebaseModule } from './firebase/firebase.module';
import { RedisModule } from './redis/redis.module';
import { EnrichmentModule } from './enrichment/enrichment.module';
import { ThrottleModule } from './throttle/throttle.module';
import { ProxyModule } from './proxy/proxy.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    FirebaseModule,
    RedisModule,
    EnrichmentModule,
    ThrottleModule,
    HealthModule,
    ProxyModule, // ProxyModule last — its catch-all @All('*path') must not shadow /health
  ],
})
export class AppModule {}
