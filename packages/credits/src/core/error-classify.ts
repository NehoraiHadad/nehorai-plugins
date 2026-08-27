/**
 * Driver-error classification.
 *
 * Consuming apps need to react differently to "the user is out of credits"
 * (show a paywall), "the database blinked" (retry), and "our SQL is wrong"
 * (page someone). Drivers signal that distinction through a SQLSTATE on the
 * thrown object, so this maps SQLSTATE classes onto {@link CreditErrorCode}
 * without taking a dependency on any particular driver.
 */

import {
  CreditError,
  CreditErrorCode,
  isCreditError,
} from "./errors.js";

/**
 * PostgreSQL SQLSTATEs whose failure is a property of the moment, not of the
 * statement — the identical call may well succeed on retry.
 *
 * - `40001` serialization_failure, `40P01` deadlock_detected, `40000` transaction_rollback
 * - `55P03` lock_not_available, `57014` query_canceled (statement timeout)
 * - `53300` too_many_connections, `53200` out_of_memory, `53400` configuration_limit_exceeded
 * - `08xxx` connection exception class
 */
const TRANSIENT_SQLSTATES = new Set([
  "40000",
  "40001",
  "40P01",
  "55P03",
  "57014",
  "57P01",
  "57P02",
  "57P03",
  "53200",
  "53300",
  "53400",
]);

/** Node driver-level codes that mean "the socket/pool failed", not "the query is wrong". */
const TRANSIENT_DRIVER_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
]);

/** Read a SQLSTATE-ish `code` off an unknown thrown value. */
export function getSqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * True when the SQLSTATE is a unique-violation (`23505`).
 *
 * Callers that race on a partial unique index use this to tell "someone else
 * inserted the same idempotency key" from a genuine schema error.
 */
export function isUniqueViolation(error: unknown): boolean {
  return getSqlState(error) === "23505";
}

/** True when the error is worth retrying. */
export function isTransientDatabaseError(error: unknown): boolean {
  const code = getSqlState(error);
  if (!code) return false;
  if (TRANSIENT_SQLSTATES.has(code)) return true;
  if (TRANSIENT_DRIVER_CODES.has(code)) return true;
  // Whole connection-exception class (08000, 08003, 08006, 08001, 08004, 08007, 08P01).
  return code.startsWith("08");
}

/**
 * Wrap an unknown thrown value in a classified {@link CreditError}.
 *
 * Already-classified `CreditError`s pass through untouched so a domain outcome
 * (insufficient credits, idempotency conflict) is never downgraded to
 * `DATABASE_ERROR` by a generic catch further up the stack.
 */
export function classifyDatabaseError(
  error: unknown,
  context?: Record<string, unknown>
): CreditError {
  if (isCreditError(error)) return error;

  const sqlState = getSqlState(error);
  const message = error instanceof Error ? error.message : String(error);
  const details = { ...context, ...(sqlState ? { sqlState } : {}) };

  if (isTransientDatabaseError(error)) {
    return new CreditError(message, CreditErrorCode.TRANSIENT_ERROR, details);
  }

  return new CreditError(message, CreditErrorCode.DATABASE_ERROR, details);
}
