import { Body, Controller, Post } from '@nestjs/common';
import { OrderOutboxDemoService } from './order-outbox-demo.service';
import { PlaceOutboxOrderDto } from './dto/place-outbox-order.dto';

@Controller('orders/outbox')
export class OrderOutboxDemoController {
  constructor(private readonly outboxDemoService: OrderOutboxDemoService) {}

  @Post('broken/place')
  placeBroken(@Body() dto: PlaceOutboxOrderDto) {
    return this.outboxDemoService.placeBroken(dto);
  }
}

