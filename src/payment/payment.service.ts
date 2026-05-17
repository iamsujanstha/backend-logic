import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'crypto';
import { Model } from 'mongoose';
import { BrokenPaymentStore } from './broken-payment.store';
import { CreateBrokenPaymentDto } from './dto/create-broken-payment.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentRecord } from './payment-record';
import { DurablePayment } from './payment.schema';
import { RedisLockService } from './redis-lock.service';

@Injectable()
export class PaymentService {
  private readonly localInFlightIdempotencyKeys = new Set<string>();

  constructor(
    private readonly brokenPaymentStore: BrokenPaymentStore,
    private readonly redisLockService: RedisLockService,
    @InjectModel(DurablePayment.name)
    private readonly paymentModel: Model<DurablePayment>,
  ) { }

  async chargeBroken(
    paymentRequest: CreateBrokenPaymentDto,
    idempotencyKey?: string,
  ): Promise<{
    warning: string;
    payment: PaymentRecord;
    receivedIdempotencyKey?: string;
  }> {
    const existingPayment = await this.brokenPaymentStore.findByOrderId(
      paymentRequest.orderId,
    );

    if (existingPayment) {
      return {
        warning:
          'BROKEN: this check only works after one request has already finished on this same process.',
        payment: existingPayment,
        receivedIdempotencyKey: idempotencyKey,
      };
    }

    await this.simulateSlowPaymentGateway();

    const payment = await this.brokenPaymentStore.create({
      ...paymentRequest,
      status: 'charged',
      gatewayChargeId: `gw_${randomUUID()}`,
      idempotencyKey,
      instanceId: this.getInstanceId(),
    });

    return {
      warning:
        'BROKEN: no MongoDB unique index, no durable idempotency table, and no Redis SETNX lock protects this charge.',
      payment,
      receivedIdempotencyKey: idempotencyKey,
    };
  }

  listBrokenPayments(): Promise<PaymentRecord[]> {
    return this.brokenPaymentStore.list();
  }

  async chargeWithBrokenLocalLock(
    paymentRequest: CreateBrokenPaymentDto,
    idempotencyKey?: string,
  ): Promise<{
    warning: string;
    payment: PaymentRecord;
    receivedIdempotencyKey: string;
  }> {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required.');
    }

    if (this.localInFlightIdempotencyKeys.has(idempotencyKey)) {
      throw new ConflictException(
        'BROKEN LOCAL LOCK: this only blocks a duplicate request inside the same Node.js process.',
      );
    }

    this.localInFlightIdempotencyKeys.add(idempotencyKey);

    try {
      await this.simulateSlowPaymentGateway();

      const payment = await this.brokenPaymentStore.create({
        ...paymentRequest,
        status: 'charged',
        gatewayChargeId: `gw_${randomUUID()}`,
        idempotencyKey,
        instanceId: this.getInstanceId(),
      });

      return {
        warning:
          'BROKEN: this used a process-local Set as a lock. It fails when Nginx sends duplicates to another app instance.',
        payment,
        receivedIdempotencyKey: idempotencyKey,
      };
    } finally {
      this.localInFlightIdempotencyKeys.delete(idempotencyKey);
    }
  }

  async charge(
    paymentRequest: CreatePaymentDto,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required.');
    }

    const requestHash = this.createRequestHash(paymentRequest);

    const existingPayment = await this.paymentModel
      .findOne({ idempotencyKey })
      .lean()
      .exec();

    if (existingPayment && existingPayment.requestHash !== requestHash) {
      throw new ConflictException(
        'Idempotency-Key was already used with a different payment payload.',
      );
    }

    if (existingPayment?.status === 'succeeded') {
      return {
        replayed: true,
        payment: existingPayment.responsePayload,
      };
    }

    if (existingPayment?.status === 'processing') {
      throw new ConflictException(
        'Payment is already being processed. Retry shortly.',
      );
    }

    const lockKey = `locks:payments:idempotency:${idempotencyKey}`;
    const lockToken = randomUUID();
    const acquired = await this.redisLockService.acquire(
      lockKey,
      lockToken,
      10_000,
    );

    if (!acquired) {
      throw new ConflictException(
        'Payment is already being processed. Retry shortly.',
      );
    }

    try {
      const paymentAfterLock = await this.paymentModel
        .findOne({ idempotencyKey })
        .lean()
        .exec();

      if (paymentAfterLock?.status === 'succeeded') {
        if (paymentAfterLock.requestHash !== requestHash) {
          throw new ConflictException(
            'Idempotency-Key was already used with a different payment payload.',
          );
        }

        return {
          replayed: true,
          payment: paymentAfterLock.responsePayload,
        };
      }

      const processingPayment = await this.createProcessingPayment(
        paymentRequest,
        idempotencyKey,
        requestHash,
      );

      const gatewayChargeId = await this.chargeGateway();
      const responsePayload = {
        id: processingPayment._id.toString(),
        orderId: processingPayment.orderId,
        userId: processingPayment.userId,
        amount: processingPayment.amount,
        currency: processingPayment.currency,
        status: 'succeeded',
        gatewayChargeId,
        idempotencyKey,
        instanceId: this.getInstanceId(),
      };

      await this.paymentModel.updateOne(
        { _id: processingPayment._id },
        {
          $set: {
            status: 'succeeded',
            gatewayChargeId,
            responsePayload,
          },
        },
      );

      return {
        replayed: false,
        payment: responsePayload,
      };
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        const existing = await this.paymentModel
          .findOne({ idempotencyKey })
          .lean()
          .exec();

        if (existing?.status === 'succeeded') {
          return {
            replayed: true,
            payment: existing.responsePayload,
          };
        }

        throw new ConflictException(
          'A payment already exists for this order or idempotency key.',
        );
      }

      throw error;
    } finally {
      await this.redisLockService.release(lockKey, lockToken);
    }
  }

  async listPayments() {
    return this.paymentModel.find().sort({ createdAt: -1 }).lean().exec();
  }

  private async simulateSlowPaymentGateway(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  private async createProcessingPayment(
    paymentRequest: CreatePaymentDto,
    idempotencyKey: string,
    requestHash: string,
  ) {
    try {
      return await this.paymentModel.create({
        ...paymentRequest,
        currency: paymentRequest.currency.toUpperCase(),
        idempotencyKey,
        requestHash,
        status: 'processing',
        instanceId: this.getInstanceId(),
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw error;
      }

      throw new ServiceUnavailableException('Unable to create payment record.');
    }
  }

  private async chargeGateway(): Promise<string> {
    await this.simulateSlowPaymentGateway();
    return `gw_${randomUUID()}`;
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 11000
    );
  }

  private createRequestHash(paymentRequest: CreatePaymentDto): string {
    const canonicalPayload = {
      amount: paymentRequest.amount,
      currency: paymentRequest.currency.toUpperCase(),
      orderId: paymentRequest.orderId,
      userId: paymentRequest.userId,
    };

    return createHash('sha256')
      .update(JSON.stringify(canonicalPayload))
      .digest('hex');
  }

  private getInstanceId(): string {
    return process.env.HOSTNAME || process.env.INSTANCE_ID || 'local-dev';
  }
}
