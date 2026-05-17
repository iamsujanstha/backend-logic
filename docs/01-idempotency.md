# 01 - Idempotency Failure in Multi-Instance Payments

## Phase Status

This phase contains both the broken implementation and the production-grade fix. Run the broken endpoint first, reason about the failure, then compare it with the durable implementation.

## Updated Folder Structure

```text
src/
  app.module.ts
  payment/
    broken-payment.store.ts
    dto/
      create-broken-payment.dto.ts
    payment.controller.ts
    payment.module.ts
    payment-record.ts
    payment.schema.ts
    payment.service.ts
    redis-lock.service.ts
docker-compose.yml
nginx.conf
docs/
  01-idempotency.md
```

## Problem Scenario

A customer taps "Pay" in a mobile app. The network times out before the client receives the response, so the app retries the same payment request with the same `Idempotency-Key`.

In production, the NestJS API runs behind Nginx with multiple app instances. Request one lands on container A, and the retry lands on container B. If each instance only checks local memory, both containers believe they are processing the first payment and both call the payment gateway.

Real outcome: duplicate charge, angry customer, manual refund, broken trust.

## Broken Implementation (Code)

The broken endpoint is:

```http
POST /payments/broken/charge
Idempotency-Key: pay_demo_001
Content-Type: application/json
```

```json
{
  "userId": "user_123",
  "orderId": "order_9001",
  "amount": 4999,
  "currency": "USD"
}
```

The intentional flaw lives in:

```text
src/payment/broken-payment.store.ts
src/payment/payment.service.ts
src/payment/payment.controller.ts
```

The broken flow is:

```text
Client
  |
  | POST /payments/broken/charge
  v
Nginx
  |
  | load balances
  v
NestJS instance A or B
  |
  | checks process-local memory by orderId
  | waits 250ms to simulate payment gateway latency
  | inserts a charged payment into process-local memory
  v
Response
```

The code accepts an `Idempotency-Key`, but it does not enforce it. That is worse than not having idempotency at all because the API looks safer than it is.

## Failure Simulation

Start the system behind Nginx:

```bash
docker compose up --build --scale app=2
```

Send concurrent requests with the same `orderId` and same `Idempotency-Key`:

```bash
for i in 1 2 3 4 5; do
  curl -s -X POST http://localhost:8000/payments/broken/charge \
    -H 'Content-Type: application/json' \
    -H 'Idempotency-Key: pay_demo_001' \
    -d '{"userId":"user_123","orderId":"order_9001","amount":4999,"currency":"USD"}' &
done
wait
```

Then inspect what each instance remembers:

```bash
curl -s http://localhost:8000/payments/broken
```

Run the list request several times. Because the storage is process-local, Nginx may show different data depending on which container receives the request.

Expected failure signals:

- More than one successful charge for the same logical order.
- Different responses from different app instances.
- The response includes the same received idempotency key, but no durable idempotency decision was made.

## Think

Before we fix it:

1. What exactly is wrong with checking `findByOrderId()` before creating the charge?
2. Why does the 250ms gateway delay make the duplicate easier to reproduce?
3. Why does process-local memory fail harder when Nginx spreads traffic across multiple containers?
4. Would adding a simple JavaScript `Map` keyed by `Idempotency-Key` solve this in production?

Answers:

1. `findByOrderId()` followed by create is a check-then-act race. Two requests can both observe "nothing exists" before either one writes.
2. The gateway delay widens the race window. While request A is waiting on the external provider, request B can enter the same code path.
3. Process-local memory is isolated per container. Instance A cannot see the in-flight or completed payment stored inside instance B.
4. A JavaScript `Map` only helps inside one process. It fails across replicas, restarts, deploys, and crashes.

## Step-by-Step Fix

### Step 1 - Require an Idempotency Key

The production endpoint rejects payment creation without the header:

```http
POST /payments/charge
Idempotency-Key: pay_demo_001
```

Why: for non-idempotent operations, the client must provide a stable operation identity. The server cannot reliably infer that two requests are the same just because the payload looks similar.

### Step 2 - Store the Idempotency Decision in MongoDB

The durable schema lives in:

```text
src/payment/payment.schema.ts
```

Important fields:

```text
idempotencyKey unique
orderId unique
status processing | succeeded | failed
responsePayload
gatewayChargeId
instanceId
```

Why: the result must survive process restart and must be visible to every app instance.

### Step 3 - Add MongoDB Unique Indexes

The schema declares unique indexes on:

```text
idempotencyKey
orderId
```

The application still checks for existing records, but the database owns final correctness. Application checks are useful for fast paths; unique indexes are correctness boundaries.

### Step 4 - Coordinate In-Flight Requests with Redis

The Redis lock service uses:

```text
SET key token PX ttl NX
```

Meaning:

- `NX`: only create the lock if it does not exist.
- `PX`: expire it automatically in milliseconds.
- `token`: release only the lock this request owns.

The release script checks the token before deleting the key so one request cannot accidentally release another request's lock.

### Step 5 - Replay the First Successful Response

When a request with the same idempotency key arrives after success, the API returns the stored response:

```json
{
  "replayed": true,
  "payment": {
    "orderId": "order_9001",
    "status": "succeeded"
  }
}
```

This is what makes client retries safe. The client can retry after a timeout without guessing whether the first request succeeded.

### Step 6 - Keep the Broken Endpoint

The broken endpoint remains available:

```text
POST /payments/broken/charge
```

The production endpoint is:

