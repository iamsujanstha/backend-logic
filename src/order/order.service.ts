import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { PlaceOrderDto } from './dto/place-order.dto';
import { Order } from './order.schema';
import { ProductService, RACE_DEMO_SKU } from '../product/product.service';

@Injectable()
export class OrderService {
  constructor(
    private readonly productService: ProductService,
    @InjectConnection()
    private readonly connection: Connection,
    @InjectModel(Order.name)
    private readonly orderModel: Model<Order>,
  ) {}

  async resetRaceDemo() {
    const product = await this.productService.resetRaceDemoProduct();
    await this.orderModel.deleteMany({ sku: RACE_DEMO_SKU }).exec();

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

    product.stock = product.stock - orderRequest.quantity;
    await product.save();

    const order = await this.orderModel.create({
      userId: orderRequest.userId,
      sku: product.sku,
      quantity: orderRequest.quantity,
      status: 'confirmed',
      unitPriceCents: product.priceCents,
      totalCents: product.priceCents * orderRequest.quantity,
      instanceId: this.getInstanceId(),
    });

    return {
      warning:
        'BROKEN: stock was checked before a slow checkout window and then saved non-atomically.',
      order,
      remainingStock: product.stock,
    };
  }

  async placeOrder(orderRequest: PlaceOrderDto) {
    this.assertValidOrderRequest(orderRequest);

    const session = await this.connection.startSession();
    let response:
      | {
          message: string;
          order: Order;
          remainingStock: number;
        }
      | undefined;

    try {
      await session.withTransaction(async () => {
        const product = await this.productService.reserveStockAtomically(
          orderRequest.sku,
          orderRequest.quantity,
          session,
        );

        if (!product) {
          throw new BadRequestException('Insufficient stock.');
        }

        await this.simulateSlowCheckout();

        const [order] = await this.orderModel.create(
          [
            {
              userId: orderRequest.userId,
              sku: product.sku,
              quantity: orderRequest.quantity,
              status: 'confirmed',
              unitPriceCents: product.priceCents,
              totalCents: product.priceCents * orderRequest.quantity,
              instanceId: this.getInstanceId(),
            },
          ],
          { session },
        );

        response = {
          message:
            'Order confirmed. Stock decrement and order creation committed together.',
          order,
          remainingStock: product.stock,
        };
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      if (this.isTransactionUnsupportedError(error)) {
        throw new ServiceUnavailableException(
          'MongoDB transactions require a replica set. Configure MongoDB as a replica set or use a transaction-capable cluster.',
        );
      }

      throw error;
    } finally {
      await session.endSession();
    }

    if (!response) {
      throw new ServiceUnavailableException('Order transaction did not complete.');
    }

    return response;
  }

  async listOrders() {
    return this.orderModel.find().sort({ createdAt: -1 }).lean().exec();
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

  private isTransactionUnsupportedError(error: unknown): boolean {
    const message = this.flattenErrorMessages(error);

    return (
      message.includes('Transaction numbers are only allowed') ||
      message.includes('replica set member or mongos') ||
      message.includes('does not support retryable writes')
    );
  }

  private flattenErrorMessages(error: unknown): string {
    if (error instanceof Error) {
      return `${error.message} ${this.flattenErrorMessages(
        (error as Error & { originalError?: unknown }).originalError,
      )} ${this.flattenErrorMessages(
        (error as Error & { errorResponse?: unknown }).errorResponse,
      )}`;
    }

    if (typeof error === 'object' && error !== null) {
      return Object.values(error)
        .map((value) => this.flattenErrorMessages(value))
        .join(' ');
    }

    return typeof error === 'string' ? error : '';
  }

  private getInstanceId(): string {
    return process.env.HOSTNAME || process.env.INSTANCE_ID || 'local-dev';
  }
}
