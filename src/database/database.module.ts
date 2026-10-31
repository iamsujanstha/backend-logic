import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

export const PG_POOL = Symbol('PG_POOL');

@Global()
@Injectable()
class DatabaseShutdown implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async onApplicationShutdown() { await this.pool.end(); }
}

@Module({
  providers: [{ provide: PG_POOL, useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://backend:backend@localhost:5432/backend_mastery' }) }, DatabaseShutdown],
  exports: [PG_POOL],
})
export class DatabaseModule {}
