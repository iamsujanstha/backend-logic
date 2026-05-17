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

  @Post('orders/broken/place')
  placeBrokenOrder(@Body() orderRequest: PlaceOrderDto) {
    return this.orderService.placeBrokenOrder(orderRequest);
  }

  @Get('orders')
  listOrders() {
    return this.orderService.listOrders();
  }
}
