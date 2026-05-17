import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PaymentRecord } from './payment-record';

@Injectable()
export class BrokenPaymentStore {
  private readonly payments: PaymentRecord[] = [];

  async findByOrderId(orderId: string): Promise<PaymentRecord | undefined> {
    // explicitly await a resolved promise so the async method contains an await
    return await Promise.resolve(
      this.payments.find((payment) => payment.orderId === orderId),
    );
  }

  async create(
    payment: Omit<PaymentRecord, 'id' | 'createdAt'>,
  ): Promise<PaymentRecord> {
    const record: PaymentRecord = {
      ...payment,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };

    this.payments.push(record);
    return await Promise.resolve(record);
  }

  async list(): Promise<PaymentRecord[]> {
    return await Promise.resolve([...this.payments]);
  }
}
