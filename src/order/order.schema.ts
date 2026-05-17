import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OrderDocument = HydratedDocument<Order>;
export type OrderStatus = 'confirmed' | 'rejected';

@Schema({ collection: 'orders', timestamps: true })
export class Order {
  @Prop({ required: true, index: true })
  userId!: string;

  @Prop({ required: true, index: true })
  sku!: string;

  @Prop({ required: true, min: 1 })
  quantity!: number;

  @Prop({ required: true, enum: ['confirmed', 'rejected'], index: true })
  status!: OrderStatus;

  @Prop({ required: true })
  unitPriceCents!: number;

  @Prop({ required: true })
  totalCents!: number;

  @Prop({ required: true })
  instanceId!: string;
}

export const OrderSchema = SchemaFactory.createForClass(Order);

OrderSchema.index({ sku: 1, createdAt: -1 });
OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ status: 1, createdAt: -1 });
