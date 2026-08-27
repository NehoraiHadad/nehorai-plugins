/**
 * Credit system error classes - framework agnostic
 *
 * Provides typed error handling for credit operations.
 * These errors can be used across different environments.
 */

/**
 * Error codes for credit operations
 */
export const CreditErrorCode = {
  INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",
  RESERVATION_NOT_FOUND: "RESERVATION_NOT_FOUND",
  RESERVATION_EXPIRED: "RESERVATION_EXPIRED",
  RESERVATION_ALREADY_PROCESSED: "RESERVATION_ALREADY_PROCESSED",
  USER_NOT_FOUND: "USER_NOT_FOUND",
  INVALID_OPERATION_TYPE: "INVALID_OPERATION_TYPE",
  CONFIGURATION_ERROR: "CONFIGURATION_ERROR",
  DATABASE_ERROR: "DATABASE_ERROR",
  /** Caller reused an idempotency key with a different immutable payload. */
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  /**
   * Retryable infrastructure failure — serialization/deadlock, lock timeout,
   * connection loss, pool exhaustion. Distinct from `DATABASE_ERROR`, which is
   * a deterministic failure that will fail again identically on retry.
   */
  TRANSIENT_ERROR: "TRANSIENT_ERROR",
  /** The configured repository adapter does not implement the requested V2 method. */
  UNSUPPORTED_OPERATION: "UNSUPPORTED_OPERATION",
  /** Amount was not a finite positive number. */
  INVALID_AMOUNT: "INVALID_AMOUNT",
} as const;

export type CreditErrorCodeType = (typeof CreditErrorCode)[keyof typeof CreditErrorCode];

/**
 * Custom error class for credit operations
 *
 * Provides structured error information including:
 * - Error code for programmatic handling
 * - Human-readable message
 * - Optional details for debugging
 */
export class CreditError extends Error {
  public readonly code: CreditErrorCodeType;
  public readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: CreditErrorCodeType,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CreditError";
    this.code = code;
    this.details = details;

    // Maintains proper stack trace for where error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CreditError);
    }
  }

  /**
   * Convert to JSON-serializable object
   */
  toJSON(): { name: string; code: string; message: string; details?: Record<string, unknown> } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.details && { details: this.details }),
    };
  }
}

/**
 * Type guard to check if an error is a CreditError
 */
export function isCreditError(error: unknown): error is CreditError {
  return error instanceof CreditError;
}

/**
 * Check if an error represents insufficient credits
 *
 * Works with both CreditError and regular Error instances.
 * Useful for handling errors from different sources.
 */
export function isInsufficientCreditsError(error: unknown): boolean {
  if (isCreditError(error)) {
    return error.code === CreditErrorCode.INSUFFICIENT_CREDITS;
  }

  if (error instanceof Error) {
    return error.message.toLowerCase().includes("insufficient credits");
  }

  return false;
}

/**
 * Create an insufficient credits error
 */
export function createInsufficientCreditsError(
  required: number,
  available: number
): CreditError {
  return new CreditError(
    `Insufficient credits: available ${available}, required ${required}`,
    CreditErrorCode.INSUFFICIENT_CREDITS,
    { required, available, shortfall: required - available }
  );
}

/**
 * Create a reservation not found error
 */
export function createReservationNotFoundError(reservationId: string): CreditError {
  return new CreditError(
    `Reservation ${reservationId} not found`,
    CreditErrorCode.RESERVATION_NOT_FOUND,
    { reservationId }
  );
}

/**
 * Create a reservation expired error
 */
export function createReservationExpiredError(reservationId: string): CreditError {
  return new CreditError(
    `Reservation ${reservationId} has expired`,
    CreditErrorCode.RESERVATION_EXPIRED,
    { reservationId }
  );
}

/**
 * Create a reservation already processed error
 */
export function createReservationAlreadyProcessedError(
  reservationId: string,
  status: string
): CreditError {
  return new CreditError(
    `Reservation ${reservationId} has already been ${status}`,
    CreditErrorCode.RESERVATION_ALREADY_PROCESSED,
    { reservationId, status }
  );
}

/**
 * Create a user not found error
 */
export function createUserNotFoundError(userId: string): CreditError {
  return new CreditError(
    `User ${userId} not found`,
    CreditErrorCode.USER_NOT_FOUND,
    { userId }
  );
}

/**
 * Create an invalid operation type error
 */
export function createInvalidOperationTypeError(
  operationType: string,
  validTypes: string[]
): CreditError {
  return new CreditError(
    `Invalid operation type: ${operationType}. Valid types: ${validTypes.join(", ")}`,
    CreditErrorCode.INVALID_OPERATION_TYPE,
    { operationType, validTypes }
  );
}

/**
 * Create an idempotency conflict error
 *
 * Raised when a caller reuses an idempotency key with a different immutable
 * payload (different amount or operation type). This is a caller bug, never a
 * retryable condition — the details carry both payloads so it can be diffed.
 */
export function createIdempotencyConflictError(
  idempotencyKey: string,
  details?: Record<string, unknown>
): CreditError {
  return new CreditError(
    `Idempotency key ${idempotencyKey} was reused with a different payload`,
    CreditErrorCode.IDEMPOTENCY_CONFLICT,
    { idempotencyKey, ...details }
  );
}

/**
 * Create a transient (retryable) error
 */
export function createTransientError(
  message: string,
  details?: Record<string, unknown>
): CreditError {
  return new CreditError(message, CreditErrorCode.TRANSIENT_ERROR, details);
}

/**
 * Create an error for a V2 method the configured adapter does not implement
 */
export function createUnsupportedOperationError(operation: string): CreditError {
  return new CreditError(
    `Repository does not support ${operation}`,
    CreditErrorCode.UNSUPPORTED_OPERATION,
    { operation }
  );
}

/**
 * Create an invalid amount error
 */
export function createInvalidAmountError(amount: unknown): CreditError {
  return new CreditError(
    `Credit amount must be a finite positive number (got ${String(amount)})`,
    CreditErrorCode.INVALID_AMOUNT,
    { amount }
  );
}

/**
 * Check if an error is an idempotency conflict
 */
export function isIdempotencyConflictError(error: unknown): boolean {
  return isCreditError(error) && error.code === CreditErrorCode.IDEMPOTENCY_CONFLICT;
}

/**
 * Check if an error is safe to retry
 *
 * Only `TRANSIENT_ERROR` qualifies. Use {@link classifyDatabaseError} first to
 * turn a raw driver error into a classified `CreditError`.
 */
export function isTransientError(error: unknown): boolean {
  return isCreditError(error) && error.code === CreditErrorCode.TRANSIENT_ERROR;
}
