import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PlaceOrderDto } from './dto/place-order.dto';
import { Order } from './order.schema';
import { ProductService, RACE_DEMO_SKU } from '../product/product.service';

@Injectable()
export class OrderService {
  constructor(
    private readonly productService: ProductService,
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

  async listOrders() {
    return this.orderModel.find().sort({ createdAt: -1 }).lean().exec();
  }

  private async simulateSlowCheckout(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  private getInstanceId(): string {
    return process.env.HOSTNAME || process.env.INSTANCE_ID || 'local-dev';
  }
}
