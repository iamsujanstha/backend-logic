import { Injectable } from '@nestjs/common';
import { RedisCacheService } from '../cache/redis-cache.service';

@Injectable()
export class DiagnosticsService {
  private readonly sharedCounterKey = 'diagnostics:global-counter';
  private localCounter = 0;

  constructor(private readonly redisCacheService: RedisCacheService) {}

  getInstance() {
    return {
      instanceId: this.getInstanceId(),
      pid: process.pid,
      timestamp: new Date().toISOString(),
    };
  }

  incrementBrokenLocalCounter() {
    this.localCounter += 1;

    return {
      warning:
        'BROKEN: this counter lives in process memory, so each app instance has a different value.',
      instanceId: this.getInstanceId(),
      pid: process.pid,
      localCounter: this.localCounter,
    };
  }

  async incrementSharedCounter() {
    const globalCounter = await this.redisCacheService.increment(
      this.sharedCounterKey,
    );

    return {
      message:
        'Fixed: this counter is stored in Redis, so every app instance sees one shared value.',
      instanceId: this.getInstanceId(),
      pid: process.pid,
      sharedStore: 'redis',
      counterKey: this.sharedCounterKey,
      globalCounter,
      localCounterOnThisInstance: this.localCounter,
    };
  }

  async getSharedCounter() {
    const value = await this.redisCacheService.getString(this.sharedCounterKey);

    return {
      instanceId: this.getInstanceId(),
      sharedStore: 'redis',
      counterKey: this.sharedCounterKey,
      globalCounter: value ? Number(value) : 0,
    };
  }

  private getInstanceId(): string {
    return process.env.HOSTNAME || process.env.INSTANCE_ID || 'local-dev';
  }
}