```text
POST /payments/charge
```

Keeping both endpoints makes the failure measurable instead of theoretical.

## Production-Grade Solution

### Request Flow

```text
Client
  |
  | POST /payments/charge
  | Idempotency-Key: pay_demo_001
  v
Nginx
  |
  | load balances to any app instance
  v
NestJS PaymentService
  |
  | 1. read MongoDB by idempotencyKey
  | 2. replay stored success if present
  | 3. acquire Redis SET NX lock
  | 4. check MongoDB again after lock
  | 5. insert processing payment record
  | 6. call payment gateway
  | 7. update MongoDB with succeeded response
  | 8. release Redis lock
  v
Client receives first response or replay
```

### Why It Works Under Scale

- Nginx can send retries to any container because the idempotency decision is stored in MongoDB.
- Redis protects the in-flight window where no durable success response exists yet.
- MongoDB unique indexes protect correctness if two app instances race or the Redis lock expires early.
- The stored response lets clients safely retry after timeouts.

### Fixed Endpoint Simulation

Start all services:

```bash
docker compose up --build --scale app=2
```

Send concurrent duplicate requests:

```bash
for i in 1 2 3 4 5; do
  curl -s -X POST http://localhost:8000/payments/charge \
    -H 'Content-Type: application/json' \
    -H 'Idempotency-Key: pay_demo_001' \
    -d '{"userId":"user_123","orderId":"order_9001","amount":4999,"currency":"USD"}' &
done
wait
```

Inspect durable payments:

```bash
curl -s http://localhost:8000/payments
```

Expected fixed behavior:

- Only one MongoDB payment document for `pay_demo_001`.
- Only one gateway charge id.
- Duplicate in-flight requests receive `409 Conflict`.
- Later retries receive the stored success response with `"replayed": true`.

### Docker and Nginx Integration

`docker-compose.yml` now includes:

```text
proxy -> Nginx on localhost:8000
app -> scalable NestJS service
mongo -> MongoDB durable state
redis -> distributed in-flight coordination
```

`nginx.conf` adds:

```text
X-Upstream-Address
```

Use that header to see which upstream handled a response. The app response also includes `instanceId`.

## Codex Documentation

### Concept Explanation

Idempotency means the same logical operation can be safely repeated without changing the final result more than once. For payments, retries are normal because clients, gateways, and networks fail. The backend must treat retries as expected behavior, not exceptional behavior.

Idempotency is not the same as locking:

- Idempotency defines the externally visible behavior for duplicate logical operations.
- Locking coordinates concurrent execution for a short time window.
- Unique indexes enforce durable correctness after all application-level defenses fail.

### Architecture Diagram

```text
Client retry with Idempotency-Key
        |
        v
      Nginx
        |
        +----------+----------+
        |                     |
        v                     v
  Nest instance A       Nest instance B
        |                     |
        |   broken: local memory only
        v                     v
  duplicate charge      duplicate charge
```

Fixed:

```text
Client retry with Idempotency-Key
        |
        v
      Nginx
        |
        +----------+----------+
        |                     |
        v                     v
  Nest instance A       Nest instance B
        |                     |
        +----------+----------+
                   |
                   v
        Redis lock for in-flight work
                   |
                   v
      MongoDB unique idempotency record
                   |
                   v
       one gateway charge, replayed result
```

### Tradeoffs

- Process-local memory is fast, but disappears on restart and cannot coordinate multiple instances.
- Checking before insert is easy to understand, but unsafe under concurrency.
- Accepting idempotency headers without enforcing them creates a false safety contract.
- Redis locks are fast and practical, but they must have TTLs and safe token-based release.
- MongoDB unique indexes are a strong correctness boundary, but duplicate-key errors must be handled as normal control flow.
- Storing full response payloads improves replay behavior, but payload shape becomes part of the API contract.

### Failure Modes to Design For

- Redis is temporarily unavailable: for payment writes, fail closed or rely on a database-only atomic insert path. Do not silently charge without coordination.
- The app crashes after gateway charge but before MongoDB update: production systems need reconciliation with the payment provider.
- The lock TTL is too short: a second request may start while the first gateway call is still running. The MongoDB unique index remains the final defense.
- The client reuses one idempotency key with a different payload: production systems should store a request hash and reject mismatched retries.

### When NOT to Use This Approach

Do not use process-local idempotency for:

- Payments.
- Inventory reservation.
- Order creation.
- External API calls that charge money, send emails, ship products, or mutate third-party state.
- Any endpoint served by more than one process or container.

Do not use Redis-only idempotency for durable financial correctness. Redis is coordination, not the permanent source of truth.

This exact implementation is also incomplete for regulated payment systems because it does not yet include:

- Request payload hashing.
- Gateway reconciliation jobs.
- Permanent audit trails.
- PII redaction and payment data compliance boundaries.
- Transactional outbox events for notifications.

### Interview Questions

1. What is the difference between idempotency and locking?
2. Why is `check-then-insert` unsafe under concurrent requests?
3. How does a unique index protect correctness differently from application code?
4. What should an API return when the same idempotency key is retried after success?
5. What should happen when the first request is still in progress?
6. Why should the idempotency response be stored durably?
7. What can go wrong if the Redis lock expires before the payment gateway returns?
8. How would you detect and repair a payment charged at the gateway but stuck as `processing` locally?
9. Should the same idempotency key be accepted with a different request body?
10. Why is "exactly once" usually the wrong phrase for distributed payment systems?
