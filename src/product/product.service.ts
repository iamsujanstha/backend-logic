import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { Product } from './product.schema';

export const RACE_DEMO_SKU = 'prod_race_demo';

@Injectable()
export class ProductService {
  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<Product>,
  ) {}

  async resetRaceDemoProduct() {
    return this.productModel
      .findOneAndUpdate(
        { sku: RACE_DEMO_SKU },
        {
          $set: {
            sku: RACE_DEMO_SKU,
            name: 'Race Condition Demo Keyboard',
            stock: 1,
            priceCents: 12900,
          },
        },
        { returnDocument: 'after', upsert: true },
      )
      .lean()
      .exec();
  }

  async findBySku(sku: string) {
    return this.productModel.findOne({ sku }).exec();
  }

  async reserveStockAtomically(
    sku: string,
    quantity: number,
    session?: ClientSession,
  ) {
    return this.productModel
      .findOneAndUpdate(
        {
          sku,
          stock: { $gte: quantity },
        },
        {
          $inc: { stock: -quantity },
        },
        {
          returnDocument: 'after',
          session,
        },
      )
      .exec();
  }

  async listProducts() {
    return this.productModel.find().sort({ sku: 1 }).lean().exec();
  }
}
