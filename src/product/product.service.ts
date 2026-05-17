import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { Product } from './product.schema';

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

  async seedNPlusOneDemoProducts() {
    const products = N_PLUS_ONE_DEMO_SKUS.map((sku, index) => ({
      updateOne: {
        filter: { sku },
        update: {
          $set: {
            sku,
            name: `N+1 Demo Product ${index + 1}`,
            stock: 100,
            priceCents: 2500 + index * 1500,
          },
        },
        upsert: true,
      },
    }));

    await this.productModel.bulkWrite(products);
    return this.productModel
      .find({ sku: { $in: N_PLUS_ONE_DEMO_SKUS } })
      .sort({ sku: 1 })
      .lean()
      .exec();
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
