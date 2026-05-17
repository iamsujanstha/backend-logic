import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisLockService implements OnModuleDestroy {
  private readonly redis = new Redis(
    process.env.REDIS_URL || 'redis://localhost:6379',
    {
      maxRetriesPerRequest: 2,
    },
  );

  async acquire(key: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async release(key: string, token: string): Promise<void> {
    await this.redis.eval(
      `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
      `,
      1,
      key,
      token,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}
