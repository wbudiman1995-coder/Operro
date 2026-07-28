/**
 * Platform error model (Rule 57).
 *
 * Every application uses this one vocabulary instead of ad hoc exceptions.
 * Error codes mirror the failure modes the database itself enforces, so a
 * `ConflictError` in the app and a unique/exclusion violation in Postgres
 * describe the same thing.
 */

export type ErrorCode =
  | "AUTHORIZATION"
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "BUSINESS_RULE"
  | "CONCURRENCY"
  | "INVARIANT_VIOLATION"
  | "INTERNAL";

export interface PlatformErrorJSON {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** Base class for every platform error. */
export abstract class PlatformError extends Error {
  abstract readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    if (details !== undefined) this.details = details;
    // Restore prototype chain when transpiled to older targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): PlatformErrorJSON {
    return this.details !== undefined
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

/**
 * Access denied. `reason` mirrors `app.explain_authorization` in the database
 * (e.g. "missing_permission:booking.create", "missing_module:payroll",
 * "no_active_membership", "wrong_branch") so the app and DB explain denials
 * identically (Rules 47/53).
 */
export class AuthorizationError extends PlatformError {
  readonly code = "AUTHORIZATION" as const;
  readonly reason: string;
  constructor(reason: string, message = "Access denied") {
    super(message, { reason });
    this.reason = reason;
  }
}

/** Request failed runtime validation before reaching the database (Rule 56). */
export class ValidationError extends PlatformError {
  readonly code = "VALIDATION" as const;
  readonly issues: ReadonlyArray<{ path: string; message: string }>;
  constructor(
    issues: ReadonlyArray<{ path: string; message: string }>,
    message = "Validation failed",
  ) {
    super(message, { issues });
    this.issues = issues;
  }
}

export class ResourceNotFound extends PlatformError {
  readonly code = "NOT_FOUND" as const;
  constructor(resource: string, id?: string) {
    super(`${resource} not found`, id !== undefined ? { resource, id } : { resource });
  }
}

/** Unique/exclusion violation (e.g. double-booking, duplicate slug). */
export class ConflictError extends PlatformError {
  readonly code = "CONFLICT" as const;
}

/** A domain rule was violated (e.g. issuing an invoice for a canceled order). */
export class BusinessRuleError extends PlatformError {
  readonly code = "BUSINESS_RULE" as const;
}

/** Optimistic-concurrency / stale-write failure. */
export class ConcurrencyError extends PlatformError {
  readonly code = "CONCURRENCY" as const;
}

/**
 * A guarantee that should have been impossible was violated. Signals a bug or
 * a bypass of the platform layers, never normal user error.
 */
export class InvariantViolation extends PlatformError {
  readonly code = "INVARIANT_VIOLATION" as const;
}

export class InternalError extends PlatformError {
  readonly code = "INTERNAL" as const;
}

/** Narrow an unknown thrown value to a PlatformError. */
export function isPlatformError(e: unknown): e is PlatformError {
  return e instanceof PlatformError;
}
