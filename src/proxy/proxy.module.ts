import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { WsProxyService } from './ws-proxy.service';
import { FirebaseModule } from '../firebase/firebase.module';
import { EnrichmentModule } from '../enrichment/enrichment.module';
import { ThrottleModule } from '../throttle/throttle.module';

@Module({
  imports: [FirebaseModule, EnrichmentModule, ThrottleModule],
  controllers: [ProxyController],
  providers: [ProxyService, WsProxyService],
  exports: [WsProxyService],
})
export class ProxyModule {}
