import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { CPU_QUEUE_NAME, FIBONACCI_JOB_NAME } from './cpu-queue.constants';
import { runFibonacciWorker } from './cpu-worker.util';

interface FibonacciJobData {
  number: number;
  requestedAt: string;
}

@Processor(CPU_QUEUE_NAME, { concurrency: 1 })
export class CpuJobProcessor extends WorkerHost {
  async process(job: Job<FibonacciJobData>) {
    if (job.name !== FIBONACCI_JOB_NAME) {
      throw new Error(`Unsupported CPU job: ${job.name}`);
    }

    const startedAt = Date.now();
    const result = await runFibonacciWorker(job.data.number);

    return {
      method: 'redis-backed-bullmq-worker',
      input: job.data.number,
      result,
      elapsedMs: Date.now() - startedAt,
      workerInstanceId: process.env.HOSTNAME || process.env.INSTANCE_ID || 'local-dev',
      requestedAt: job.data.requestedAt,
      completedAt: new Date().toISOString(),
    };
  }
}
