import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { InternalServerErrorException, ServiceUnavailableException } from '@nestjs/common';
import { OrderOutboxDemoService } from './order-outbox-demo.service';
import { OrderService } from './order.service';

describe('OrderOutboxDemoService (Broken Pattern Demo)', () => {
  let service: OrderOutboxDemoService;
  let mockOrderService: { placeOrder: jest.Mock };
  let mockQueue: { add: jest.Mock };

  beforeEach(async () => {
    mockOrderService = {
      placeOrder: jest.fn().mockResolvedValue({
        message: 'Order confirmed. Stock decrement and order creation committed together.',
        order: {
          id: '101',
          user_id: 'user_1',
          sku: 'prod_keyboard',
          quantity: 2,
          status: 'confirmed',
          unit_price_cents: 5000,
          total_cents: 10000,
        },
        remainingStock: 8,
      }),
    };

    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job_1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderOutboxDemoService,
        {
          provide: OrderService,
          useValue: mockOrderService,
        },
        {
          provide: getQueueToken('fulfillment'),
          useValue: mockQueue,
        },
      ],
    }).compile();

    service = module.get<OrderOutboxDemoService>(OrderOutboxDemoService);
  });

  describe('P1: Process crash immediately after DB commit', () => {
    it('commits order to DB, but process crash leaves queue untouched (orphan order)', async () => {
      // Act & Assert
      await expect(
        service.placeBroken({
          userId: 'user_1',
          sku: 'prod_keyboard',
          quantity: 2,
          fault: 'crash_after_commit',
        }),
      ).rejects.toThrow(InternalServerErrorException);

      // PROOF OF INCONSISTENCY:
      // 1. Order WAS committed in Postgres
      expect(mockOrderService.placeOrder).toHaveBeenCalledTimes(1);

      // 2. Queue was NEVER notified
      expect(mockQueue.add).not.toHaveBeenCalled();
      // Conclusion: Customer card/stock charged/held, but warehouse never gets fulfillment event!
    });
  });

  describe('P2: Redis unavailable at checkout time', () => {
    it('commits order to DB, but Redis error causes 503 while order remains committed in DB', async () => {
      // Act & Assert
      await expect(
        service.placeBroken({
          userId: 'user_1',
          sku: 'prod_keyboard',
          quantity: 2,
          fault: 'redis_down',
        }),
      ).rejects.toThrow(ServiceUnavailableException);

      // PROOF OF INCONSISTENCY:
      // 1. Order WAS committed in Postgres
      expect(mockOrderService.placeOrder).toHaveBeenCalledTimes(1);

      // 2. Client receives an error 503, thinks the order failed, but the order and stock deduction exist!
    });
  });

  describe('Happy Path (without crash)', () => {
    it('enqueues job when no failures occur, but remains vulnerable to unhandled restarts', async () => {
      const response = await service.placeBroken({
        userId: 'user_1',
        sku: 'prod_keyboard',
        quantity: 2,
      });

      expect(response.order.id).toBe('101');
      expect(response.jobEnqueued).toBe(true);
      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledWith(
        'order-confirmed',
        expect.objectContaining({
          orderId: '101',
          sku: 'prod_keyboard',
          quantity: 2,
        }),
        expect.any(Object),
      );
    });
  });
});

