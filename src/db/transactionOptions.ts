/**
 * Interactive-transaction limits for the endpoints that serialize on an
 * Event row lock (register, cancel).
 *
 * Prisma's defaults (maxWait 2s to get a connection, 5s for the whole
 * transaction) are too tight here on purpose-built contention: every request
 * for the same event queues behind the Event row lock, and lock-wait time
 * counts against `timeout`. A burst of N requests therefore needs roughly
 * N x (one transaction's duration) for the last one to finish, which on a
 * hosted/pooled Postgres easily passes 5s and surfaces as a 500.
 */
export const EVENT_LOCK_TX_OPTIONS = {
  maxWait: 10_000,
  timeout: 20_000,
} as const;
