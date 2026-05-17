# 04 - N+1 Query Problem in MongoDB

## Phase Status

This phase contains both the broken N+1 implementation and the production-grade aggregation fix.

## Updated Folder Structure

```text
src/
  product/
    product.service.ts
  order/
    order.controller.ts
    order.service.ts
docs/
  04-n-plus-one.md
```

## Problem Scenario

The orders dashboard is fast during development. A developer tests it with three orders and everything looks fine.

Then production grows. The dashboard loads 30, 100, or 500 orders. For every order row, the API fetches the product separately. One request quietly becomes many database round trips.

Real outcome: slow dashboard, MongoDB connection pool pressure, noisy query logs, and API latency that grows linearly with page size.

## Broken Implementation (Code)

Seed demo data:

```http
POST /n-plus-one-demo/seed
```

Broken endpoint:

```http
GET /orders/broken/with-products
```

The flaw lives in:

```text
src/order/order.service.ts
```

Broken flow:

```text
GET /orders/broken/with-products
  |
  v
query orders once
  |
  v
for each order:
  query product by sku
  query product by sku
  query product by sku
  ...
```

For 30 orders, the endpoint performs:

```text
1 orders query + 30 product queries = 31 MongoDB queries
```

## Failure Simulation

Use your active app port:

```bash
export API_BASE=http://localhost:8080
```

Seed the demo:

```bash
curl -s -X POST "$API_BASE/n-plus-one-demo/seed"
```

Call the broken endpoint:

```bash
curl -s "$API_BASE/orders/broken/with-products"
```

Expected failure signals in the response:

```json
{
  "queryShape": "1 orders query + N product queries",
  "orderCount": 30,
  "productQueryCount": 30,
  "totalMongoQueries": 31
}
```

Run it a few times. The query count is deterministic even if the elapsed time varies.

## Think

Before we fix it:

1. Why does this look harmless with only three orders?
2. Why does latency grow as page size grows?
3. Why is this especially dangerous under concurrent dashboard traffic?
4. Why are repeated products still fetched repeatedly?
5. What MongoDB tool could fetch orders and product data in one database-side pipeline?

## Step-by-Step Fix

### Step 1 - Stop Querying Products Inside a Loop

The broken endpoint does this:

```text
orders = find orders
for order in orders:
  product = find product by sku
```

The fixed endpoint moves the relationship lookup into MongoDB:

```http
GET /orders/with-products
```

### Step 2 - Use an Aggregation Pipeline

The fixed route uses:

```text
$match   only demo SKUs
$sort    newest orders first
$limit   cap the page size
$lookup  join products by sku
$unwind  convert product array into one object
$project return only needed fields
```

This changes the query shape from:

```text
1 + N round trips
```

to:

```text
1 database command
```

### Step 3 - Add Indexes for the Access Pattern

Indexes in this phase:

```text
orders:   { sku: 1, createdAt: -1 }
orders:   { createdAt: -1 }
orders:   { status: 1, createdAt: -1 }
products: { sku: 1 } unique
```

The important `$lookup` index is `products.sku`. Without it, MongoDB has to work too hard to match product rows.

### Step 4 - Prove the Query Shape Changed

Broken endpoint response:

```json
{
  "queryShape": "1 orders query + N product queries",
  "totalMongoQueries": 31
}
```

Fixed endpoint response:

```json
{
  "queryShape": "1 aggregation pipeline with $lookup",
  "totalMongoQueries": 1
}
```

## Production-Grade Solution

### Fixed Endpoint

```bash
curl -s "$API_BASE/orders/with-products"
```

Expected response metadata:

```json
{
  "queryShape": "1 aggregation pipeline with $lookup",
  "orderCount": 30,
  "productQueryCount": 0,
  "totalMongoQueries": 1
}
```

### Why It Works Under Scale

- The NestJS process sends one database command instead of issuing product lookups in a loop.
- MongoDB performs the join-like work close to the data.
- The result is capped with `$limit`.
- `$project` avoids returning entire product documents.
- Indexes support the sort/filter and product lookup.

### When Aggregation Is Not Enough

If this dashboard becomes extremely hot, a further production step may denormalize a product snapshot into each order:

```text
order.productSnapshot.name
order.productSnapshot.priceCents
```

That avoids `$lookup`, but introduces a new tradeoff: product changes no longer automatically appear on historical orders. For order history, that is often correct; for live catalog views, it may not be.

## Codex Documentation

### Concept Explanation

The N+1 query problem happens when one query fetches a parent list, then the application performs one extra query for each item in that list.

```text
1 query for N orders
N queries for each order's product
```

The danger is that the endpoint's database work grows with result size.

### Architecture Diagram

Broken:

```text
NestJS
  |
  | 1 query
  v
MongoDB orders
  |
  | N queries from a loop
  v
MongoDB products
```

Fixed:

```text
NestJS
  |
  | 1 aggregation command
  v
MongoDB orders
  |
  | $lookup by indexed sku
  v
MongoDB products
```

### Tradeoffs

- Application loops are easy to write, but hide query amplification.
- Aggregation pipelines are more explicit and can be harder to read at first.
- `$lookup` is powerful, but still needs indexes and careful projection.
- Denormalization can avoid joins, but creates synchronization complexity.
- Aggregation centralizes data work in MongoDB; that is good for round trips, but very large pipelines still need profiling.

### When NOT to Use This Broken Approach

Do not fetch related data one row at a time for:

- Dashboards.
- Admin tables.
- Reports.
- Export endpoints.
- Feed APIs.
- Any endpoint with pagination or bulk reads.

### Interview Questions

1. What is the N+1 query problem?
2. Why does it often pass local testing?
3. How can MongoDB aggregation reduce round trips?
4. What indexes matter for `$lookup` by `sku`?
5. When would you denormalize product data into orders instead?
6. Why should `$limit` happen before `$lookup` for dashboard pages?
7. What fields should you project out of the product document?
8. How would you compare the broken and fixed endpoints in production telemetry?
9. When can `$lookup` become a bottleneck?
10. Why might historical orders store a product snapshot?
