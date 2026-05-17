export class CreateBrokenPaymentDto {
  userId!: string;
  orderId!: string;
  amount!: number;
  currency!: string;
}
