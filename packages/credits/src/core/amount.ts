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

/**
 * Add amounts on the cent grid, exactly.
 *
 * Deriving a total with `+` is not safe in a ledger that validates against the
 * grid: `0.10 + 0.20` is `0.30000000000000004` and `0.30 - 0.10` is
 * `0.19999999999999998`, neither of which is a value `numeric(12, 2)` can hold.
 * Two perfectly legal columns would therefore produce a total the validator
 * rejects with `INVALID_AMOUNT`, blaming the caller for a rounding artefact.
 * Summing whole cents is exact for every value in range, and `cents / 100` is
 * the nearest double to that decimal — the same one the literal would parse to.
 *
 * Subtract by negating: `sumAmounts(total, -amount)`. Negation is exact.
 *
 * This is arithmetic, not validation. If any input is itself off the grid the
 * float sum is returned unchanged — deliberately, so a corrupt value is never
 * rounded into legitimacy here — but that is not a guarantee the result will be
 * rejected downstream: two off-grid inputs can cancel, and `sumAmounts(0.005,
 * -0.005)` is a perfectly representable `0`. Inputs read from storage must be
 * validated as inputs, with `assertValidStoredAmount` or
 * `assertValidStoredAmountRaw`, before they are summed. Checking only the
 * derived result is not enough and never was.
 */
export function sumAmounts(...values: number[]): number {
  let cents = 0;
  for (const value of values) {
    const valueCents = toCents(value);
    if (valueCents === null) return floatSum(values);
    cents += valueCents;
  }
  return Number.isSafeInteger(cents) ? cents / 100 : floatSum(values);
}

function floatSum(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
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
 * Amounts the ledger can *record*: on the cent grid and in range, but free to
 * be zero or negative.
 *
 * Not every numeric column holds something spendable. A release journal entry
 * records `amount: 0` because no credits changed hands, and `balanceAfter` goes
 * negative for an account that was corrected or allowed to overdraw. Forcing
 * those through {@link isValidCreditAmount} would reject legitimate ledger
 * rows; skipping validation entirely would let `Infinity` or a third decimal
 * reach the column and be silently rounded or rejected by the driver.
 */
export function isRepresentableAmount(value: unknown): value is number {
  if (typeof value !== "number") return false;
  const cents = toCents(value);
  return cents !== null && Math.abs(cents) <= MAX_CENTS;
}

/**
 * Reject a ledger value the `numeric(12, 2)` column cannot hold exactly.
 *
 * @param field - the column being written, so the error names the culprit.
 */
export function assertRepresentableAmount(
  value: unknown,
  field: string,
  context?: Record<string, unknown>
): asserts value is number {
  if (isRepresentableAmount(value)) return;
  throw new CreditError(
    `${field} must be a finite number exact to ${CREDIT_AMOUNT_SCALE} decimal places ` +
      `within ±${CREDIT_AMOUNT_MAX} (got ${String(value)})`,
    CreditErrorCode.INVALID_AMOUNT,
    { field, value, max: CREDIT_AMOUNT_MAX, scale: CREDIT_AMOUNT_SCALE, ...context }
  );
}

/**
 * Check a whole set of optional ledger fields at once.
 *
 * The balance writers each take a handful of independently optional numbers,
 * and validating them one `if` at a time is where one quietly gets missed.
 * Undefined entries are skipped — they mean "leave this column alone".
 */
export function assertRepresentableFields(
  fields: Record<string, unknown>,
  context?: Record<string, unknown>
): void {
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    assertRepresentableAmount(value, field, context);
  }
}

/**
 * The lowest `balance` that keeps every outstanding hold committable.
 *
 * Commit's funding guard is `balance + bonusCredits >= amount`, and every live
 * hold is counted in `reserved`, so any write that lowers `balance` must keep
 * `balance + bonusCredits >= reserved` — otherwise a hold that was fully backed
 * when it was placed throws `INSUFFICIENT_CREDITS` at commit time and is
 * stranded. Monthly resets, tier downgrades and explicit tier writes all lower
 * `balance` to a configured target; this is the floor they may not cut through.
 *
 * The floor is `reserved - bonusCredits`, never below zero: bonus credits also
 * fund commits, so they count toward the backing.
 */
export function backedBalanceFloor(reserved: number, bonusCredits: number): number {
  const floor = Math.max(0, sumAmounts(reserved, -bonusCredits));
  // A floor beyond the representable range means the row itself is corrupt —
  // e.g. a large negative `bonusCredits` pushing `reserved - bonusCredits`
  // past the `numeric(12,2)` cap. Refuse loudly: writing it would succeed in
  // memory and be rejected by the SQL column, splitting the adapters.
  assertRepresentableAmount(floor, "backedBalanceFloor", { reserved, bonusCredits });
  return floor;
}

