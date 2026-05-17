import { Body, Controller, Get, Headers, Post } from '@nestjs/common';
import { CreateBrokenPaymentDto } from './dto/create-broken-payment.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentService } from './payment.service';

@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) { }

  @Post('broken/charge')
  chargeBroken(
    @Body() paymentRequest: CreateBrokenPaymentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.paymentService.chargeBroken(paymentRequest, idempotencyKey);
  }

  @Get('broken')
  listBrokenPayments() {
    return this.paymentService.listBrokenPayments();
  }

  @Post('broken/local-lock/charge')
  chargeWithBrokenLocalLock(
    @Body() paymentRequest: CreateBrokenPaymentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.paymentService.chargeWithBrokenLocalLock(
      paymentRequest,
      idempotencyKey,
    );
  }

  @Post('charge')
  charge(
    @Body() paymentRequest: CreatePaymentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.paymentService.charge(paymentRequest, idempotencyKey);
  }

  @Get()
  listPayments() {
    return this.paymentService.listPayments();
  }
}
