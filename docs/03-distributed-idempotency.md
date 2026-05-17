# 03 - Distributed Idempotency in a Multi-Instance Setup

## Phase Status

This phase contains both the broken local-lock implementation and the production-grade distributed implementation. The production route is `POST /payments/charge`.

## Updated Folder Structure

```text
src/
  payment/
    payment.controller.ts
    payment.service.ts
docs/
  03-distributed-idempotency.md
```

## Problem Scenario

A team notices duplicate payments and adds a quick in-memory lock:

```text
Set<IdempotencyKey>
```

It works in local development with one NestJS process. The same concurrent request gets blocked, demos pass, and everyone feels better.

Then production scales to multiple app containers behind Nginx. Request A lands on instance A. Retry request B lands on instance B. Each instance has its own memory, so both local locks are empty. Both instances call the payment gateway.

Real outcome: the fix was not distributed, so the duplicate-payment failure returns under scale.

## Broken Implementation (Code)

The broken endpoint is:

```http
POST /payments/broken/local-lock/charge
Idempotency-Key: dist_demo_001
Content-Type: application/json
```

```json
{
  "userId": "user_123",
  "orderId": "order_dist_001",
  "amount": 4999,
  "currency": "USD"
}
```

The flaw lives in:

```text
src/payment/payment.service.ts
```

Broken flow:

```text
Nginx
  |
  +--------------------------+
  |                          |
  v                          v
Nest instance A          Nest instance B
local Set is empty       local Set is empty
  |                          |
add key locally          add key locally
  |                          |
charge gateway           charge gateway
```

This is not idempotency. It is only per-process mutual exclusion.

## Failure Simulation

Use your active app port. In your current setup that appears to be `8080`; in the earlier docs it was `8000`.

```bash
export API_BASE=http://localhost:8080
```

Send concurrent requests with the same idempotency key:

```bash
for i in 1 2 3 4 5; do
  curl -s -X POST "$API_BASE/payments/broken/local-lock/charge" \
    -H 'Content-Type: application/json' \
    -H 'Idempotency-Key: dist_demo_001' \
    -d '{"userId":"user_123","orderId":"order_dist_001","amount":4999,"currency":"USD"}' &
done
wait
```

Inspect the broken in-memory records:

```bash
curl -s "$API_BASE/payments/broken"
```

Run the list request multiple times. If Nginx load balances to different app instances, you may see different local-memory data depending on which container answered.

Expected failure signals:

- More than one request can succeed with the same idempotency key.
- Responses may show different `instanceId` values.
- The lock appears to work only when duplicates hit the same process at the same time.
- Nothing durable is written to MongoDB for this broken endpoint.

## Think

Before we fix it:

1. Why did the `Set` seem to solve the problem in local development?
2. Why does it fail behind Nginx with multiple app containers?
3. What happens to this lock during process restart or deploy?
4. Why is a Redis lock still not enough without a MongoDB idempotency record?
5. What should a duplicate retry receive after the first request succeeds?

## Step-by-Step Fix

### Step 1 - Move In-Flight Coordination Out of Process Memory

The broken endpoint uses:

```text
Set<IdempotencyKey>
```

The fixed endpoint uses Redis:

```text
SET locks:payments:idempotency:{key} {token} PX 10000 NX
```

Why this helps:

- Redis is shared by all app instances.
- `NX` allows only one in-flight owner.
- `PX` gives the lock an automatic expiry.
- The random token prevents one request from releasing another request's lock.

### Step 2 - Keep Durable Idempotency in MongoDB

Redis locks are temporary. They are not the historical source of truth.

The fixed route stores a durable payment record in MongoDB with:

```text
idempotencyKey unique
orderId unique
requestHash
status processing | succeeded | failed
responsePayload
gatewayChargeId
```

The unique index is the final correctness boundary. Even if two app instances race, MongoDB refuses duplicate durable records.

### Step 3 - Store and Validate a Request Hash

The fixed implementation now stores a deterministic SHA-256 hash of the payment request:

```text
userId
orderId
amount
currency
```

If a client reuses the same `Idempotency-Key` with a different payload, the API returns `409 Conflict` instead of replaying an unrelated payment.

This prevents a subtle production bug:

```text
same key + different body = reject
same key + same body = replay or wait
```

### Step 4 - Replay Completed Responses

After a payment succeeds, duplicate retries return the stored response:

```json
{
  "replayed": true,
  "payment": {
    "status": "succeeded",
    "gatewayChargeId": "gw_..."
  }
}
```

