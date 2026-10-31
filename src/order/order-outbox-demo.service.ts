import {
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { OrderService } from './order.service';
import { PlaceOutboxOrderDto } from './dto/place-outbox-order.dto';

@Injectable()
export class OrderOutboxDemoService {
  constructor(
    private readonly orderService: OrderService,
    @InjectQueue('fulfillment')
    private readonly fulfillmentQueue: Queue,
  ) {}

  /**
   * P1/P2 Demonstration:
   * Commits the order to PostgreSQL, then attempts an external network call to BullMQ/Redis.
   * If a crash happens after commit (P1) or Redis fails (P2), the order is committed but
   * the fulfillment job is permanently lost.
   */
  async placeBroken(dto: PlaceOutboxOrderDto) {
    // 1. Commit stock decrement and order creation to PostgreSQL
    const result = await this.orderService.placeOrder(dto);

    // 2. Fault Injection: Simulate server death / OOM / crash immediately after DB commit
    if (dto.fault === 'crash_after_commit') {
      throw new InternalServerErrorException(
        `CRASH INJECTED [P1]: Process terminated after order #${result.order.id} committed. Redis was never reached.`,
      );
    }

    // 3. Attempt to publish event to Redis/BullMQ
    try {
      if (dto.fault === 'redis_down') {
        throw new Error('Connection to Redis lost (ECONNREFUSED simulated)');
      }

      const eventId = randomUUID();
      await this.fulfillmentQueue.add(
        'order-confirmed',
        {
          eventId,
          orderId: result.order.id,
          sku: dto.sku,
          quantity: dto.quantity,
        },
        { jobId: eventId },
      );

      return {
        warning:
          'BROKEN PATTERN: Direct enqueue after DB commit. If the node crashes or Redis blips between line 27 and 44, the order is accepted but fulfillment is lost.',
        order: result.order,
        remainingStock: result.remainingStock,
        jobEnqueued: true,
      };
    } catch (queueError) {
      // NOTICE: Returning 500 or catching the error DOES NOT un-commit the database order!
      throw new ServiceUnavailableException(
        `DUAL-WRITE INCONSISTENCY [P2]: Order #${result.order.id} is durably committed, but queue.add failed: ${(queueError as Error).message}`,
      );
    }
  }
}

