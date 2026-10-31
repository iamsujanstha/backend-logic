# 08 — An order committed, but its job disappeared

## Status and learning objective

**Documentation-first exercise.** The code blocks are implementation sketches, not installed code or executable commands. Proposed files, fault hooks, and routes below still need implementation. Existing lessons and source references are indexed in [the lab reference](README.md).

Your current capability: conditional inventory updates, MongoDB transactions, Redis coordination, BullMQ jobs, and multiple API instances. The gap: understanding what a local transaction cannot protect when another system is involved.

After this lesson, explain and demonstrate this invariant:

> Every order accepted by the new fixed demo has exactly one durable fulfillment intent committed alongside it. Delivery may repeat; the local fulfillment effect occurs at most once per event.

Eventual completion additionally requires retained data, recovered dependencies, functioning workers, and intervention for permanent failures. This is not an end-to-end exactly-once delivery claim.

Use the existing stack. Do not add Kafka, microservices, or a new database for this exercise. Use a local fulfillment database record as the effect; real shipping, payments, and email introduce another external boundary.

## 1. First, build the broken version

Business requirement: confirming an order must eventually create a fulfillment record, even if Redis is temporarily unavailable or an API process crashes.

Existing `src/order/order.service.ts::placeOrder` already commits stock decrement and order creation in a MongoDB transaction. It does not currently promise or publish fulfillment events. Add a separate demonstration service so lessons 02 and 04 keep their existing behavior.

Proposed `src/order/order-outbox-demo.service.ts::placeBroken`:

```ts
// Sketch: dependencies and fault hook are supplied by the exercise.
const result = await this.orderService.placeOrder(request);

// In a test, terminate or throw HERE after confirming the commit.
await this.faults.afterOrderCommit();

await this.fulfillmentQueue.add('order-confirmed', {
  eventId: randomUUID(),
  orderId: result.order._id.toString(),
});
return result;
```

The order's transaction has finished before enqueueing. `try/catch`, `await`, or returning HTTP 500 cannot undo a committed order automatically. An exception is a convenient deterministic test hook; a separate process-termination test proves that recovery does not depend on cleanup code.

### Enumerate the problems before reading the solution

| ID  | Problem statement and failure injection                                      | Broken outcome                                                             | Required solution                                                                       |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| P1  | Crash after order commit, before enqueue.                                    | Stock decreases and order exists, but no fulfillment job exists.           | Commit the order and durable intent in one database transaction.                        |
| P2  | Redis is unavailable after order commit.                                     | Request can fail even though the order exists; queue has nothing to retry. | Accept based on the database commit and let a relay retry publication.                  |
| P3  | Reverse the operations: enqueue before committing the order; force rollback. | A worker can receive work for an order that never committed.               | Keep Redis writes outside the database transaction; publish committed intents only.     |
| P4  | Publish succeeds; relay crashes before recording success.                    | Recovery publishes the same event again.                                   | Stable event ID and durable consumer idempotency.                                       |
| P5  | Consumer commits the effect; worker crashes before acknowledging completion. | Queue recovery can execute the job again.                                  | Commit the deduplication receipt and effect together.                                   |
| P6  | Two relay processes select the same pending record.                          | Duplicate publication and competing status updates.                        | Atomic claim, expiring lease, and ownership-checked updates.                            |
| P7  | Consumer rejects a malformed or unsupported event every time.                | Endless retries or silent abandonment.                                     | Validate payload/version, bound retries, retain failed work, alert, and support replay. |
| P8  | Incoming orders exceed publishing or processing capacity.                    | Backlog age grows, storage fills, and latency rises.                       | Bounded batches/concurrency, backlog metrics, capacity planning, and admission policy.  |
| P9  | Redis accepts a job and later loses it.                                      | A `published` outbox row can exist without eventual fulfillment.           | Queue durability choices plus receipt-based reconciliation/replay of retained events.   |
| P10 | Client loses the HTTP response after commit and submits again.               | A second order can produce a second valid event.                           | Separate request-level idempotency; outbox event deduplication does not solve this.     |

For the first broken experiment, predict order count, stock, job count, and fulfillment count. Then inject P1. Query MongoDB directly to prove the order committed; an HTTP error alone does not establish database state.

## 2. Explain why the obvious fixes fail

