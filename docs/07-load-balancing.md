# 07 - Load Balancing Issues Behind Nginx

## Phase Status

This phase contains both the broken process-local implementation and the production-grade shared-state fix.

## Updated Folder Structure

```text
src/
  diagnostics/
    diagnostics.controller.ts
    diagnostics.module.ts
    diagnostics.service.ts
nginx.conf
docs/
  07-load-balancing.md
```

## Problem Scenario

The app runs fine with one container. A developer stores a counter, session, feature flag, cart, or workflow state in memory.

Then the app scales to multiple NestJS containers behind Nginx. Requests from the same user can land on different containers, each with different process memory.

Real outcome: inconsistent counters, disappearing sessions, random cart contents, confusing support tickets, and bugs that only appear after scaling.

## Broken Implementation (Code)

Instance diagnostic:

```http
GET /diagnostics/instance
```

Broken endpoint:

```http
POST /diagnostics/broken/local-counter
```

The flaw lives in:

```text
src/diagnostics/diagnostics.service.ts
```

Broken flow:

```text
Client
  |
  v
Nginx
  |
  +---------------------+
  |                     |
  v                     v
app instance A       app instance B
counter = 1          counter = 1
counter = 2          counter = 2
```

There is no single global counter. There are many local counters.

## Failure Simulation

Run multiple app instances behind Nginx. Depending on your Compose setup:

```bash
docker compose up --build --scale app=2
```

Use your active app port:

```bash
export API_BASE=http://localhost:8080
```

Call the broken endpoint repeatedly:

```bash
for i in 1 2 3 4 5 6 7 8; do
  curl -i -s -X POST "$API_BASE/diagnostics/broken/local-counter" | grep -E 'X-Upstream-Address|X-Request-Id|localCounter|instanceId'
done
```

Expected failure signals:

- `localCounter` does not increase globally by one each time.
- Different `instanceId` values may return different counter sequences.
- `X-Upstream-Address` helps identify which upstream handled the request.
- The bug may disappear with one app container and reappear when scaled.

Check Nginx logs:

```bash
docker compose logs --tail=100 proxy
```

Check app logs:

```bash
docker compose logs --tail=100 app
```

## Think

Before we fix it:

1. Why does the counter look correct with one container?
2. Why does it become inconsistent with multiple containers?
3. Should Nginx sticky sessions be the default fix?
4. Where should shared mutable state live?
5. What headers or logs help debug load-balancing issues?

Answers:

1. With one container, all requests hit the same process, so local memory looks consistent.
2. With multiple containers, each process has its own memory and its own counter.
3. No. Sticky sessions can be useful for specific legacy or connection-oriented workloads, but they should not be the default fix for shared state.
4. Shared mutable state should live in shared infrastructure: Redis for fast ephemeral counters/session-like state, MongoDB for durable business state, or another purpose-built store.
5. `X-Upstream-Address`, `X-Request-Id`, app `instanceId`, container logs, and Nginx access logs help correlate which upstream handled each request.

## Step-by-Step Fix

### Step 1 - Keep App Instances Stateless

The broken endpoint keeps state here:

```text
private localCounter = 0
```

That is only local to one Node.js process.

The fixed endpoint stores the counter in Redis:

```http
POST /diagnostics/shared-counter
```

### Step 2 - Use Redis Atomic INCR

Redis provides an atomic increment operation:

```text
INCR diagnostics:global-counter
```

Atomic means two app instances can increment at the same time and Redis will still produce one consistent sequence:

```text
1, 2, 3, 4, 5...
```

### Step 3 - Return Debug Metadata

The fixed response includes:

```text
instanceId
pid
sharedStore: redis
counterKey
globalCounter
localCounterOnThisInstance
```

This lets you prove that different app instances can answer the request while the counter remains globally consistent.

### Step 4 - Keep Nginx Debug Headers

`nginx.conf` exposes:

```text
X-Upstream-Address
X-Request-Id
```

These headers make load-balancing behavior visible from `curl -i`.

## Production-Grade Solution

### Fixed Simulation

Call the fixed endpoint repeatedly:

```bash
for i in 1 2 3 4 5 6 7 8; do
  curl -i -s -X POST "$API_BASE/diagnostics/shared-counter" | grep -E 'X-Upstream-Address|X-Request-Id|globalCounter|instanceId'
done
```

Expected behavior:

- `globalCounter` increases consistently.
- `instanceId` may change.
- `X-Upstream-Address` may change.
- Correctness no longer depends on which app container handles the request.

Check the current shared value:

```bash
curl -s "$API_BASE/diagnostics/shared-counter"
```

### Sticky Sessions: When and When Not

Sticky sessions route the same client to the same backend instance.

They are sometimes acceptable for:

- WebSocket affinity.
- Legacy apps that cannot be changed immediately.
- Short-lived migration windows.

They are a trap when used to hide:

- In-memory sessions.
- In-memory carts.
- In-memory counters.
- Missing distributed coordination.

The better backend design is stateless app containers with shared external state.

## Codex Documentation

### Concept Explanation

Load balancing spreads requests across app instances. That is good for capacity and availability, but it breaks assumptions about local memory.

If state must be shared across requests or instances, it should live in shared infrastructure such as Redis, MongoDB, or another durable service.

### Architecture Diagram

Broken:

```text
Nginx
  |
  +----------+----------+
  |                     |
  v                     v
app A memory         app B memory
counter = 4          counter = 2
```

Fixed:

```text
Nginx
  |
  +----------+----------+
  |                     |
  v                     v
app A                app B
  |                     |
  +----------+----------+
             |
             v
        Redis INCR
             |
             v
      global counter = 8
```

### Tradeoffs

- Process memory is fast, but not shared.
- Sticky sessions reduce visible inconsistency, but hide statelessness problems.
- Redis gives shared atomic counters, but adds network and operational dependency.
- MongoDB gives durable state, but may be too heavy for high-frequency counters.
- Redis counters are fast and atomic, but need persistence/backup decisions if the value is business-critical.
- Durable counters may belong in MongoDB or an event stream depending on audit requirements.

### When NOT to Use This Broken Approach

Do not store shared mutable state in app memory for:

- Sessions.
- Shopping carts.
- Rate limits.
- Counters.
- Workflow state.
- Feature flag assignments that must be consistent.

### Interview Questions

1. Why should API containers usually be stateless?
2. What are sticky sessions?
3. Why can sticky sessions be dangerous?
4. How do you debug which upstream handled a request?
5. What shared stores are appropriate for counters?
6. Why is Redis `INCR` safer than read-modify-write in app code?
7. When should a counter be stored in MongoDB instead of Redis?
8. What happens during Redis failover?
9. How would you correlate Nginx logs and app logs?
10. Why do load-balanced bugs often disappear in local development?
