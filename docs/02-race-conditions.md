# 02 — Race Conditions in Concurrent Inventory Reservation

## Phase Status

This phase contains both the broken implementation and the production-grade PostgreSQL atomic reservation fix.

## Folder Structure

```text
src/
  order/
    order.controller.ts
    order.service.ts         <-- Broken non-atomic check vs PostgreSQL transaction
  product/
    product.service.ts       <-- Atomic stock decrement with RETURNING *
db/
  init/
    001_schema.sql           <-- products & orders tables with CHECK (stock >= 0)
docker-compose.yml           <-- PostgreSQL 17 + Redis 7 + App
docs/
  02-race-conditions.md
```

---

## Problem Scenario

An e-commerce store has **1 remaining keyboard** in stock.

Two customers simultaneously click "Place Order" at the exact same millisecond:
- Customer A's request hits Node.js Process 1.
- Customer B's request hits Node.js Process 2.

Both requests read the database:
- Process 1 reads: `stock = 1` ➔ *"Looks good, proceed to checkout!"*
- Process 2 reads: `stock = 1` ➔ *"Looks good, proceed to checkout!"*

Both processes simulate a slow checkout (e.g. payment/fraud check), then deduct 1 from stock and create an order.

**Real outcome:** 2 confirmed orders are created for 1 physical item. The product is **oversold**. One customer receives a cancellation email and gets angry.

---

## Broken Implementation (Code)

The broken endpoint is:

```http
POST /orders/broken/place
Content-Type: application/json

{
  "userId": "user_a",
  "sku": "prod_race_demo",
  "quantity": 1
}
```

The flaw lives in `src/order/order.service.ts`:

```ts
// Flaw 1: Read stock first (Non-atomic check-then-act)
const product = await this.productService.findBySku(orderRequest.sku);
if (product.stock < orderRequest.quantity) {
  throw new BadRequestException('Insufficient stock.');
}

// Flaw 2: Latency window allows concurrent requests to interleave
await this.simulateSlowCheckout();

// Flaw 3: Write back decremented stock without atomic conditional check
await this.pool.query(
  'UPDATE products SET stock = stock - $1 WHERE sku = $2 RETURNING stock',
  [orderRequest.quantity, orderRequest.sku],
);

// Flaw 4: Create order in an un-coupled second query
await this.pool.query('INSERT INTO orders (...) VALUES (...)');
```

---

## Step-by-Step Fix (Production Architecture)

### Step 1 — Database-Level Integrity Constraints
In `db/init/001_schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS products (
  sku text PRIMARY KEY,
  name text NOT NULL,
  stock integer NOT NULL CHECK (stock >= 0),
  price_cents integer NOT NULL CHECK (price_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```
The `CHECK (stock >= 0)` constraint prevents negative inventory at the storage engine level. If an update attempts to push stock below 0, PostgreSQL throws SQLSTATE `23514` (`check_violation`).

### Step 2 — Conditional Atomic Update (`UPDATE ... WHERE stock >= $1`)
Do not `SELECT` and check in JavaScript. Execute an **atomic conditional update** in PostgreSQL:

```sql
UPDATE products
SET stock = stock - $1,
    updated_at = now()
WHERE sku = $2 
  AND stock >= $1
RETURNING *;
```

**Why this works:**
- PostgreSQL row-level locks the targeted row during the update.
- If Customer A and Customer B execute this concurrently, PostgreSQL serializes the update on the row.
- Customer A decrements `stock` from 1 to 0 and returns the updated product.
- Customer B's update evaluates `WHERE stock >= 1`, matches **0 rows**, and returns empty.
- If `rows.length === 0`, we immediately know inventory was exhausted—no race condition is possible.

### Step 3 — Wrap Stock Update and Order Insert in One ACID Transaction
Stock decrement and order creation must be completely atomic:

```ts
const client = await this.pool.connect();
try {
  await client.query('BEGIN');

  // 1. Conditional atomic reservation
  const product = await this.productService.reserveStockAtomically(
    orderRequest.sku,
    orderRequest.quantity,
    client,
  );

  if (!product) {
    await client.query('ROLLBACK');
    throw new BadRequestException('Insufficient stock.');
  }

  // 2. Insert order
  const { rows: [order] } = await client.query(
    `INSERT INTO orders (user_id, sku, quantity, status, unit_price_cents, total_cents, instance_id)
     VALUES ($1, $2, $3, 'confirmed', $4, $5, $6) RETURNING *`,
    [orderRequest.userId, product.sku, orderRequest.quantity, product.price_cents, product.price_cents * orderRequest.quantity, this.getInstanceId()],
  );

  await client.query('COMMIT');
  return { order, remainingStock: product.stock };
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
}
```

---

## Production-Grade Verification

### 1. Reset Product Stock to 1
```bash
curl -X POST http://localhost:3000/race-demo/reset
```

### 2. Send 2 Concurrent Checkout Requests
```bash
curl -s -X POST http://localhost:3000/orders/place \
  -H 'Content-Type: application/json' \
  -d '{"userId":"user_a","sku":"prod_race_demo","quantity":1}' &

curl -s -X POST http://localhost:3000/orders/place \
  -H 'Content-Type: application/json' \
  -d '{"userId":"user_b","sku":"prod_race_demo","quantity":1}' &
wait
```

### 3. Observe the Outcome
- **One request** returns HTTP 201: `"Order confirmed. Stock decrement and order creation committed together."`
- **The other request** returns HTTP 400: `{"message": "Insufficient stock.", "error": "Bad Request"}`.
- Zero overselling.

### 4. Query PostgreSQL Directly
```bash
docker exec -it backend-logic-postgres-1 psql -U backend -d backend_mastery \
  -c "SELECT id, user_id, sku, quantity, status FROM orders WHERE sku = 'prod_race_demo'; SELECT sku, stock FROM products WHERE sku = 'prod_race_demo';"
```
Output confirms:
- **Exactly 1 order** exists in `orders`.
- `products.stock` is exactly `0` (never negative).

---

## Interview Questions & Staff-Level Answers

### 1. What is a check-then-act race condition?
A race condition where an application reads a piece of state (`check`), makes a business decision based on that observation in application memory, and subsequently writes a mutation (`act`). Because the check and the act are not performed atomically, concurrent requests can interleave and observe the same pre-mutation state, invalidating the precondition and corrupting data.

### 2. Why is an in-memory lock (like Mutex or Java `synchronized`) insufficient in production?
In production, applications run across multiple processes, containers, or Kubernetes pods behind a load balancer. An in-memory lock only synchronizes threads within a single operating system process; it has zero visibility into concurrent requests executing on sibling containers.

### 3. Compare Optimistic Locking vs Pessimistic Locking vs Atomic Conditional Updates.
- **Atomic Conditional Update (`UPDATE ... WHERE stock >= $1`):** Best performance and simplicity. Uses PostgreSQL's internal row lock for the duration of a single statement. No version column needed.
- **Optimistic Locking (`UPDATE ... WHERE version = $old_version`):** Assumes conflicts are rare. If conflict occurs, aborts and forces the application to retry. High overhead under hot-item contention (thundering herd retries).
- **Pessimistic Locking (`SELECT ... FOR UPDATE`):** Explicitly locks the row upon reading until the transaction commits. Guarantees serialization, but holds row locks open for the entire transaction lifetime, increasing lock contention and deadlock risks.

### 4. How does PostgreSQL handle multi-table ACID transactions compared to NoSQL databases?
PostgreSQL natively enforces ACID across any number of tables using Write-Ahead Logging (WAL) and Multi-Version Concurrency Control (MVCC) on any standalone or clustered instance out of the box. Distributed NoSQL stores historically avoided multi-document transactions due to partition tolerance concerns, often requiring replica sets, two-phase commit overhead, or eventual consistency.
