import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { OrderOutboxDemoController } from './order-outbox-demo.controller';
import { OrderOutboxDemoService } from './order-outbox-demo.service';
import { ProductModule } from '../product/product.module';

@Module({
  imports: [
    ProductModule,
    BullModule.registerQueue({
      name: 'fulfillment',
    }),
  ],
  controllers: [OrderController, OrderOutboxDemoController],
  providers: [OrderService, OrderOutboxDemoService],
  exports: [OrderService],
})
export class OrderModule { }
