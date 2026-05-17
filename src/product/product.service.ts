import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { RedisCacheService } from '../cache/redis-cache.service';
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
    private readonly redisCacheService: RedisCacheService,
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

  async getProductBrokenCacheOnly(sku: string) {
    const cacheKey = this.getProductCacheKey(sku);
    const cachedProduct = await this.redisCacheService.getJson(cacheKey);

    return {
      warning:
        'BROKEN: this endpoint depends on Redis and does not fall back to MongoDB.',
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
      const product = await this.getProductFromMongoOrThrow(sku);
      const cacheRepopulated = await this.redisCacheService.setJsonBestEffort(
        cacheKey,
        product,
        60,
        75,
      );

      return {
        source: 'mongo-cache-failure',
        cacheKey,
        cacheHealthy: false,
        cacheRepopulated,
        product,
      };
    }

    const product = await this.getProductFromMongoOrThrow(sku);
    const cacheRepopulated = await this.redisCacheService.setJsonBestEffort(
      cacheKey,
      product,
      60,
      75,
    );

    return {
      source: 'mongo-cache-miss',
      cacheKey,
      cacheHealthy: true,
      cacheRepopulated,
      product,
    };
  }

  async warmProductCache(sku: string) {
    const product = await this.productModel.findOne({ sku }).lean().exec();

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

  private async getProductFromMongoOrThrow(sku: string) {
    const product = await this.productModel.findOne({ sku }).lean().exec();

    if (!product) {
      throw new NotFoundException('Product not found.');
    }

    return product;
  }
}
