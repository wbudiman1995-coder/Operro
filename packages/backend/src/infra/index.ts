/**
 * Infrastructure ports (Rule 66) — interfaces only. Services depend on these,
 * never on concrete Supabase/pg types, so the production wiring and the in-memory
 * test wiring are a container swap, not a rewrite.
 */

/** A row-returning DB client. `rpc` calls a Postgres function by name. */
export interface DatabaseClient {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>;
  /** Read query returning rows (SELECT through PostgREST/pg). */
  select<T = unknown>(
    table: string,
    query: Record<string, unknown>,
  ): Promise<ReadonlyArray<T>>;
}

/**
 * Transaction boundary. PostgREST has no interactive transactions, so the
 * production implementation wraps a multi-step unit in a single Postgres
 * function/RPC or a serverless pg connection. The interface makes atomicity a
 * swap, not a rewrite (Rule 64).
 */
export interface TransactionManager {
  run<T>(work: (db: DatabaseClient) => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}

/** Observational side effects only (Rules 50/64) — never business enforcement. */
export interface TimelinePort {
  record(event: {
    organizationId: string;
    subjectType: string;
    subjectId: string;
    eventType: string;
    data?: Record<string, unknown>;
  }): Promise<void>;
}

export interface NotificationPort {
  queue(notification: {
    organizationId: string;
    kind: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

export interface EntitlementsPort {
  loadForUser(input: {
    userId: string;
    organizationId: string;
  }): Promise<{
    permissions: ReadonlyArray<string>;
    modules: ReadonlyArray<string>;
    features: ReadonlyArray<string>;
    branches: ReadonlyArray<string>;
    membershipId?: string;
    isPlatformAdmin: boolean;
  }>;
}
