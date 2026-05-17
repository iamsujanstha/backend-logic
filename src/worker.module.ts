import { Module } from '@nestjs/common';
import { CpuWorkerModule } from './cpu/cpu-worker.module';

@Module({
  imports: [CpuWorkerModule],
})
export class WorkerModule {}
