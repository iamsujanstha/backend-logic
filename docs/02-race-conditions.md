# 02 - Race Conditions in Concurrent Inventory Updates

## Phase Status

This phase contains both the broken implementation and the production-grade fix. Run the broken endpoint first, then compare it with the atomic transaction-based endpoint.

## Updated Folder Structure

```text
src/
  product/
    product.controller.ts
    product.module.ts
    product.schema.ts
    product.service.ts
  order/
    dto/
      place-order.dto.ts
    order.controller.ts
    order.module.ts
    order.schema.ts
    order.service.ts
docs/
  02-race-conditions.md
```

## Problem Scenario

The product page says there is one unit left. Two customers click "Buy Now" at nearly the same time.

In production, both requests can read `stock = 1` before either request writes the new stock. Both requests believe the purchase is valid, both create confirmed orders, and the business has sold more units than it owns.

Real outcome: oversold inventory, manual cancellation, customer support escalation, and broken fulfillment promises.

## Broken Implementation (Code)

The broken endpoint is:

```http
POST /orders/broken/place
Content-Type: application/json
```

```json
{
  "userId": "user_a",
  "sku": "prod_race_demo",
  "quantity": 1
}
```

The flaw lives in:

```text
src/order/order.service.ts
```

Broken flow:

```text
Request A                    Request B
  |                             |
  v                             v
read product stock = 1       read product stock = 1
  |                             |
slow checkout delay          slow checkout delay
  |                             |
save stock = 0               save stock = 0
  |                             |
create confirmed order       create confirmed order
```

The final product stock may look harmless because it is `0`, but the order collection shows the real failure: two confirmed orders were created from one available unit.

## Failure Simulation

Reset the demo data:

```bash
curl -s -X POST http://localhost:8000/race-demo/reset
```

Verify the product starts with one unit:

```bash
curl -s http://localhost:8000/products
```

Send two concurrent purchases:

```bash
curl -s -X POST http://localhost:8000/orders/broken/place \
  -H 'Content-Type: application/json' \
  -d '{"userId":"user_a","sku":"prod_race_demo","quantity":1}' &

curl -s -X POST http://localhost:8000/orders/broken/place \
  -H 'Content-Type: application/json' \
  -d '{"userId":"user_b","sku":"prod_race_demo","quantity":1}' &

wait
```

Inspect the result:

```bash
curl -s http://localhost:8000/orders
curl -s http://localhost:8000/products
```

Or inspect MongoDB directly:

```bash
docker compose exec mongo mongosh backend_mastery --eval 'db.orders.find().pretty()'
docker compose exec mongo mongosh backend_mastery --eval 'db.products.find().pretty()'
```

Expected failure signals:

- Two confirmed orders for `prod_race_demo`.
- Product stock is `0`, hiding the oversell unless you count orders.
- Different `instanceId` values may appear if Nginx sends requests to different containers.

## Think

Before we fix it:

1. Why is `if (product.stock < quantity)` not enough?
2. Why can the final stock be `0` even though the system oversold?
3. Which record should own the invariant: the product stock document, the order document, or application memory?
4. Would a Redis lock fix this by itself?
5. What should happen to order creation if stock decrement fails?

## Step-by-Step Fix

### Step 1 - Validate the Request

The fixed endpoint rejects invalid requests before touching shared state:

```text
userId required
sku required
quantity must be a positive integer
```

Endpoint:

```http
POST /orders/place
Content-Type: application/json
```

```json
{
  "userId": "user_a",
  "sku": "prod_race_demo",
  "quantity": 1
}
```

### Step 2 - Move the Stock Rule Into MongoDB

The production fix does not do this:

```text
read stock
if enough stock
save new stock
```

It does this:

```text
findOneAndUpdate(
  { sku, stock: { $gte: quantity } },
  { $inc: { stock: -quantity } }
)
```

That makes the stock check and decrement one atomic database operation.

If stock is already gone, MongoDB matches zero documents. No order should be created.

### Step 3 - Create the Order Only After Stock Reservation

The fixed `OrderService.placeOrder()` flow is:

```text
start MongoDB session
  |
  v
atomic stock decrement
  |
  +-- no product matched -> abort, return insufficient stock
  |
  v
create confirmed order
  |
  v
commit transaction
```

This prevents phantom orders where an order exists even though stock was not reserved.

### Step 4 - Wrap Stock Update and Order Insert in One Transaction

The code uses:

```text
connection.startSession()
session.withTransaction(...)
```

Why: stock decrement and order creation are two writes to two documents. They must commit together or roll back together.

Important local setup note: MongoDB transactions require a replica set or a transaction-capable cluster. If you run a standalone `mongo` container, the fixed endpoint will return a `503` explaining that transactions require replica-set mode. That failure is intentional and educational: production transaction semantics depend on the database topology.

If you see this MongoDB log message, your local database is standalone:

```text
Transaction numbers are only allowed on a replica set member or mongos
```

Some MongoDB driver versions wrap that as:

```text
This MongoDB deployment does not support retryable writes.
```

The service maps both forms to the same learning outcome: transactions need replica-set topology.

### Step 5 - Keep the Broken Endpoint

Broken endpoint:

```text
POST /orders/broken/place
```

Fixed endpoint:

```text
POST /orders/place
```