/**
 * Validate a limit derived from tier configuration.
 *
 * `Infinity` is this codebase's sentinel for an unlimited tier, so it is
 * accepted here; {@link storedMonthlyLimit} decides what actually reaches the
 * column. Every other value ends up in `numeric(12, 2)` and has to fit, so a
 * tier configured with `monthlyCredits: 1.005` is caught here rather than
 * silently rounded to `1.01` by PostgreSQL.
 */
export function assertRepresentableTierAmount(
  value: unknown,
  field: string,
  context?: Record<string, unknown>
): void {
  if (value === Number.POSITIVE_INFINITY) return;
  assertRepresentableAmount(value, field, context);
}

/**
 * Validate a stored amount in the representation storage actually returned.
 *
 * Checking the mapped float is not enough, because the mapping is lossy in both
 * directions. A `numeric` column with no scale constraint can hold
 * `9999999999.9900001`; `Number()` rounds that to `9999999999.99`, which is a
 * perfectly valid amount, so a validator looking at the mapped value sees
 * nothing wrong and the transition proceeds — while PostgreSQL goes on doing
 * exact arithmetic with the digits JavaScript threw away. `NaN` and values past
 * double range are worse: the mapper turns them into `0`, which misreports what
 * the row holds.
 *
 * So this runs on the driver's own output — a string, for `numeric` — and uses
 * exact integer arithmetic. It returns the amount as a float only after
 * establishing that the float is a faithful representation of it.
 *
 * @returns the stored amount, exactly representable as a JS number.
 */
/**
 * How an unlimited tier's monthly limit is stored.
 *
 * `getConfigMonthlyLimit` returns `Infinity` for an unlimited tier, and no
 * numeric column can hold that. Both adapters therefore store the ceiling of
 * the representable range instead: any real usage compares below it, so
 * "unlimited" keeps behaving like unlimited, and a reader that knows nothing
 * about the sentinel sees a very large allowance rather than a wrong one.
 *
 * This exists so the two adapters cannot drift. The SQL adapter previously
 * stored `0` here, which reads as *no* allowance — the exact opposite — while
 * the in-memory adapter kept `Infinity`.
 */
export function storedMonthlyLimit(limit: number): number {
  return Number.isFinite(limit) ? limit : CREDIT_AMOUNT_MAX;
}

export function assertValidStoredAmountRaw(
  raw: unknown,
  context: Record<string, unknown>
): number {
  const cents = numericToCents(raw);
  if (cents !== null && cents > 0n && cents <= BigInt(MAX_CENTS)) {
    return Number(cents) / 100;
  }
  throw new CreditError(
    `Stored credit amount ${String(raw)} is not a valid amount, so this ` +
      "transition was refused before any state changed. The row must be " +
      "repaired before it can be committed, released or expired.",
    CreditErrorCode.INVALID_AMOUNT,
    {
      amount: typeof raw === "string" ? raw : String(raw),
      reason: "corrupt_stored_amount",
      max: CREDIT_AMOUNT_MAX,
      scale: CREDIT_AMOUNT_SCALE,
      ...context,
    }
  );
}

/**
 * Reject a *persisted* amount that the ledger cannot honour.
 *
 * A reservation row is written once and read back on every transition, and
 * nothing stops a direct SQL write, a botched migration, or an older version of
 * this library from leaving an amount the invariants cannot reason about. A
 * negative one is the dangerous case: `reserved >= amount` is trivially true
 * for it, and `balance - (-10)` *adds* credits, so a transition that trusts the
 * stored value mints money. Every transition therefore re-validates what it
 * locked before it changes anything.
 *
 * Deliberately fails release and expire as well as commit. Returning a hold of
 * an unknown size is not obviously safer than spending one — it hands back
 * coverage that may never have been taken — so a corrupt row stops moving
 * entirely and waits for an operator, rather than being partially honoured.
 *
 * This is the float-typed form, used by the in-memory adapter where the stored
 * value *is* a JS number and no conversion has happened. A repository whose
 * storage returns some other representation must use
 * {@link assertValidStoredAmountRaw} instead, or the conversion will hide the
 * corruption from the check.
 */
export function assertValidStoredAmount(
  value: unknown,
  context: Record<string, unknown>
): asserts value is number {
  if (isValidCreditAmount(value)) return;
  throw new CreditError(
    `Stored credit amount ${String(value)} is not a valid amount, so this ` +
      "transition was refused before any state changed. The row must be " +
      "repaired before it can be committed, released or expired.",
    CreditErrorCode.INVALID_AMOUNT,
    { amount: value, reason: "corrupt_stored_amount", max: CREDIT_AMOUNT_MAX, ...context }
  );
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
