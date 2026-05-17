# 06 - Cache Layer Failure

## Phase Status

This phase contains both the broken cache-only implementation and the production-grade cache-aside fix.

## Updated Folder Structure

```text
src/
  cache/
    cache.module.ts
    redis-cache.service.ts
  product/
    product.controller.ts
    product.service.ts
docs/
  06-cache-layer-failure.md
```

## Problem Scenario

A product details endpoint is slow, so the team adds Redis caching. At first, latency improves.

Then Redis restarts during deploy, hits max memory, loses network connectivity, or has a brief failover. Instead of falling back to MongoDB, the API fails because the implementation treats Redis as required infrastructure for reads.

Real outcome: product pages go down even though MongoDB still has every product.

## Broken Implementation (Code)

Warm cache:

```http
POST /products/:sku/cache/warm
```

Broken endpoint:

```http
GET /products/broken/cache-only/:sku
```

The flaw lives in:

```text
src/product/product.service.ts
src/cache/redis-cache.service.ts
```

Broken flow:

```text
Client
  |
  v
GET /products/broken/cache-only/prod_n1_keyboard
  |
  v
Redis GET cache:products:prod_n1_keyboard
  |
  +-- Redis hit  -> return product
  |
  +-- Redis down -> request fails
  |
  +-- Redis miss -> return null even though MongoDB has product
```

This is cache-as-source-of-truth, which is wrong for this product read.

## Failure Simulation

Use your active app port:

```bash
export API_BASE=http://localhost:8080
```

Seed products from Phase 4:

```bash
curl -s -X POST "$API_BASE/n-plus-one-demo/seed"
```

Warm one product into Redis:

```bash
curl -s -X POST "$API_BASE/products/prod_n1_keyboard/cache/warm"
```

Read from the broken endpoint:

```bash
curl -s "$API_BASE/products/broken/cache-only/prod_n1_keyboard"
```

Now stop Redis or disconnect it from the app. Depending on your Compose setup, this may be:

```bash
docker compose stop redis
```

Call the broken endpoint again:

```bash
curl -i "$API_BASE/products/broken/cache-only/prod_n1_keyboard"
```

Expected failure signals:

- The endpoint fails or hangs when Redis is unavailable.
- A Redis miss returns `product: null` even if MongoDB contains the product.
- MongoDB is never consulted by the broken endpoint.

## Think

Before we fix it:

1. Should Redis be required for product reads?
2. What is the true source of truth here?
3. Why is returning `null` on cache miss dangerous?
4. What should happen if Redis is down but MongoDB is healthy?
5. What timeout should a cache call have in production?

Answers:

1. No. Redis should not be required for this product read. It is an optimization layer.
2. MongoDB is the source of truth. Redis stores temporary copies.
3. Returning `null` on cache miss lies to the caller. A cache miss means "not in cache", not "product does not exist".
4. The API should read from MongoDB, return the product, and optionally repopulate Redis best-effort.
5. Cache calls should have short timeouts. In this demo the fixed endpoint uses `75ms`; real values depend on latency budgets and infrastructure.

## Step-by-Step Fix

### Step 1 - Add a Safe Product Endpoint

Fixed endpoint:

```http
GET /products/:sku
```

This route uses cache-aside:

```text
try Redis
  |
  +-- hit -> return product
  |
  +-- miss -> read MongoDB -> best-effort cache set -> return product
  |
  +-- failure/timeout -> read MongoDB -> best-effort cache set -> return product
```

### Step 2 - Add Short Redis Timeouts

The fixed endpoint wraps Redis operations with a short timeout:

```text
75ms
```

Why: cache should not consume the whole request latency budget. If Redis is slow, move on to MongoDB.

### Step 3 - Repopulate Cache Best-Effort

After MongoDB fallback, the service tries to write the product back to Redis:

```text
set cache key with TTL 60 seconds
```

If that write fails, the API still returns the product. Cache population is useful, but not required for correctness.

### Step 4 - Return Source Metadata

The fixed endpoint tells you where the data came from:

```text
redis
mongo-cache-miss
mongo-cache-failure
```

This is teaching metadata. In a production public API you might keep this in logs, traces, or debug headers instead of the response body.

## Production-Grade Solution

### Fixed Simulation

Seed data:

```bash
curl -s -X POST "$API_BASE/n-plus-one-demo/seed"
```

First read. If cache is empty, expect MongoDB fallback:

```bash
curl -s "$API_BASE/products/prod_n1_keyboard"
```

Expected:

```json
{
  "source": "mongo-cache-miss",
  "cacheRepopulated": true
}
```

Second read. If Redis is healthy, expect cache hit:

```bash
curl -s "$API_BASE/products/prod_n1_keyboard"
```

Expected:

```json
{
  "source": "redis"
}
```

Stop Redis:

```bash
docker compose stop redis
```

Read again:

```bash
curl -s "$API_BASE/products/prod_n1_keyboard"
```

Expected:

```json
{
  "source": "mongo-cache-failure",
  "cacheHealthy": false,
  "product": {
    "sku": "prod_n1_keyboard"
  }
}
```

The product read survives because MongoDB is still available.

### Production Design

```text
Client
  |
  v
NestJS product endpoint
  |
  +-- Redis hit -> fast response
  |
  +-- Redis miss/failure/timeout
          |
          v
        MongoDB source of truth
          |
          v
        best-effort Redis set
```

Operational rules:

- Treat Redis as optional for read correctness unless Redis is the explicit source of truth.
- Use short Redis timeouts.
- Add metrics for hit rate, miss rate, fallback rate, and Redis errors.
- Use TTLs with jitter in high-traffic systems to avoid stampedes.
- Consider stale-while-revalidate for read-heavy, tolerance-for-staleness data.
- Protect MongoDB from cache stampedes with request coalescing or distributed locks for very hot keys.

## Codex Documentation

### Concept Explanation

A cache should usually improve latency or reduce load. It should not become the source of truth unless the system is explicitly designed that way.

For product reads, MongoDB owns the data. Redis is a temporary acceleration layer.

### Architecture Diagram

Broken:

```text
Client
  |
  v
NestJS
  |
  v
Redis only
  |
  +-- down or miss -> failed product read
```

Fixed:

```text
Client
  |
  v
NestJS
  |
  +-- Redis hit -> product
  |
  +-- Redis miss/down
          |
          v
        MongoDB
          |
          v
        product + best-effort cache set
```

### Tradeoffs

- Redis is fast, but volatile.
- MongoDB is slower than cache, but durable.
- Cache-aside adds code paths, but makes cache outages survivable.
- Serving stale cache can improve availability, but risks outdated data.
- Short timeouts protect latency, but can increase MongoDB fallback traffic during Redis slowness.
- Best-effort cache writes keep the response path resilient, but failures need observability.

### When NOT to Use This Broken Approach

Do not make Redis mandatory for:

- Product details backed by MongoDB.
- User profile reads backed by a durable database.
- Order history.
- Admin dashboards.
- Any read where the database can still answer correctly.

### Interview Questions

1. What is cache-aside?
2. What is the source of truth in a cached read path?
3. What should happen on cache miss?
4. What should happen when Redis is down?
5. How do TTLs affect freshness and load?
6. Why is `null` from Redis not the same as "record not found"?
7. What metrics would you add to this cache layer?
8. What is a cache stampede?
9. When would stale cache be acceptable?
10. When is Redis allowed to be the source of truth?
