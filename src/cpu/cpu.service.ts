import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { CPU_QUEUE_NAME, FIBONACCI_JOB_NAME } from './cpu-queue.constants';
import { runFibonacciWorker } from './cpu-worker.util';

@Injectable()
export class CpuService {
  constructor(
    @InjectQueue(CPU_QUEUE_NAME)
    private readonly cpuQueue: Queue,
  ) {}

  getHealth() {
    return {
      status: 'ok',
      instanceId: this.getInstanceId(),
      timestamp: new Date().toISOString(),
    };
  }

  calculateFibonacciBlocking(number: number) {
    this.assertSafeFibonacciInput(number);

    const startedAt = Date.now();
    const result = this.fibonacci(number);

    return {
      warning:
        'BROKEN: this CPU-heavy calculation ran on the Node.js event loop.',
      method: 'blocking-event-loop',
      input: number,
      result,
      elapsedMs: Date.now() - startedAt,
      instanceId: this.getInstanceId(),
    };
  }

  async calculateFibonacciWithWorker(number: number) {
    this.assertSafeFibonacciInput(number);

    const startedAt = Date.now();
    const result = await runFibonacciWorker(number);

    return {
      message:
        'Fixed: CPU-heavy calculation ran in a worker thread, keeping the main event loop responsive.',
      method: 'worker-thread',
      input: number,
      result,
      elapsedMs: Date.now() - startedAt,
      instanceId: this.getInstanceId(),
    };
  }

  async enqueueFibonacciJob(number: number) {
    this.assertSafeFibonacciInput(number);

    const job = await this.cpuQueue.add(
      FIBONACCI_JOB_NAME,
      {
        number,
        requestedAt: new Date().toISOString(),
      },
      {
        jobId: `fib_${number}_${randomUUID()}`,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: {
          age: 3600,
          count: 1000,
        },
        removeOnFail: {
          age: 86400,
          count: 1000,
        },
      },
    );

    return {
      message:
        'Accepted: CPU-heavy work was queued in Redis for a worker process.',
      jobId: job.id,
      queue: CPU_QUEUE_NAME,
      statusUrl: `/cpu/jobs/${job.id}`,
      instanceId: this.getInstanceId(),
    };
  }

  async getCpuJob(jobId: string) {
    const job = await this.cpuQueue.getJob(jobId);

    if (!job) {
      throw new BadRequestException('CPU job not found or already expired.');
    }

    const state = await job.getState();

    return {
      jobId: job.id,
      name: job.name,
      state,
      attemptsMade: job.attemptsMade,
      data: job.data,
      progress: job.progress,
      result: job.returnvalue,
      failedReason: job.failedReason,
      createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
      processedAt: job.processedOn
        ? new Date(job.processedOn).toISOString()
        : null,
      finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    };
  }

  private fibonacci(number: number): number {
    if (number <= 1) {
      return number;
    }

    return this.fibonacci(number - 1) + this.fibonacci(number - 2);
  }

  private assertSafeFibonacciInput(number: number): void {
    if (!Number.isInteger(number) || number < 0) {
      throw new BadRequestException('number must be a non-negative integer.');
    }

    if (number > 45) {
      throw new BadRequestException(
        'number must be <= 45 for this demo to avoid runaway CPU usage.',
      );
    }
  }

  private getInstanceId(): string {
    return process.env.HOSTNAME || process.env.INSTANCE_ID || 'local-dev';
  }
}
