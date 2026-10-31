# 04 — N+1 Query Problem in PostgreSQL

## Phase Status

This phase contains both the broken N+1 implementation and the production-grade SQL `JOIN` with relational JSON aggregation (`json_build_object`).

## Folder Structure

```text
src/
  product/
    product.service.ts
  order/
    order.controller.ts
    order.service.ts         <-- Broken loop vs SQL JOIN implementation
db/
  init/
    001_schema.sql           <-- orders & products tables with B-Tree indexes
docs/
  04-n-plus-one.md
```

---

## Problem Scenario

The orders dashboard is fast during development. A developer tests it with three orders and everything looks fine.

Then production grows. The dashboard loads 30, 100, or 500 orders. For every order row, the API queries the product separately in a loop. One request quietly becomes many database round trips ($1 + N$).

**Real outcome:** Slow dashboard, PostgreSQL connection pool saturation, noisy query logs, high network latency, and API response times that scale linearly with page size ($O(N)$).

---

## Broken Implementation (Code)

Seed demo data:
```bash
curl -X POST http://localhost:3000/n-plus-one-demo/seed
```

Broken endpoint:
```bash
curl -s http://localhost:3000/orders/broken/with-products
```

The flaw lives in `src/order/order.service.ts`:

```ts
// Flaw: 1 initial query to get orders
const { rows: orders } = await this.pool.query(
  'SELECT * FROM orders WHERE sku = ANY($1) ORDER BY created_at DESC LIMIT 30',
  [N_PLUS_ONE_DEMO_SKUS],
);

// Flaw: N queries inside a JavaScript for-loop across the network
for (const order of orders) {
  const product = await this.productService.findBySku(order.sku); // Executes SELECT * FROM products WHERE sku = $1
  enrichedOrders.push({ ...order, product });
}
```

### Broken Flow

```text
Client -> GET /orders/broken/with-products
  -> Query 1: SELECT * FROM orders ... (returns 30 rows)
  -> Query 2: SELECT * FROM products WHERE sku = 'prod_1'
  -> Query 3: SELECT * FROM products WHERE sku = 'prod_2'
  ...
  -> Query 31: SELECT * FROM products WHERE sku = 'prod_30'
Total queries = 1 + 30 = 31 round trips over the TCP socket!
```

---

## Step-by-Step Fix (Production Architecture)

### Step 1 — Move the Relationship Lookup into PostgreSQL
Instead of round-tripping across TCP 30 times, have the PostgreSQL query planner perform an indexed join close to the disk:

```http
GET /orders/with-products
```

### Step 2 — Single Roundtrip SQL JOIN with `json_build_object`
The fixed query in `src/order/order.service.ts`:

```sql
SELECT 
  o.id,
  o.user_id,
  o.sku,
  o.quantity,
  o.status,
  o.unit_price_cents,
  o.total_cents,
  o.instance_id,
  o.created_at,
  json_build_object(
    'sku', p.sku,
    'name', p.name,
    'priceCents', p.price_cents
  ) AS product
FROM orders o
LEFT JOIN products p ON o.sku = p.sku
WHERE o.sku = ANY($1)
ORDER BY o.created_at DESC
LIMIT 30;
```

This transforms the performance characteristics:
- **Round trips:** Reduced from $1 + N$ to **1 single database round trip**.
- **Data shaping:** PostgreSQL natively packages the related product data as a nested JSON object (`json_build_object`), eliminating in-memory JavaScript mapping.

### Step 3 — B-Tree Indexes for the Access Pattern
The database schema (`db/init/001_schema.sql`) declares:

```sql
CREATE INDEX IF NOT EXISTS orders_sku_created_idx ON orders(sku, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at DESC);
```
And `products.sku` is a primary key (`PRIMARY KEY (sku)`), giving $O(\log N)$ B-tree index lookup for the `JOIN` condition.

---

## Production-Grade Verification

```bash
curl -s http://localhost:3000/orders/with-products
```

Expected response metadata:
```json
{
  "message": "Fixed: PostgreSQL query loads orders and product data in one database command.",
  "queryShape": "1 SQL query with LEFT JOIN and json_build_object",
  "orderCount": 30,
  "productQueryCount": 0,
  "totalQueries": 1,
  "indexesUsedByDesign": [
    "orders: orders_sku_created_idx (sku, created_at DESC)",
    "products: products_pkey (sku) unique"
  ]
}
```

---

## Interview Questions & Staff-Level Answers

### 1. What is the fundamental cause of the N+1 query problem?
The N+1 problem occurs when an application fetches a collection of parent entities with 1 query, and then issues $N$ subsequent individual queries across the network to retrieve related child entities for each parent item (typically within an ORM loop or un-batched service call).

### 2. Why is N+1 worse in distributed/microservice architectures than on a local database?
Locally, network latency is sub-millisecond, masking the inefficiency. In production (where database or services communicate across VPC networks or availability zones with 1–5ms latency), 100 queries generate 100–500ms of pure idle network waiting time, holding connection pool threads hostage and degrading total API throughput.

### 3. How does SQL `LEFT JOIN` with `json_build_object` compare to ORM eager loading or DataLoader?
- **SQL JOIN + `json_build_object`:** Executes in a single database round trip and delegates relational assembly directly to PostgreSQL's C engine. Zero ORM memory overhead.
- **DataLoader (Batching):** Executes 2 queries (1 for parent rows, 1 for all child IDs via `WHERE id = ANY(...)`) and stitches them in Node.js memory. Best suited for GraphQL where dynamic fields cannot be known ahead of time.
- **ORM Eager Loading (`include`/`relations`):** Often produces Cartesian products if multiple collections are joined, or silently falls back to multiple un-batched queries if misconfigured.

### 4. How do you analyze whether your JOIN is hitting the index in PostgreSQL?
By running `EXPLAIN (ANALYZE, BUFFERS)` on the query. Look for:
- `Index Scan` or `Bitmap Index Scan` instead of `Seq Scan` (sequential table scan).
- `Hash Join` or `Merge Join` for joining indexed sets.
- `Buffers: shared hit` indicating data was read directly from PostgreSQL's shared buffer cache without disk I/O.
