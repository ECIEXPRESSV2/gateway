import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { GatewayThrottlerGuard } from './throttle.guard';
import { GatewayThrottlerStorage } from './throttle.storage';
import { RedisModule } from '../redis/redis.module';
import { RedisService } from '../redis/redis.service';

@Module({
  imports: [
    RedisModule,
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      // RedisService sí lo exporta RedisModule (importado arriba). El módulo
      // dinámico de forRootAsync no puede resolver GatewayThrottlerStorage
      // (vive en el scope del ThrottleModule externo), así que lo construimos
      // aquí a partir de RedisService.
      inject: [RedisService],
      useFactory: (redis: RedisService) => ({
        throttlers: [
          {
            ttl:   parseInt(process.env['THROTTLE_TTL_MS'] ?? '60000', 10),
            limit: parseInt(process.env['THROTTLE_LIMIT'] ?? '60', 10),
          },
        ],
        storage: new GatewayThrottlerStorage(redis),
      }),
    }),
  ],
  providers: [GatewayThrottlerGuard, GatewayThrottlerStorage],
  exports: [GatewayThrottlerGuard, ThrottlerModule],
})
export class ThrottleModule {}
