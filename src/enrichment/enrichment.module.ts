import { Module } from '@nestjs/common';
import { EnrichmentService } from './enrichment.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [EnrichmentService],
  exports: [EnrichmentService],
})
export class EnrichmentModule {}
