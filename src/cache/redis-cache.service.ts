import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { getRedisConnectionOptions } from '../queue/redis-connection';

@Injectable()
export class RedisCacheService implements OnModuleDestroy {
  private readonly redis = new Redis(getRedisConnectionOptions());

  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(key);
    return value ? (JSON.parse(value) as T) : null;
  }

  async getJsonWithTimeout<T>(key: string, timeoutMs: number): Promise<T | null> {
    return this.withTimeout(this.getJson<T>(key), timeoutMs);
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async setJsonBestEffort(
    key: string,
    value: unknown,
    ttlSeconds: number,
    timeoutMs: number,
  ): Promise<boolean> {
    try {
      await this.withTimeout(this.setJson(key, value, ttlSeconds), timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }

  private async withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;

    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Redis operation timed out after ${timeoutMs}ms.`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}
