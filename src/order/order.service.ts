import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { PlaceOrderDto } from './dto/place-order.dto';
import {
  N_PLUS_ONE_DEMO_SKUS,
  ProductService,
  RACE_DEMO_SKU,
} from '../product/product.service';

@Injectable()
export class OrderService {
  constructor(
    private readonly productService: ProductService,
    @Inject(PG_POOL)
    private readonly pool: Pool,
  ) {}

  async resetRaceDemo() {
    const product = await this.productService.resetRaceDemoProduct();
    await this.pool.query('DELETE FROM orders WHERE sku = $1', [RACE_DEMO_SKU]);

    return {
      message: 'Race demo reset. Product stock is 1 and related demo orders were removed.',
      product,
    };
  }

  async placeBrokenOrder(orderRequest: PlaceOrderDto) {
    this.assertValidOrderRequest(orderRequest);

    const product = await this.productService.findBySku(orderRequest.sku);

    if (!product) {
      throw new NotFoundException('Product not found.');
    }

    if (product.stock < orderRequest.quantity) {
      throw new BadRequestException('Insufficient stock.');
    }

    await this.simulateSlowCheckout();

    const { rows: [updatedProduct] } = await this.pool.query(
      'UPDATE products SET stock = stock - $1 WHERE sku = $2 RETURNING stock',
      [orderRequest.quantity, orderRequest.sku],
    );

    const { rows: [order] } = await this.pool.query(
      `INSERT INTO orders (user_id, sku, quantity, status, unit_price_cents, total_cents, instance_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        orderRequest.userId,
        product.sku,
        orderRequest.quantity,
        'confirmed',
        product.price_cents,
        product.price_cents * orderRequest.quantity,
        this.getInstanceId(),
      ],
    );

    return {
      warning:
        'BROKEN: stock was checked before a slow checkout window and then saved non-atomically.',
      order,
      remainingStock: updatedProduct.stock,
    };
  }

  async placeOrder(orderRequest: PlaceOrderDto) {
    this.assertValidOrderRequest(orderRequest);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const product = await this.productService.reserveStockAtomically(
        orderRequest.sku,
        orderRequest.quantity,
        client,
      );

      if (!product) {
        await client.query('ROLLBACK');
        throw new BadRequestException('Insufficient stock.');
      }

      await this.simulateSlowCheckout();

      const { rows: [order] } = await client.query(
        `INSERT INTO orders (user_id, sku, quantity, status, unit_price_cents, total_cents, instance_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          orderRequest.userId,
          product.sku,
          orderRequest.quantity,
          'confirmed',
          product.price_cents,
          product.price_cents * orderRequest.quantity,
          this.getInstanceId(),
        ],
      );

      await client.query('COMMIT');

      return {
        message:
          'Order confirmed. Stock decrement and order creation committed together.',
        order,
        remainingStock: product.stock,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listOrders() {
    const { rows } = await this.pool.query(
      'SELECT * FROM orders ORDER BY created_at DESC',
    );
    return rows;
  }

  async seedNPlusOneDemo() {
    const products = await this.productService.seedNPlusOneDemoProducts();

    await this.pool.query('DELETE FROM orders WHERE sku = ANY($1)', [
      N_PLUS_ONE_DEMO_SKUS,
    ]);

    const orders = Array.from({ length: 30 }, (_, index) => {
      const product = products[index % products.length];
      return {
        userId: `n1_user_${String(index + 1).padStart(2, '0')}`,
        sku: product.sku,
        quantity: 1,
        status: 'confirmed',
        unitPriceCents: product.price_cents,
        totalCents: product.price_cents,
        instanceId: this.getInstanceId(),
      };
    });

    // Batch INSERT with parameterized values
    const valuesClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const o of orders) {
      valuesClauses.push(
        `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6})`,
      );
      params.push(
        o.userId,
        o.sku,
        o.quantity,
        o.status,
        o.unitPriceCents,
        o.totalCents,
        o.instanceId,
      );
      paramIndex += 7;
    }

    await this.pool.query(
      `INSERT INTO orders (user_id, sku, quantity, status, unit_price_cents, total_cents, instance_id)
       VALUES ${valuesClauses.join(', ')}`,
      params,
    );

    return {
      message: 'N+1 demo seeded with 5 products and 30 orders.',
      productCount: products.length,
      orderCount: orders.length,
    };
  }

  async listOrdersWithProductsBroken() {
    const startedAt = Date.now();
    const { rows: orders } = await this.pool.query(
      'SELECT * FROM orders WHERE sku = ANY($1) ORDER BY created_at DESC LIMIT 30',
      [N_PLUS_ONE_DEMO_SKUS],
    );

    let productQueryCount = 0;
    const enrichedOrders: Array<Record<string, unknown>> = [];

    for (const order of orders) {
      productQueryCount += 1;
      const product = await this.productService.findBySku(order.sku);

      enrichedOrders.push({
        ...order,
        product: product
          ? {
              sku: product.sku,
              name: product.name,
              priceCents: product.price_cents,
            }
          : null,
      });
    }

    return {
      warning:
        'BROKEN: this endpoint performs one order query plus one product query per order.',
      queryShape: '1 orders query + N product queries',
      orderCount: orders.length,
      productQueryCount,
      totalQueries: 1 + productQueryCount,
      elapsedMs: Date.now() - startedAt,
      orders: enrichedOrders,
    };
  }

  async listOrdersWithProducts() {
    const startedAt = Date.now();
    const { rows: orders } = await this.pool.query(
      `SELECT o.*, json_build_object('sku', p.sku, 'name', p.name, 'price_cents', p.price_cents) AS product
       FROM orders o
       LEFT JOIN products p ON o.sku = p.sku
       WHERE o.sku = ANY($1)
       ORDER BY o.created_at DESC
       LIMIT 30`,
      [N_PLUS_ONE_DEMO_SKUS],
    );

    return {
      message:
        'Fixed: SQL JOIN loads orders and product data in a single query.',
      queryShape: '1 SELECT with LEFT JOIN',
      orderCount: orders.length,
      productQueryCount: 0,
      totalQueries: 1,
      elapsedMs: Date.now() - startedAt,
      indexesUsedByDesign: [
        'orders: (sku, created_at DESC)',
        'products: sku PRIMARY KEY',
      ],
      orders,
    };
  }

  private async simulateSlowCheckout(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  private assertValidOrderRequest(orderRequest: PlaceOrderDto): void {
    if (!orderRequest.userId || !orderRequest.sku) {
      throw new BadRequestException('userId and sku are required.');
    }

    if (!Number.isInteger(orderRequest.quantity) || orderRequest.quantity < 1) {
      throw new BadRequestException('quantity must be a positive integer.');
    }
  }

  private getInstanceId(): string {
    return process.env.HOSTNAME || process.env.INSTANCE_ID || 'local-dev';
  }
}
