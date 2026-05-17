# 02 - Race Conditions in Concurrent Inventory Updates

## Phase Status

This phase intentionally starts with a broken implementation and stops at the thinking checkpoint. The fix will be added after you reproduce the failure and confirm the next step.

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

Paused for the learning checkpoint.

After confirmation, this section will be implemented incrementally with:

- Atomic MongoDB conditional update: decrement stock only when enough stock exists.
- Order creation only after the stock decrement succeeds.
- A MongoDB session/transaction so product update and order insert commit together.
- Failure responses that do not create phantom orders.

## Production-Grade Solution

Paused for the learning checkpoint.

The final version will show how inventory systems protect invariants under concurrency using database-owned atomicity instead of application-level check-then-save logic.

## Codex Documentation

### Concept Explanation

A race condition happens when correctness depends on the timing of concurrent operations. In backend systems, the classic shape is read-check-write:

```text
read state
check if action is allowed
write new state
```

That flow is unsafe when another request can change the same state between the read and the write.

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

### Tradeoffs

- Application-level checks are readable, but they are not concurrency control.
- Atomic database updates are less expressive than arbitrary application code, but they protect the invariant at the data boundary.
- Transactions add overhead, but they are worth it when multiple documents must commit or roll back together.

### When NOT to Use This Broken Approach

Do not use check-then-save for:

- Inventory decrement.
- Account balance updates.
- Coupon redemption.
- Seat booking.
- Rate limit counters.
- Any shared resource with limited quantity.

### Interview Questions

1. What is a race condition?
2. Why does read-check-write fail under concurrent requests?
3. How can a database conditional update prevent overselling?
4. When do you need a transaction in addition to an atomic update?
5. How would you test this failure with concurrent requests?
