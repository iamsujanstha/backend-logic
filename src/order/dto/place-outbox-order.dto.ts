import { PlaceOrderDto } from './place-order.dto';

export type OutboxFault = 'crash_after_commit' | 'redis_down';

export class PlaceOutboxOrderDto extends PlaceOrderDto {
  fault?: OutboxFault;
}

