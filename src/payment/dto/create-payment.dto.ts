export class CreatePaymentDto {
  userId!: string;
  orderId!: string;
  amount!: number;
  currency!: string;
}
