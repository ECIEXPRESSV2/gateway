import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { FirebaseModule } from './firebase/firebase.module';
import { RedisModule } from './redis/redis.module';
import { EnrichmentModule } from './enrichment/enrichment.module';
import { ThrottleModule } from './throttle/throttle.module';
import { ProxyModule } from './proxy/proxy.module';
import { HealthModule } from './health/health.module';
import { LoggingMiddleware } from './common/logger/logging.middleware';

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
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Rellena el userId (header x-user-id) en el contexto de logging para que cada
    // log enviado a Application Insights incluya customDimensions.userId.
    consumer.apply(LoggingMiddleware).forRoutes('*');
  }
}
