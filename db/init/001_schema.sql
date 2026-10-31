CREATE TABLE IF NOT EXISTS products (
  sku text PRIMARY KEY,
  name text NOT NULL,
  stock integer NOT NULL CHECK (stock >= 0),
  price_cents integer NOT NULL CHECK (price_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  sku text NOT NULL REFERENCES products(sku),
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL CHECK (status IN ('confirmed', 'rejected')),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents > 0),
  total_cents integer NOT NULL CHECK (total_cents > 0),
  instance_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_sku_created_idx ON orders(sku, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  order_id text NOT NULL UNIQUE,
  user_id text NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'succeeded', 'failed')),
  gateway_charge_id text,
  response_payload jsonb,
  failure_reason text,
  instance_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Lesson 08 — Transactional Outbox
-- ---------------------------------------------------------------------------

-- Outbox: durable intent committed atomically with the order
CREATE TABLE IF NOT EXISTS outbox_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id bigint NOT NULL REFERENCES orders(id),
  type text NOT NULL,
  version smallint NOT NULL DEFAULT 1,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'publishing', 'published', 'failed')),
  attempts smallint NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  claim_token uuid,
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON outbox_events (status, available_at) WHERE status IN ('pending', 'publishing');
CREATE INDEX IF NOT EXISTS outbox_lease_expired_idx
  ON outbox_events (lease_until) WHERE status = 'publishing';

-- Fulfillment: the local business effect produced by processing an outbox event
CREATE TABLE IF NOT EXISTS fulfillments (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL UNIQUE REFERENCES orders(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Processed events: consumer idempotency receipt
CREATE TABLE IF NOT EXISTS processed_events (
  consumer_name text NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, event_id)
);
