# Backend engineering lab — problem and solution reference

This lab follows Sujan's engineering context: understand the mechanism, reproduce a failure, fix it, measure it, and defend the trade-offs. Stay with the existing TypeScript, NestJS, MongoDB, Redis, and BullMQ stack until a requirement justifies another technology.

The table maps the current source to its lessons; it does not certify production readiness. Lessons 01–07 have implementations in this checkout. Lesson 08 is the next exercise, documented with implementation sketches and acceptance criteria; its proposed files and routes do not exist yet.

## Existing problems, broken code, and solutions

Paths below are relative to the repository root. Follow the lesson for reproduction commands and explanations.

| Lesson / problem statement                                                                                                                           | Broken implementation                                                                   | Solution implementation                                                                                                                                                                | Mechanism to explain                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [01 — Payment idempotency](01-idempotency.md): repeated requests create duplicate simulated payments.                                                | `src/payment/payment.service.ts`: `chargeBroken`; `src/payment/broken-payment.store.ts` | `src/payment/payment.service.ts`: `charge`; `src/payment/payment.schema.ts`; `src/payment/redis-lock.service.ts`                                                                       | Durable uniqueness, payload identity, and replay versus temporary coordination.                               |
| [02 — Inventory race](02-race-conditions.md): concurrent checkouts both observe stock and sell the last item.                                        | `src/order/order.service.ts`: `placeBrokenOrder`                                        | Same file: `placeOrder`; `src/product/product.service.ts`: `reserveStockAtomically`; `docker-compose.transactions.yml`                                                                 | Conditional atomic update plus a transaction coupling stock and order creation.                               |
| [03 — Distributed idempotency](03-distributed-idempotency.md): a process-local lock cannot coordinate two API instances.                             | `src/payment/payment.service.ts`: `chargeWithBrokenLocalLock`                           | Same file: `charge`; `src/payment/payment.schema.ts`; `src/payment/redis-lock.service.ts`                                                                                              | Cross-instance coordination, lease expiry, durable constraints, and retry behavior.                           |
| [04 — N+1 queries](04-n-plus-one.md): an order list performs one product lookup per order.                                                           | `src/order/order.service.ts`: `listOrdersWithProductsBroken`                            | Same file: `listOrdersWithProducts`; `src/order/order.schema.ts`; `src/product/product.schema.ts`                                                                                      | Batching/joining reduces round trips; inspect the query plan before claiming an index improves performance.   |
| [05 — Event-loop blocking](05-blocking-event-loop.md): CPU-heavy JavaScript delays unrelated requests.                                               | `src/cpu/cpu.service.ts`: `calculateFibonacciBlocking`                                  | Same file: `calculateFibonacciWithWorker`, `enqueueFibonacciJob`; `src/cpu/cpu-worker.util.ts`; `src/cpu/workers/fibonacci.worker.ts`; `src/cpu/cpu-job.processor.ts`; `src/worker.ts` | Event-loop concurrency versus worker-thread parallelism and queued work.                                      |
| [06 — Cache dependency failure](06-cache-layer-failure.md): Redis failure or a miss prevents a cache-only read from returning authoritative data.    | `src/product/product.service.ts`: `getProductBrokenCacheOnly`                           | Same file: `getProduct`; `src/cache/redis-cache.service.ts`                                                                                                                            | Cache-aside, bounded waiting, best-effort population, and database fallback capacity.                         |
| [07 — Load-balanced state](07-load-balancing.md): different API processes return different local counters.                                           | `src/diagnostics/diagnostics.service.ts`: `incrementBrokenLocalCounter`                 | Same file: `incrementSharedCounter`; `src/cache/redis-cache.service.ts`: `increment`; `nginx.conf`                                                                                     | Process memory isolation and shared atomic state; Redis availability and durability remain separate concerns. |
| [08 — Database-to-queue dual write](08-transactional-outbox.md): an order commits but its fulfillment job is lost, or a job survives a failed order. | Proposed `src/order/order-outbox-demo.service.ts`: commit then enqueue                  | Proposed outbox transaction, relay, and idempotent fulfillment consumer; full file map in lesson 08                                                                                    | Local atomicity, eventual delivery, duplicate handling, recovery, and bounded processing.                     |

Controllers expose these demonstrations in `src/payment/payment.controller.ts`, `src/order/order.controller.ts`, `src/cpu/cpu.controller.ts`, `src/product/product.controller.ts`, and `src/diagnostics/diagnostics.controller.ts`.

## Important boundaries in the current demonstrations

- Payments use a simulated gateway. A Redis lock and database record do not make a real provider charge atomic with MongoDB; provider idempotency and reconciliation would still be required.
- A timeout wrapper bounds how long a caller waits; it does not automatically cancel an underlying Redis operation.
- Moving CPU work to workers does not itself bound the number of incoming jobs or worker threads. Admission control and backpressure require deliberate limits.
- Shared Redis counters solve process-local inconsistency; their durability depends on deployment and persistence choices.
- A single-member replica set enables transaction exercises but does not demonstrate database high availability.

## The next learning session

Start with [08 — Transactional outbox](08-transactional-outbox.md). It joins the transaction, idempotency, queue, and multi-instance concepts already present here without introducing a new broker or framework.

For each lesson, preserve these artifacts:

1. A prediction of the failure before running it.
2. A broken run: inputs, relevant IDs, logs, and stored state.
3. A fixed run with the same failure injected.
4. Measured latency/backlog/error behavior where relevant.
5. A short decision note: requirement, options, trade-offs, failure modes, and chosen design.

Do not call a lesson complete because the happy path works. Explain why the fix preserves its invariant after a crash, retry, dependency outage, and second process.
