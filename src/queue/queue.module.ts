import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { getRedisConnectionOptions } from './redis-connection';

@Global()
@Module({
  imports: [
    BullModule.forRoot({
      connection: getRedisConnectionOptions(),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