- **Retry the request:** can create another order. Request idempotency is a separate contract.
- **Retry `queue.add`:** helps transient errors while that process is alive. A crashed producer cannot run its retry loop.
- **Enqueue inside `withTransaction`:** Redis is not enlisted in the MongoDB transaction, so rollback cannot remove its job. Transaction callbacks can also run again on transient failures. MongoDB documents the callback retry behavior in its [transaction API guide](https://www.mongodb.com/docs/manual/core/transactions-in-applications/).
- **Use a Redis lock:** coordinates producers for a period; it does not atomically commit across MongoDB and Redis.
- **Mark published before enqueue:** creates a permanent loss window instead of a duplicate window.

The mental model: a transaction protects writes within its database boundary. For cross-system work, persist an obligation locally, then deliver it with retry and duplicate tolerance.

## 3. The actual solution, file by file

All paths in this table are repository-relative. **New** means proposed, not present in this documentation change.

| File                                                           | Status                     | Responsibility / problem IDs                                                                                                                           |
| -------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/order/order-outbox-demo.controller.ts`                    | New                        | Separate broken/fixed demo routes; no production-accessible crash switch. P1–P3.                                                                       |
| `src/order/order-outbox-demo.service.ts`                       | New                        | Broken commit-then-enqueue path, then fixed transaction containing stock, order, and outbox insert. P1–P3.                                             |
| `src/order/order.module.ts`                                    | Existing, extend           | Register demo controller/service and import producer outbox module.                                                                                    |
| `src/product/product.service.ts`                               | Existing, reuse            | `reserveStockAtomically` accepts the same MongoDB session as both inserts.                                                                             |
| `src/order/order.schema.ts`                                    | Existing, reuse            | Order data committed with the intent. Do not overload order status with transport state.                                                               |
| `src/outbox/order-confirmed.event.ts`                          | New                        | Versioned, minimal envelope: eventId, orderId, type, version, occurredAt. P7.                                                                          |
| `src/outbox/outbox.schema.ts`                                  | New                        | Durable payload and dispatch state, unique eventId, pending-work index. P1, P4, P6, P9.                                                                |
| `src/outbox/outbox.module.ts`                                  | New                        | Schema registration and producer support; export schema access for the order transaction. No relay loop in API processes.                              |
| `src/outbox/outbox-relay.service.ts`                           | New                        | Bounded polling, atomic lease claim, enqueue, retry/backoff, ownership checks, shutdown. P2, P4, P6–P8.                                                |
| `src/outbox/outbox-relay.module.ts`                            | New                        | Register relay lifecycle and fulfillment queue in the worker process.                                                                                  |
| `src/fulfillment/fulfillment.schema.ts`                        | New                        | Local business effect with unique orderId for this one-fulfillment-per-order exercise. P5.                                                             |
| `src/fulfillment/processed-event.schema.ts`                    | New                        | Durable unique `(consumerName, eventId)` receipt. P4–P5.                                                                                               |
| `src/fulfillment/order-confirmed.processor.ts`                 | New                        | Validate event, then transact receipt and effect; duplicates become successful no-ops. P4–P5, P7.                                                      |
| `src/fulfillment/fulfillment-worker.module.ts`                 | New                        | Register processor and schemas.                                                                                                                        |
| `src/worker.module.ts`                                         | Existing, extend           | Currently imports CPU worker only. Add MongoDB connection, QueueModule, relay module, and fulfillment worker module. Use the same database as the API. |
| `src/queue/queue.module.ts`, `src/queue/redis-connection.ts`   | Existing, reuse            | Shared connection setup; choose appropriate producer/worker retry behavior.                                                                            |
| `docker-compose.transactions.yml`, `docker-compose.worker.yml` | Existing, extend as needed | Transaction-capable MongoDB and API/worker network/configuration. A one-member replica set is a local transaction lab.                                 |
| `test/outbox.e2e-spec.ts`                                      | New                        | Real MongoDB/Redis assertions for the failure matrix; mocks alone cannot prove atomicity or crash recovery.                                            |

### Step A — Write the order and intent together

Outbox fields: `eventId`, `type`, `version`, `orderId`, `occurredAt`, `status`, `attempts`, `availableAt`, `leaseUntil`, `claimToken`, `publishedAt`, and sanitized `lastError`. Keep payload immutable. Create unique `{ eventId: 1 }` and work-selection `{ status: 1, availableAt: 1 }` indexes, with a recovery index for expired leases. Verify indexes exist before concurrency tests.

Proposed fixed demo service core:

```ts
// Sketch inside a method with injected models, connection, and productService.
const orderId = new Types.ObjectId();
const eventId = randomUUID();
const occurredAt = new Date();
const session = await this.connection.startSession();
try {
  await session.withTransaction(async () => {
    const product = await this.productService.reserveStockAtomically(
      request.sku,
      request.quantity,
      session,
    );
    if (!product) throw new BadRequestException('Insufficient stock.');

    await this.orderModel.create(
      [
        {
          _id: orderId,
          userId: request.userId,
          sku: product.sku,
          quantity: request.quantity,
          status: 'confirmed',
          unitPriceCents: product.priceCents,
          totalCents: product.priceCents * request.quantity,
          instanceId: process.env.HOSTNAME || 'local-dev',
        },
      ],
      { session },
    );

    await this.outboxModel.create(
      [
        {
          eventId,
          orderId: orderId.toString(),
          type: 'order.confirmed',
          version: 1,
          occurredAt,
          status: 'pending',
          attempts: 0,
          availableAt: occurredAt,
        },
      ],
      { session },
    );
  });
} finally {
  await session.endSession();
}
// Report an accepted order and pending fulfillment after commit.
// No queue.add, email, or provider charge belongs in the callback.
```

Reuse existing request validation before this sketch. Generate IDs outside the callback so internal retries retain identity. This does not make a later HTTP retry idempotent. If adding request idempotency, store its unique scoped key and payload hash within the acceptance design; replay a committed result and reject a different payload using the same key.

Inject an exception after the outbox insert but before commit. Assert that stock, order, and outbox all roll back. Forgetting `{ session }` on any write breaks this guarantee.

### Step B — Relay committed records

The relay state machine is:

```text
pending -> publishing (claimToken + leaseUntil) -> published
               |
               +-> pending with availableAt/backoff, or failed for review
               +-> reclaim after lease expiry if the owner disappeared
```

1. Atomically claim one due pending row or an expired publishing row with `findOneAndUpdate`. Set a fresh random claim token and lease deadline and increment attempts. Never select a batch and assume the selection grants ownership.
2. Publish the immutable envelope to a dedicated `fulfillment` BullMQ queue, with `jobId: eventId`, bounded retry/backoff, and a documented retention policy. UUIDs avoid the colon restriction on custom IDs.
3. Only after enqueue acknowledgment, mark `published`, filtering by event ID, `status: publishing`, and claim token. A stale relay must not overwrite a newer owner's state.
4. On retryable failure, conditionally release to pending with capped exponential backoff and jitter. On crash, let the lease expire. Limit attempts and surface exhausted records for intervention.
5. Bound batch size and active publications. Renew leases for slow operations or tolerate lease expiry through deduplication. Stop overlapping poll iterations and drain in-flight work during graceful shutdown.

`published` means enqueue was acknowledged, not fulfillment completed. Two relays can still publish duplicates if one stalls past its lease. Consumer idempotency remains necessary.

BullMQ ignores an added job ID while that ID already exists in the queue; removed jobs no longer provide this protection. See [BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids). Stable job IDs reduce duplicate enqueueing; durable business receipts protect the effect beyond Redis retention.

### Step C — Make the consumer effect idempotent

Within one MongoDB transaction:

1. Insert a receipt uniquely keyed by `(consumerName = fulfillment-v1, eventId)`.
2. Insert the local fulfillment record with the event's order ID.
3. Commit both, then let the processor return successfully.

If the receipt already exists, abort that attempt and treat the event as already processed only after verifying the receipt and matching identity. Do not swallow every duplicate-key error; another unique constraint may expose a different bug. Keep event IDs bound to immutable payloads.

If the effect insert fails, the receipt must roll back too. If the worker dies after commit, replay sees the receipt and creates no second fulfillment. Test this with two workers concurrently, not just sequential calls. BullMQ's [idempotent jobs guidance](https://docs.bullmq.io/patterns/idempotent-jobs) explains why retryable jobs must preserve their final outcome; its [stalled-job documentation](https://docs.bullmq.io/guide/jobs/stalled) describes recovery after lost worker locks.

For a real email, shipping, or payment API, the external effect cannot join this transaction. Use provider-supported idempotency keyed by event ID and reconciliation, or explicitly accept the provider's duplicate risk. A local processed-event receipt alone cannot prove exactly-once external execution.

### Step D — Design recovery and observation

Record structured logs with eventId, orderId, jobId, attempt, claim token, stage, duration, and error class. Do not log sensitive payloads.

Track pending count, oldest pending age, enqueue errors, expired leases, failed events, queue waiting/active/failed counts, receipt count, duplicate suppression, and time from order acceptance to fulfillment. Put high-cardinality event IDs in logs rather than metric labels.

For the local lab, target fulfillment within five seconds under healthy dependencies. During an outage, backlog age should rise visibly; after recovery it should drain. Measure actual results rather than recording the target as achieved.

Retain outbox events and receipts for a defined recovery/replay window. A reconciliation process or operator script must find old accepted orders without fulfillment receipts and requeue their retained events. This covers Redis data loss after acknowledged publication. Investigate retained failed jobs before replay: adding the same ID while a failed job still exists will not create a fresh execution. Use explicit retry or a controlled replay procedure.

Do not delete unprocessed records with a TTL. Receipt expiry must account for the maximum replay age; deleting a receipt can re-enable an old effect. No global event ordering is promised here. Per-order sequencing would require a separate version/order contract.

## 4. Experiments and measurable acceptance criteria

Use a disposable local dataset, transaction-capable MongoDB, Redis, and separate API/worker processes. Build indexes first and initialize collections before starting transactions. Reuse existing Compose files after wiring the proposed modules. No proposed route is available until implemented.

Use dependency-injected barriers in tests at the exact boundaries below. For process-kill experiments, wait for a logged boundary before terminating the target child process; arbitrary sleeps do not prove which write completed.

| Experiment                                                            | Evidence required for the fixed version                                                                                                  |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Throw before transaction commit.                                      | Original stock remains; zero new orders, outbox rows, receipts, and fulfillments.                                                        |
| Kill API after commit and before publication.                         | One order and one pending intent survive; restarting relay produces one fulfillment.                                                     |
| Stop Redis, accept an order, restart Redis.                           | Fixed acceptance remains database-backed; pending intent survives; fulfillment completes after recovery without another HTTP submission. |
| Kill relay after enqueue acknowledgment but before marking published. | Expired claim is recovered; eventual publication can repeat; fulfillment and receipt counts remain one.                                  |
| Kill worker after effect commit before job completion.                | Recovered/retried job performs no additional effect.                                                                                     |
| Run two relays and two workers against 100 uniquely accepted orders.  | Exactly 100 intents, 100 receipts, 100 fulfillments; no duplicate order IDs in fulfillment. Seed sufficient stock first.                 |
| Reprocess one event ten times, including concurrent attempts.         | One receipt and one fulfillment; duplicate attempts are observable.                                                                      |
| Supply unsupported event version.                                     | No effect; bounded retries produce visible failed work and an actionable error.                                                          |
| Simulate acknowledged job loss in an isolated queue.                  | Receipt-based reconciliation detects the missing effect and replay restores it from retained outbox data.                                |
| Produce faster than workers consume for a bounded interval.           | Queue and outbox age/size are measured; active concurrency remains bounded; a documented capacity/admission decision follows.            |

Do not reuse race-demo resets while these tests run: the existing reset deletes demonstration orders and resets shared inventory. Isolate test records and clean only records created by the test run.

Save predictions, observed counts, IDs, timestamps, logs, and recovery time in a dated results section after implementing. **No runtime experiments have been executed as part of this documentation change.**

## 5. Three focused learning sessions

Each session fits the approximately three-hour daily learning budget.

1. **Break and explain:** 30 minutes tracing existing transaction/queue code, 60 minutes building commit-then-enqueue, 45 minutes reproducing P1–P3, 45 minutes explaining each failure without code.
2. **Implement the invariant:** 60 minutes transactional intent, 60 minutes relay claims/retries, 60 minutes consumer transaction and duplicate test.
3. **Recover and defend:** 90 minutes crash/outage/concurrency experiments, 45 minutes metrics and reconciliation, 45 minutes writing a decision note and teaching the result.

Continue another day if needed; completion is evidence-based, not time-based. Start with one relay, then add the second only when single-relay recovery works.

## 6. Architecture review and assessment

Write a one-page decision note covering requirement, constraints, options, failure modes, complexity, security, operating cost, and decision. Compare direct enqueue, transactional outbox, and reconstructing work from authoritative orders. Polling adds database load and delivery latency; change-data capture may become justified later, but is not needed to learn this failure boundary.

Use an outbox when durable business acceptance must eventually cause asynchronous work across a system boundary. For expendable analytics or a recomputable CPU calculation with no paired business commit, direct enqueue may be enough. If MongoDB becomes unavailable, fixed acceptance must fail rather than acknowledge an order with no durable record. If Redis becomes unavailable, MongoDB can preserve intent while backlog grows, subject to storage and admission limits.

Explain these without reading the document:

1. Why can't a MongoDB transaction roll back a BullMQ job?
2. Why publish before marking success, even though it allows duplicates?
3. What happens if the consumer commits before the relay marks published?
4. How does a crashed relay's claim become recoverable? Why does a lease not eliminate duplicate publication?
5. Why must the receipt and local effect share a transaction?
6. Why does stable jobId stop helping after queue retention removes the job?
7. What distinguishes request idempotency, event idempotency, and provider idempotency?
8. How do you detect a published event that never produced its effect?
9. What happens when arrival rate exceeds processing rate for an hour?
10. Which guarantee would change if fulfillment became a real external shipping API?

You pass when you can predict every failure row, demonstrate the invariant with stored evidence, recover failed work, and explain the remaining limits. The reusable insight for your AI Codebase Architect project is the same: an accepted document upload should durably record its ingestion/embedding intent, and replay must not create duplicate downstream effects.
