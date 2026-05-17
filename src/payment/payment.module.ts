import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BrokenPaymentStore } from './broken-payment.store';
import { PaymentController } from './payment.controller';
import { DurablePayment, DurablePaymentSchema } from './payment.schema';
import { PaymentService } from './payment.service';
import { RedisLockService } from './redis-lock.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DurablePayment.name, schema: DurablePaymentSchema },
    ]),
  ],
  controllers: [PaymentController],
  providers: [BrokenPaymentStore, PaymentService, RedisLockService],
})
export class PaymentModule {}