Keeping both endpoints lets you prove the behavior difference under concurrent load.

## Production-Grade Solution

### Fixed Flow

```text
Client A             Client B
   |                    |
   v                    v
 POST /orders/place   POST /orders/place
   |                    |
   v                    v
 MongoDB conditional update:
 { sku, stock: { $gte: quantity } }
 { $inc: { stock: -quantity } }
   |                    |
   |                    +-- matches 0 docs -> insufficient stock
   v
 matches 1 doc
   |
   v
 create confirmed order in same transaction
```

### Fixed Failure Simulation

Reset the demo:

```bash
curl -s -X POST http://localhost:8000/race-demo/reset
```

Send two concurrent fixed purchases:

```bash
curl -s -X POST http://localhost:8000/orders/place \
  -H 'Content-Type: application/json' \
  -d '{"userId":"user_a","sku":"prod_race_demo","quantity":1}' &

curl -s -X POST http://localhost:8000/orders/place \
  -H 'Content-Type: application/json' \
  -d '{"userId":"user_b","sku":"prod_race_demo","quantity":1}' &

wait
```

Inspect:

```bash
curl -s http://localhost:8000/orders
curl -s http://localhost:8000/products
```

Expected fixed behavior:

- One confirmed order.
- One request rejected with insufficient stock.
- Product stock is `0`.
- There is no second order because order creation only happens after stock reservation succeeds.

### Why It Works Under Scale

- Nginx can send requests to different app instances because MongoDB owns the stock invariant.
- The condition `stock >= quantity` is evaluated at the moment of the update, not earlier in app memory.
- The transaction prevents stock decrement without order creation, and order creation without stock decrement.
- The system fails closed when stock cannot be reserved.

### MongoDB Replica Set Requirement

MongoDB multi-document transactions require replica-set mode or a sharded cluster. If you are using Docker locally, configure MongoDB as a single-node replica set for this phase.

This repo includes a transaction-ready Compose override:

```bash
docker compose -f docker-compose.yml -f docker-compose.transactions.yml up --build
```

The override starts:

```text
mongo-rs      single-node MongoDB replica set
mongo-rs-init one-shot replica-set initializer
app           uses mongodb://mongo-rs:27017/backend_mastery?replicaSet=rs0&retryWrites=false
```

MongoDB is published on host port `27018` to avoid clashing with any existing standalone MongoDB on `27017`.

Compass connection string:

```text
mongodb://localhost:27018/backend_mastery?replicaSet=rs0&retryWrites=false
```

The important production lesson is stable: transactions require database topology support.

### Which Approach Is Best?

Use the smallest database guarantee that fully protects the business invariant:

- For one document, use a single atomic update.
- For multiple documents that must commit together, use a transaction.
- For inventory plus order creation, use both: atomic conditional stock decrement inside a transaction that also creates the order.

That is the industrial approach used here.

## Codex Documentation

### Concept Explanation

A race condition happens when correctness depends on the timing of concurrent operations. In backend systems, the classic shape is read-check-write:

```text
read state
check if action is allowed
write new state
```

That flow is unsafe when another request can change the same state between the read and the write.

The fix is to move the invariant into the database write:

```text
Only decrement stock if stock is still high enough right now.
```

Then use a transaction when multiple documents need to reflect the same business event.

### Architecture Diagram

Broken:

```text
Client A          Client B
   |                 |
   v                 v
 Nginx             Nginx
   |                 |
   v                 v
App instance A   App instance B
   |                 |
   +-------+---------+
           |
           v
 MongoDB product: stock = 1
           |
           v
 two confirmed orders from one unit
```

Fixed:

```text
Client A          Client B
   |                 |
   v                 v
App instance A   App instance B
   |                 |
   +-------+---------+
           |
           v
 MongoDB conditional stock update
 { stock: { $gte: quantity } }
           |
    +------+------+
    |             |
 matched       matched 0
    |             |
    v             v
 order created  rejected
 in transaction
```

### Tradeoffs

- Application-level checks are readable, but they are not concurrency control.
- Atomic database updates are less expressive than arbitrary application code, but they protect the invariant at the data boundary.
- Transactions add overhead, but they are worth it when multiple documents must commit or roll back together.
- Redis locks can reduce contention, but they should not be the final correctness boundary for inventory.
- Database-owned invariants are easier to reason about during deploys, crashes, retries, and multi-instance traffic.

### When NOT to Use This Broken Approach

Do not use check-then-save for:

- Inventory decrement.
- Account balance updates.
- Coupon redemption.
- Seat booking.
- Rate limit counters.
- Any shared resource with limited quantity.

Do not reach for transactions when a single atomic update can fully represent the business invariant. In this phase, the atomic update protects stock; the transaction is needed because the order insert must commit with that stock update.

### Interview Questions

1. What is a race condition?
2. Why does read-check-write fail under concurrent requests?
3. How can a database conditional update prevent overselling?
4. When do you need a transaction in addition to an atomic update?
5. How would you test this failure with concurrent requests?
6. Why is Redis not enough as the final source of truth for stock?
7. What happens if the stock decrement succeeds but order creation fails outside a transaction?
8. How would you design this if inventory lived in a separate service?
9. How would you make this endpoint idempotent as well as race-safe?
10. Why do MongoDB transactions require replica-set topology?
