export type PaymentStatus = 'charged';

export interface PaymentRecord {
  id: string;
  userId: string;
  orderId: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  gatewayChargeId: string;
  idempotencyKey?: string;
  createdAt: string;
  instanceId: string;
}
