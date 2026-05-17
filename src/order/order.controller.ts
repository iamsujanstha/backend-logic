import { Body, Controller, Get, Post } from '@nestjs/common';
import { PlaceOrderDto } from './dto/place-order.dto';
import { OrderService } from './order.service';

@Controller()
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Post('race-demo/reset')
  resetRaceDemo() {
    return this.orderService.resetRaceDemo();
  }

  @Post('n-plus-one-demo/seed')
  seedNPlusOneDemo() {
    return this.orderService.seedNPlusOneDemo();
  }

  @Post('orders/broken/place')
  placeBrokenOrder(@Body() orderRequest: PlaceOrderDto) {
    return this.orderService.placeBrokenOrder(orderRequest);
  }

  @Post('orders/place')
  placeOrder(@Body() orderRequest: PlaceOrderDto) {
    return this.orderService.placeOrder(orderRequest);
  }

  @Get('orders')
  listOrders() {
    return this.orderService.listOrders();
  }

  @Get('orders/broken/with-products')
  listOrdersWithProductsBroken() {
    return this.orderService.listOrdersWithProductsBroken();
  }

  @Get('orders/with-products')
  listOrdersWithProducts() {
    return this.orderService.listOrdersWithProducts();
  }
}
