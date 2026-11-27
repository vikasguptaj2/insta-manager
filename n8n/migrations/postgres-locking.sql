-- InstaOps v2.0 Durable Locking & Idempotency Schema
-- Isolated inside schema `instaops_v2` so n8n internal tables in `public` are never modified.
-- Execute explicitly after provisioning PostgreSQL and configuring DATABASE_URL.

CREATE SCHEMA IF NOT EXISTS instaops_v2;

CREATE TABLE IF NOT EXISTS instaops_v2.job_locks (
  lock_key TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_instaops_v2_locks_expires
  ON instaops_v2.job_locks (expires_at);

CREATE TABLE IF NOT EXISTS instaops_v2.jobs (
  job_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  execution_id TEXT NOT NULL DEFAULT '',
  post_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_instaops_v2_jobs_post_created
  ON instaops_v2.jobs (post_id, created_at DESC);

CREATE TABLE IF NOT EXISTS instaops_v2.idempotency_keys (
  idem_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  response_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_instaops_v2_idem_expires
  ON instaops_v2.idempotency_keys (expires_at);
