import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { RedisCacheService } from '../cache/redis-cache.service';
import { PG_POOL } from '../database/database.module';

export const RACE_DEMO_SKU = 'prod_race_demo';
export const N_PLUS_ONE_DEMO_SKUS = [
  'prod_n1_keyboard',
  'prod_n1_mouse',
  'prod_n1_monitor',
  'prod_n1_dock',
  'prod_n1_headset',
];

@Injectable()
export class ProductService {
  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
    private readonly redisCacheService: RedisCacheService,
  ) {}

  async resetRaceDemoProduct() {
    const { rows } = await this.pool.query(
      `INSERT INTO products (sku, name, stock, price_cents)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (sku) DO UPDATE
         SET name = $2, stock = $3, price_cents = $4, updated_at = now()
       RETURNING *`,
      [RACE_DEMO_SKU, 'Race Condition Demo Keyboard', 1, 12900],
    );

    return rows[0];
  }

  async findBySku(sku: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM products WHERE sku = $1`,
      [sku],
    );

    return rows[0] ?? null;
  }

  async seedNPlusOneDemoProducts() {
    // Batch upsert all 5 products in a single parameterized query
    const values: (string | number)[] = [];
    const valueClauses: string[] = [];

    N_PLUS_ONE_DEMO_SKUS.forEach((sku, index) => {
      const offset = index * 4;
      valueClauses.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`,
      );
      values.push(sku, `N+1 Demo Product ${index + 1}`, 100, 2500 + index * 1500);
    });

    await this.pool.query(
      `INSERT INTO products (sku, name, stock, price_cents)
       VALUES ${valueClauses.join(', ')}
       ON CONFLICT (sku) DO UPDATE
         SET name = EXCLUDED.name,
             stock = EXCLUDED.stock,
             price_cents = EXCLUDED.price_cents,
             updated_at = now()`,
      values,
    );

    const placeholders = N_PLUS_ONE_DEMO_SKUS.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await this.pool.query(
      `SELECT * FROM products WHERE sku IN (${placeholders}) ORDER BY sku`,
      N_PLUS_ONE_DEMO_SKUS,
    );

    return rows;
  }

  async reserveStockAtomically(
    sku: string,
    quantity: number,
    client?: PoolClient,
  ) {
    const executor = client ?? this.pool;
    const { rows } = await executor.query(
      `UPDATE products
         SET stock = stock - $1, updated_at = now()
       WHERE sku = $2 AND stock >= $1
       RETURNING *`,
      [quantity, sku],
    );

    return rows[0] ?? null;
  }

  async listProducts() {
    const { rows } = await this.pool.query(
      `SELECT * FROM products ORDER BY sku`,
    );

    return rows;
  }

  async getProductBrokenCacheOnly(sku: string) {
    const cacheKey = this.getProductCacheKey(sku);
    const cachedProduct = await this.redisCacheService.getJson(cacheKey);

    return {
      warning:
        'BROKEN: this endpoint depends on Redis and does not fall back to PostgreSQL.',
      cacheKey,
      source: cachedProduct ? 'redis' : 'redis-miss',
      product: cachedProduct,
    };
  }

  async getProduct(sku: string) {
    const cacheKey = this.getProductCacheKey(sku);

    try {
      const cachedProduct = await this.redisCacheService.getJsonWithTimeout(
        cacheKey,
        75,
      );

      if (cachedProduct) {
        return {
          source: 'redis',
          cacheKey,
          cacheHealthy: true,
          product: cachedProduct,
        };
      }
    } catch {
      const product = await this.getProductFromDbOrThrow(sku);
      const cacheRepopulated = await this.redisCacheService.setJsonBestEffort(
        cacheKey,
        product,
        60,
        75,
      );

      return {
        source: 'pg-cache-failure',
        cacheKey,
        cacheHealthy: false,
        cacheRepopulated,
        product,
      };
    }

    const product = await this.getProductFromDbOrThrow(sku);
    const cacheRepopulated = await this.redisCacheService.setJsonBestEffort(
      cacheKey,
      product,
      60,
      75,
    );

    return {
      source: 'pg-cache-miss',
      cacheKey,
      cacheHealthy: true,
      cacheRepopulated,
      product,
    };
  }

  async warmProductCache(sku: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM products WHERE sku = $1`,
      [sku],
    );

    const product = rows[0] ?? null;

    if (!product) {
      return {
        message: 'Product not found; cache was not warmed.',
        sku,
      };
    }

    const cacheKey = this.getProductCacheKey(sku);
    await this.redisCacheService.setJson(cacheKey, product, 60);

    return {
      message: 'Product cached in Redis for 60 seconds.',
      cacheKey,
      product,
    };
  }

  private getProductCacheKey(sku: string): string {
    return `cache:products:${sku}`;
  }

  private async getProductFromDbOrThrow(sku: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM products WHERE sku = $1`,
      [sku],
    );

    if (!rows[0]) {
      throw new NotFoundException('Product not found.');
    }

    return rows[0];
  }
}
