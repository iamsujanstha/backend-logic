# 05 - Blocking the Node.js Event Loop

## Phase Status

This phase contains both the broken event-loop implementation and the production-grade worker-thread fix.

## Updated Folder Structure

```text
src/
  cpu/
    cpu-job.processor.ts
    cpu-queue.constants.ts
    cpu.controller.ts
    cpu.module.ts
    cpu.service.ts
    cpu-worker.module.ts
    cpu-worker.util.ts
    workers/
      fibonacci.worker.ts
  queue/
    queue.module.ts
    redis-connection.ts
  worker.module.ts
  worker.ts
docker-compose.worker.yml
docs/
  05-blocking-event-loop.md
```

## Problem Scenario

An API endpoint generates a large report, resizes images, hashes a huge payload, or performs a complex calculation directly inside the request handler.

It passes local testing. Then one expensive request hits production and the entire Node.js process becomes sluggish. Even cheap health checks wait because the event loop is busy running CPU work.

Real outcome: latency spikes, readiness checks fail, Nginx retries, autoscaling misreads the service, and users see timeouts even on unrelated endpoints.

## Broken Implementation (Code)

Cheap endpoint:

```http
GET /cpu/health
```

Broken CPU endpoint:

```http
GET /cpu/broken/fibonacci/42
```

The flaw lives in:

```text
src/cpu/cpu.service.ts
```

Broken flow:

```text
Request A: /cpu/broken/fibonacci/42
  |
  v
recursive CPU calculation on Node.js event loop
  |
  v
Request B: /cpu/health waits behind it
```

Node.js handles asynchronous I/O well, but JavaScript CPU work still runs on the main event loop unless moved elsewhere.

## Failure Simulation

Use your active app port:

```bash
export API_BASE=http://localhost:8080
```

Start a CPU-heavy request:

```bash
curl -s "$API_BASE/cpu/broken/fibonacci/42" &
```

Immediately call the cheap health endpoint:

```bash
time curl -s "$API_BASE/cpu/health"
```

Expected failure signals:

- The health request is delayed even though it does almost no work.
- The blocked instance cannot process other requests until Fibonacci finishes.
- If Nginx sends the health request to a different app instance, it may respond quickly; repeat a few times to see per-instance blocking.

To increase pressure:

```bash
for i in 1 2 3; do
  curl -s "$API_BASE/cpu/broken/fibonacci/42" &
done

time curl -s "$API_BASE/cpu/health"
wait
```

## Think

Before we fix it:

1. Why does CPU-heavy JavaScript block unrelated requests?
2. Why does async/await not solve CPU-bound work?
3. Why might the failure seem inconsistent behind Nginx?
4. What is the difference between I/O concurrency and CPU parallelism?
5. When should this work move to a worker thread versus a queue?

## Step-by-Step Fix

### Step 1 - Bound the Input

Both endpoints reject unsafe inputs:

```text
number must be a non-negative integer
number must be <= 45
```

Even with workers, production systems need input limits. A worker thread is not permission to run unbounded CPU jobs.

### Step 2 - Move CPU Work to a Worker Thread

Fixed endpoint:

```http
GET /cpu/fibonacci/42
```

The NestJS request handler starts a Node.js worker thread:

```text
main event loop
  |
  | spawn worker
  v
worker thread calculates Fibonacci
  |
  | postMessage result
  v
main event loop sends response
```

The CPU-heavy calculation still consumes CPU, but it no longer monopolizes the main event loop.

### Step 3 - Keep the Broken Endpoint

Broken:

```text
GET /cpu/broken/fibonacci/42
```

Fixed:

```text
GET /cpu/fibonacci/42
```

Keeping both endpoints makes the event-loop difference visible.

### Step 4 - Know When Worker Threads Are Not Enough

Worker threads are good for CPU-bound work that must finish during the request.

Use a queue instead when the job is:

- Long-running.
- Retryable.
- User-visible as background progress.
- Safe to finish after the HTTP request returns.
- Better controlled with concurrency limits and rate limits.

### Step 5 - Move Long Work to a Redis-Backed Queue

Production endpoint:

```http
GET /cpu/jobs/fibonacci/42
```

Instead of waiting for Fibonacci in the request, the API stores a job in Redis through BullMQ and returns a job id:

```json
{
  "message": "Accepted: CPU-heavy work was queued in Redis for a worker process.",
  "jobId": "fib_42_...",
  "queue": "cpu-jobs",
  "statusUrl": "/cpu/jobs/fib_42_..."
}
```

Check status:

```http
GET /cpu/jobs/:jobId
```

This is the common production shape:

