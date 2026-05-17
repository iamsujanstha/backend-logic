import { Controller, Get, Param, Post } from '@nestjs/common';
import { ProductService } from './product.service';

@Controller('products')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Get()
  listProducts() {
    return this.productService.listProducts();
  }

  @Post(':sku/cache/warm')
  warmProductCache(@Param('sku') sku: string) {
    return this.productService.warmProductCache(sku);
  }

  @Get('broken/cache-only/:sku')
  getProductBrokenCacheOnly(@Param('sku') sku: string) {
    return this.productService.getProductBrokenCacheOnly(sku);
  }

  @Get(':sku')
  getProduct(@Param('sku') sku: string) {
    return this.productService.getProduct(sku);
  }
}
