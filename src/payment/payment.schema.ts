import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DurablePaymentDocument = HydratedDocument<DurablePayment>;
export type DurablePaymentStatus = 'processing' | 'succeeded' | 'failed';

@Schema({ collection: 'payments', timestamps: true })
export class DurablePayment {
  @Prop({ required: true, unique: true, index: true })
  idempotencyKey!: string;

  @Prop({ required: true })
  requestHash!: string;

  @Prop({ required: true, unique: true, index: true })
  orderId!: string;

  @Prop({ required: true, index: true })
  userId!: string;

  @Prop({ required: true, min: 1 })
  amount!: number;

  @Prop({ required: true, uppercase: true })
  currency!: string;

  @Prop({ required: true, enum: ['processing', 'succeeded', 'failed'], index: true })
  status!: DurablePaymentStatus;

  @Prop()
  gatewayChargeId?: string;

  @Prop({ type: Object })
  responsePayload?: Record<string, unknown>;

  @Prop()
  failureReason?: string;

  @Prop({ required: true })
  instanceId!: string;
}

export const DurablePaymentSchema = SchemaFactory.createForClass(DurablePayment);

DurablePaymentSchema.index({ idempotencyKey: 1 }, { unique: true });
DurablePaymentSchema.index({ orderId: 1 }, { unique: true });
DurablePaymentSchema.index({ userId: 1, createdAt: -1 });
