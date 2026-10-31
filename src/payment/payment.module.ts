import { Module } from '@nestjs/common';
import { BrokenPaymentStore } from './broken-payment.store';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { RedisLockService } from './redis-lock.service';

@Module({
  controllers: [PaymentController],
  providers: [BrokenPaymentStore, PaymentService, RedisLockService],
})
export class PaymentModule {}