That is the client contract. A mobile app can retry after a timeout without charging the customer twice.

## Production-Grade Solution

### Final Comparison

```text
process-local Set         unsafe across instances
Redis lock                useful in-flight coordination
MongoDB unique index      durable correctness boundary
stored response replay    client-safe retry contract
request hash              prevents key reuse with different payloads
```

### Fixed Endpoint

```http
POST /payments/charge
Idempotency-Key: dist_demo_fixed_001
Content-Type: application/json
```

```json
{
  "userId": "user_123",
  "orderId": "order_dist_fixed_001",
  "amount": 4999,
  "currency": "USD"
}
```

### Fixed Simulation

```bash
export API_BASE=http://localhost:8080

for i in 1 2 3 4 5; do
  curl -s -X POST "$API_BASE/payments/charge" \
    -H 'Content-Type: application/json' \
    -H 'Idempotency-Key: dist_demo_fixed_001' \
    -d '{"userId":"user_123","orderId":"order_dist_fixed_001","amount":4999,"currency":"USD"}' &
done
wait
```

Expected behavior:

- One request creates the payment.
- In-flight duplicates may receive `409 Conflict`.
- Later retries receive `"replayed": true`.
- MongoDB contains one durable payment for the key.

Inspect MongoDB:

```bash
docker compose exec mongo mongosh backend_mastery --eval 'db.payments.find({idempotencyKey:"dist_demo_fixed_001"}).pretty()'
```

If you are using the transaction replica-set override from Phase 2, connect through its port:

```text
mongodb://localhost:27018/backend_mastery?replicaSet=rs0&retryWrites=false
```

### Different Payload Reuse Simulation

First request:

```bash
curl -s -X POST "$API_BASE/payments/charge" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: dist_demo_payload_001' \
  -d '{"userId":"user_123","orderId":"order_payload_001","amount":4999,"currency":"USD"}'
```

Bad retry with same key but different amount:

```bash
curl -i -X POST "$API_BASE/payments/charge" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: dist_demo_payload_001' \
  -d '{"userId":"user_123","orderId":"order_payload_001","amount":9999,"currency":"USD"}'
```

Expected behavior:

```text
409 Conflict
Idempotency-Key was already used with a different payment payload.
```

## Codex Documentation

### Concept Explanation

Distributed idempotency means every instance in the fleet must make the same idempotency decision. If the decision exists only in one process, it is not distributed.

Production idempotency has two time horizons:

- In-flight: prevent two instances from doing the expensive side effect at the same time.
- Historical: remember what happened so retries get the same answer later.

Redis is good at the first. MongoDB is good at the second.

### Architecture Diagram

Broken:

```text
Client retries same payment
        |
        v
      Nginx
        |
        +------------+------------+
        |                         |
        v                         v
  instance A local Set      instance B local Set
        |                         |
        v                         v
    charge once               charge again
```

Fixed:

```text
Client retries same payment
        |
        v
      Nginx
        |
        +------------+------------+
        |                         |
        v                         v
   instance A                instance B
        |                         |
        +------------+------------+
                     |
                     v
          Redis SET NX in-flight lock
                     |
                     v
       MongoDB unique idempotency record
                     |
                     v
          stored response is replayed
```

### Tradeoffs

- Local memory is fast, but invisible to other instances.
- Redis is shared and fast, but locks are temporary.
- MongoDB is durable, but should not be used as a spin lock.
- A production design usually combines a short-lived distributed lock with a durable idempotency record.
- Request hashes add safety, but require careful canonicalization so equivalent payloads hash the same way.
- Returning `409` for in-flight duplicates is simple; some APIs choose `202 Accepted` with polling instead.

### When NOT to Use This Broken Approach

Do not use process-local locks for:

- Payments.
- Order creation.
- Inventory reservation.
- Webhook deduplication.
- Job uniqueness across workers.
- Any endpoint running in more than one process.

### Interview Questions

1. Why does a local mutex fail in a distributed system?
2. What is the difference between in-flight coordination and durable idempotency?
3. Why should Redis locks have TTLs?
4. Why should lock release use a token?
5. Why is a database unique index still needed when Redis locking exists?
6. Why should idempotency records store a request hash?
7. What should happen when a duplicate request arrives while the first request is still processing?
8. What should happen when the first request succeeded but the client timed out?
9. What is the risk of replaying a response for the same key but a different request body?
10. Why is "exactly once" side-effect execution hard in distributed systems?
