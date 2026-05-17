import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { CpuController } from './cpu.controller';
import { CPU_QUEUE_NAME } from './cpu-queue.constants';
import { CpuService } from './cpu.service';

@Module({
  imports: [
    QueueModule,
    BullModule.registerQueue({
      name: CPU_QUEUE_NAME,
    }),
  ],
  controllers: [CpuController],
  providers: [CpuService],
})
export class CpuModule {}
