import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { CPU_QUEUE_NAME } from './cpu-queue.constants';
import { CpuJobProcessor } from './cpu-job.processor';

@Module({
  imports: [
    QueueModule,
    BullModule.registerQueue({
      name: CPU_QUEUE_NAME,
    }),
  ],
  providers: [CpuJobProcessor],
})
export class CpuWorkerModule {}
