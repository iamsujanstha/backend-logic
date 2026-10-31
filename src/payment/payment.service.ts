import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { BrokenPaymentStore } from './broken-payment.store';
import { CreateBrokenPaymentDto } from './dto/create-broken-payment.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentRecord } from './payment-record';
import { PG_POOL } from '../database/database.module';
import { RedisLockService } from './redis-lock.service';

@Injectable()
export class PaymentService {
  private readonly localInFlightIdempotencyKeys = new Set<string>();

  constructor(
    private readonly brokenPaymentStore: BrokenPaymentStore,
    private readonly redisLockService: RedisLockService,
    @Inject(PG_POOL)
    private readonly pool: Pool,
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

    const { rows: existingRows } = await this.pool.query(
      'SELECT * FROM payments WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    const existingPayment = existingRows[0] ?? null;

    if (existingPayment && existingPayment.request_hash !== requestHash) {
      throw new ConflictException(
        'Idempotency-Key was already used with a different payment payload.',
      );
    }

    if (existingPayment?.status === 'succeeded') {
      return {
        replayed: true,
        payment: existingPayment.response_payload,
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
      const { rows: afterLockRows } = await this.pool.query(
        'SELECT * FROM payments WHERE idempotency_key = $1',
        [idempotencyKey],
      );
      const paymentAfterLock = afterLockRows[0] ?? null;

      if (paymentAfterLock?.status === 'succeeded') {
        if (paymentAfterLock.request_hash !== requestHash) {
          throw new ConflictException(
            'Idempotency-Key was already used with a different payment payload.',
          );
        }

        return {
          replayed: true,
          payment: paymentAfterLock.response_payload,
        };
      }

      const processingPayment = await this.createProcessingPayment(
        paymentRequest,
        idempotencyKey,
        requestHash,
      );

      const gatewayChargeId = await this.chargeGateway();
      const responsePayload = {
        id: processingPayment.id,
        orderId: processingPayment.order_id,
        userId: processingPayment.user_id,
        amount: processingPayment.amount,
        currency: processingPayment.currency,
        status: 'succeeded',
        gatewayChargeId,
        idempotencyKey,
        instanceId: this.getInstanceId(),
      };

      await this.pool.query(
        'UPDATE payments SET status = $1, gateway_charge_id = $2, response_payload = $3 WHERE id = $4',
        [
          'succeeded',
          gatewayChargeId,
          JSON.stringify(responsePayload),
          processingPayment.id,
        ],
      );

      return {
        replayed: false,
        payment: responsePayload,
      };
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        const { rows: fallbackRows } = await this.pool.query(
          'SELECT * FROM payments WHERE idempotency_key = $1',
          [idempotencyKey],
        );
        const existing = fallbackRows[0] ?? null;

        if (existing?.status === 'succeeded') {
          return {
            replayed: true,
            payment: existing.response_payload,
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
    const { rows } = await this.pool.query(
      'SELECT * FROM payments ORDER BY created_at DESC',
    );
    return rows;
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
      const { rows } = await this.pool.query(
        `INSERT INTO payments (idempotency_key, request_hash, order_id, user_id, amount, currency, status, instance_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          idempotencyKey,
          requestHash,
          paymentRequest.orderId,
          paymentRequest.userId,
          paymentRequest.amount,
          paymentRequest.currency.toUpperCase(),
          'processing',
          this.getInstanceId(),
        ],
      );
      return rows[0];
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
      (error as { code: string }).code === '23505'
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
