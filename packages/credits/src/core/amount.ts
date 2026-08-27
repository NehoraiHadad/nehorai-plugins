/**
 * Validation and exact comparison for credit amounts.
 *
 * Every amount ends up in a `numeric(12, 2)` column, so the ledger can only
 * represent values on the cent grid, with at most ten integer digits. A value
 * outside that grid is not "close enough" — PostgreSQL silently rounds it on
 * write, and the row that comes back no longer equals what the caller asked
 * for. Rejecting it before any row is touched is the only way the ledger and
 * the caller can agree on what happened.
 *
 * These live in core rather than in an adapter so every repository — shipped
 * or third-party — validates identically.
 */

import { CreditError, CreditErrorCode } from "./errors.js";

/** `numeric(12, 2)`: 12 significant digits, 2 of them after the point. */
export const CREDIT_AMOUNT_SCALE = 2;
/** Largest representable amount: ten integer digits plus two decimals. */
export const CREDIT_AMOUNT_MAX = 9_999_999_999.99;
const MAX_CENTS = 999_999_999_999;

/**
 * Convert an amount to whole cents, or `null` if it is not exactly on the grid.
 *
 * `Math.round(value * 100) === value * 100` is the tempting check and it is
 * wrong: `1.005 * 100` is `100.49999999999999` in binary float, so a genuinely
 * invalid value can pass and a valid one can fail. Rounding first and then
 * confirming the value round-trips (`value === cents / 100`) is exact for
 * everything in range, because a cent count below 2^53 divided by 100 is the
 * nearest double to that decimal, which is what the literal parsed to.
 */
export function toCents(value: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents)) return null;
  return value === cents / 100 ? cents : null;
}

/** Amounts that may be *moved*: strictly positive and on the cent grid. */
export function isValidCreditAmount(value: unknown): value is number {
  if (typeof value !== "number") return false;
  const cents = toCents(value);
  return cents !== null && cents > 0 && cents <= MAX_CENTS;
}

/**
 * Reject an unusable amount before any row is written.
 *
 * @param context - merged into the error details, e.g. `{ userId }`.
 */
export function assertValidCreditAmount(
  value: unknown,
  context?: Record<string, unknown>
): asserts value is number {
  if (isValidCreditAmount(value)) return;
  throw new CreditError(
    creditAmountReason(value),
    CreditErrorCode.INVALID_AMOUNT,
    { amount: value, max: CREDIT_AMOUNT_MAX, scale: CREDIT_AMOUNT_SCALE, ...context }
  );
}

/** Say precisely which rule the value broke, so the caller can fix it. */
function creditAmountReason(value: unknown): string {
  if (typeof value !== "number") {
    return `Credit amount must be a number (got ${typeof value})`;
  }
  if (!Number.isFinite(value)) {
    return `Credit amount must be finite (got ${String(value)})`;
  }
  if (value <= 0) {
    return `Credit amount must be greater than zero (got ${value})`;
  }
  if (value > CREDIT_AMOUNT_MAX) {
    return `Credit amount ${value} exceeds the maximum of ${CREDIT_AMOUNT_MAX}`;
  }
  return `Credit amount ${value} is not exact to ${CREDIT_AMOUNT_SCALE} decimal places`;
}

/**
 * Parse a value read back from a `numeric` column into exact cents.
 *
 * Drivers return `numeric` as a string precisely so no precision is lost in
 * transit; comparing the parsed floats would throw that away again. Returns
 * `null` for anything unparseable so callers can treat it as "not equal"
 * rather than crashing on malformed ledger data.
 */
export function numericToCents(value: unknown): bigint | null {
  if (typeof value === "number") {
    const cents = toCents(value);
    return cents === null ? null : BigInt(cents);
  }
  if (typeof value !== "string") return null;

  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return null;

  const [, sign, whole, fraction = ""] = match;
  // More than two decimals is only acceptable when the extra digits are zeros;
  // anything else never came from a numeric(12,2) column.
  if (/[1-9]/.test(fraction.slice(CREDIT_AMOUNT_SCALE))) return null;

  const cents =
    BigInt(whole) * 100n + BigInt(fraction.slice(0, CREDIT_AMOUNT_SCALE).padEnd(CREDIT_AMOUNT_SCALE, "0"));
  return sign === "-" ? -cents : cents;
}

/**
 * Exact equality for two amounts that may be numbers or `numeric` strings.
 *
 * Unparseable input is *not* equal to anything, including itself — a
 * comparison against corrupt data must never come back "matches".
 */
export function sameAmount(a: unknown, b: unknown): boolean {
  const left = numericToCents(a);
  const right = numericToCents(b);
  return left !== null && right !== null && left === right;
}