```text
API request
  |
  v
enqueue job in Redis
  |
  v
return job id immediately
  |
  v
separate worker process consumes job
  |
  v
client polls status/result
```

## Production-Grade Solution

### Fixed Simulation

Run the fixed CPU request:

```bash
curl -s "$API_BASE/cpu/fibonacci/42" &
```

Immediately call health:

```bash
time curl -s "$API_BASE/cpu/health"
wait
```

Expected behavior:

- The Fibonacci request still takes time.
- The health request remains responsive because the main event loop is free.

### Production Design

```text
Short CPU task needed inline:
  request -> worker thread -> response

Long CPU task:
  request -> queue job -> 202 Accepted -> worker process -> status endpoint
```

In a larger system, the next evolution would be BullMQ:

```text
NestJS API
  |
  v
Redis-backed BullMQ queue
  |
  v
separate worker process
```

That model gives retries, concurrency limits, delayed jobs, and operational visibility.

This repo now implements that shape:

```text
src/main.ts       API process
src/worker.ts     worker process
Redis             queue state
BullMQ            job lifecycle
```

### Production Queue Simulation

Start API plus worker:

```bash
docker compose -f docker-compose.yml -f docker-compose.worker.yml up --build
```

Enqueue a CPU job:

```bash
curl -s "$API_BASE/cpu/jobs/fibonacci/42"
```

Poll the returned job id:

```bash
curl -s "$API_BASE/cpu/jobs/<jobId>"
```

Expected lifecycle:

```text
waiting -> active -> completed
```

Completed jobs include a `result` payload with the Fibonacci result, worker instance id, and timing.

### How Big Teams Usually Run This

```text
Nginx / load balancer
  |
  v
API containers: stateless, fast, no long CPU work
  |
  v
Redis / queue broker
  |
  v
Worker containers: CPU or IO jobs, scaled separately
  |
  v
MongoDB / object storage / downstream systems
```

Operational rules:

- API returns `202 Accepted` style responses with job ids.
- Workers have capped concurrency.
- Jobs have attempts and exponential backoff.
- Job payloads stay small; large files live in object storage.
- Results are stored durably when they matter.
- Workers scale independently from API containers.
- Dead-letter queues or failed-job dashboards are monitored.
- Idempotency keys are used for job creation when duplicate submits are possible.

## Codex Documentation

### Concept Explanation

The Node.js event loop runs JavaScript callbacks. While one callback is doing CPU-heavy work, the process cannot run the next callback. That means an expensive calculation can delay unrelated requests, timers, logging, and response handling.

### Architecture Diagram

Broken:

```text
Nginx
  |
  v
NestJS instance
  |
  v
main event loop
  |
  v
CPU-heavy Fibonacci blocks everything else
```

Fixed:

```text
Nginx
  |
  v
NestJS instance
  |
  v
main event loop remains responsive
  |
  +--> worker thread does CPU-heavy Fibonacci
```

Production queue:

```text
Client
  |
  v
API container
  |
  | add job
  v
Redis BullMQ queue
  |
  | consume
  v
Worker container
  |
  | worker thread for CPU isolation
  v
result stored in job state
```

### Tradeoffs

- Running CPU work inline is simple, but blocks the process.
- Worker threads add overhead, but isolate CPU work from the event loop.
- Queues add operational complexity, but are better for long-running jobs, retries, and progress tracking.
- Spawning one worker per request is fine for a demo, but production systems should use a pool or queue to cap CPU concurrency.
- Worker threads share process memory pressure; separate worker processes provide stronger isolation.
- Redis-backed queues are not free: Redis persistence, memory sizing, retry storms, and monitoring matter.
- Queueing makes work eventually consistent; clients need polling, webhooks, or push notifications.

### When NOT to Use This Broken Approach

Do not run heavy CPU work inline for:

- Report generation.
- Image or video processing.
- PDF generation.
- Large cryptographic workloads.
- Large compression/decompression jobs.
- Machine learning inference.

### Interview Questions

1. What is the Node.js event loop?
2. Why does CPU-bound work block unrelated requests?
3. Why is async/await not a CPU parallelism tool?
4. When should you use worker threads?
5. When should you use a queue instead of doing work in a request?
6. Why should worker concurrency be capped?
7. What is the difference between worker threads and child processes?
8. How would Nginx timeouts affect a long-running CPU request?
9. What metrics would reveal event-loop blocking?
10. Why is a queue usually better for report generation?
11. Why should API and worker containers scale independently?
12. What belongs in a job payload, and what should live in object storage?
13. How do attempts and backoff prevent transient failures from becoming user-facing failures?
14. What is a dead-letter queue?
15. How would you make job creation idempotent?
