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
import type { ExpiredBackingFrontier, PortableReservation } from "./types.js";

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

/**
 * Multiply a price by a whole quantity, in cents.
 *
 * `1.1 * 3` is `3.3000000000000003`, which the amount validators refuse: the price
 * was legal, and the float product blames the caller for a rounding artefact. A
 * fractional quantity has no exact result on the grid and is refused rather than
 * rounded, so the rounding policy stays with whoever prices fractions.
 */
export function multiplyAmount(unit: number, quantity: number): number {
  const cents = toCents(unit);
  const product = cents === null ? Number.NaN : cents * quantity;
  if (
    cents === null ||
    cents < 0 ||
    !Number.isSafeInteger(quantity) ||
    quantity < 0 ||
    !Number.isSafeInteger(product) ||
    product > MAX_CENTS
  ) {
    throw new CreditError(
      `Cannot price ${quantity} units at ${unit}: the price must be a non-negative ` +
        `amount exact to ${CREDIT_AMOUNT_SCALE} decimals, the quantity a whole number, ` +
        `and the result at most ${CREDIT_AMOUNT_MAX}`,
      CreditErrorCode.INVALID_AMOUNT,
      { unit, quantity, max: CREDIT_AMOUNT_MAX, scale: CREDIT_AMOUNT_SCALE }
    );
  }
  return product / 100;
}

/** Far above what float addition leaves behind, far below a cent. */
const FLOAT_NOISE = 1e-6;

/**
 * The cent-grid value a float landed next to, or the value unchanged.
 *
 * Documents written by older versions can hold the result of IEEE 754 additions
 * (`FieldValue.increment` stored `0.30000000000000004`), and an application can pass
 * a raw float difference to a ledger record. That is noise, not an amount. A value
 * genuinely off the grid, such as `0.005`, is not noise and comes back as it went in.
 */
export function canonicalAmount(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents)) return value;
  const onGrid = cents / 100 + 0;
  return Math.abs(value - onGrid) < FLOAT_NOISE ? onGrid : value;
}

/**
 * Read a stored amount the account owns as a cent-grid value, rounding down.
 *
 * A stored `24.999` makes every later sum off-grid, the validators then refuse the
 * commit or release that needs it, and the holds on that account lock. Rounding down
 * unlocks them and cannot add a credit. A non-finite value is left for the validators
 * to refuse.
 */
export function storedAmountFloor(value: number): number {
  const canonical = canonicalAmount(value);
  if (!Number.isFinite(canonical) || toCents(canonical) !== null) return canonical;
  return Math.floor(canonical * 100) / 100;
}

/**
 * Read a stored amount the account owes as a cent-grid value, rounding up, so what
 * stands against the balance is never understated. See {@link storedAmountFloor}.
 */
export function storedAmountCeil(value: number): number {
  const canonical = canonicalAmount(value);
  if (!Number.isFinite(canonical) || toCents(canonical) !== null) return canonical;
  return Math.ceil(canonical * 100) / 100;
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
 * The balance left by a cap: lowered to `cap` at most, never raised, and never
 * cut through the credits backing outstanding holds (see
 * {@link backedBalanceFloor}). A balance already under `cap` is left alone,
 * which is the point of computing this from the stored row inside a transaction
 * rather than writing a value the caller read earlier.
 */
export function cappedBalance(
  balance: number,
  cap: number,
  reserved: number,
  bonusCredits: number
): number {
  return Math.min(balance, Math.max(cap, backedBalanceFloor(reserved, bonusCredits)));
}

/** A balance a lowering write lands on, and how much of it only backs holds. */
export interface PlannedBalance {
  balance: number;
  expiredHoldBacking: number;
}

/**
 * The expired credits actually held in a balance: `0 <= held <= balance`, whatever
 * is stored. Every read of `expiredHoldBacking` goes through this. Trusting the stored
 * value made a negative one mint credits: `balance - (-10)` read as spendable, and a
 * close that "used" -10 of backing added 10 to the balance.
 */
export function heldExpiredBacking(balance: number, stored?: number): number {
  if (!(stored !== undefined && stored > 0)) return 0;
  return Math.max(0, Math.min(stored, balance));
}

/** The part of a balance not kept only for holds. A missing field reads as 0. */
export function spendableBalance(balance: number, expiredHoldBacking?: number): number {
  return sumAmounts(balance, -heldExpiredBacking(balance, expiredHoldBacking));
}

/**
 * An absolute balance write: `target`, floored at what backs outstanding holds.
 * Whatever the floor kept above `target` is not the account's to spend.
 */
export function planBalanceTarget(
  target: number,
  reserved: number,
  bonusCredits: number
): PlannedBalance {
  // A negative target would be floored at 0 and leave `-target` marked on a balance
  // of 0, and the rest of the ledger cannot honour an unrepresentable one.
  assertValidBalanceTarget(target, "balance target", { reserved, bonusCredits });
  const balance = Math.max(target, backedBalanceFloor(reserved, bonusCredits));
  return { balance, expiredHoldBacking: sumAmounts(balance, -target) };
}

/**
 * A cap on the spendable part of a balance. Like {@link cappedBalance} it never
 * raises the balance and never cuts through what backs holds, and it records the
 * part kept above the cap so a later release cannot hand it back. Credits already
 * marked stay marked, so applying a cap twice changes nothing.
 */
export function planBalanceCap(
  balance: number,
  cap: number,
  reserved: number,
  bonusCredits: number,
  expiredHoldBacking?: number
): PlannedBalance {
  const spendable = spendableBalance(balance, expiredHoldBacking);
  const target = Math.min(spendable, cap);
  // Marked credits belong to the holds they back. A cap adds to them when the floor
  // needs it and never takes them away, even if later bonus credits lowered the floor.
  const kept = Math.max(
    sumAmounts(balance, -spendable),
    sumAmounts(backedBalanceFloor(reserved, bonusCredits), -target)
  );
  const next = Math.min(balance, sumAmounts(target, kept));
  return { balance: next, expiredHoldBacking: Math.max(0, sumAmounts(next, -target)) };
}

/**
 * What a closing hold takes out of the credits kept only for holds: its own share
 * and nothing of another hold's. `holdBacking` comes from {@link holdExpiredBacking}.
 */
export function settleExpiredHoldBacking(
  balance: number,
  expiredHoldBacking: number,
  holdBacking: number
): { used: number; remaining: number } {
  const held = heldExpiredBacking(balance, expiredHoldBacking);
  const used = Math.max(0, Math.min(held, holdBacking));
  return { used, remaining: sumAmounts(held, -used) };
}

/** The balances a commit lands on, and whether the account could pay it. */
export interface PlannedHoldCommit {
  covered: boolean;
  balance: number;
  bonusCredits: number;
  expiredHoldBacking: number;
}

/**
 * Pay a hold: first its own share of the marked credits, then spendable balance,
 * then bonus. Marked credits backing other holds are never touched, so what this
 * commit costs does not depend on which holds closed before it.
 */
export function planHoldCommit(
  balance: number,
  bonusCredits: number,
  expiredHoldBacking: number,
  holdBacking: number,
  amount: number
): PlannedHoldCommit {
  const backing = settleExpiredHoldBacking(balance, expiredHoldBacking, holdBacking);
  const rest = sumAmounts(amount, -backing.used);
  const fromSpendable = Math.min(spendableBalance(balance, expiredHoldBacking), rest);
  const fromBonus = sumAmounts(rest, -fromSpendable);
  return {
    covered: fromBonus <= bonusCredits,
    balance: sumAmounts(balance, -backing.used, -fromSpendable),
    bonusCredits: sumAmounts(bonusCredits, -fromBonus),
    expiredHoldBacking: backing.remaining,
  };
}

/** The fields of an open hold that decide its share of the marked credits. */
export type ExpiredBackingHold = Pick<PortableReservation, "id" | "amount" | "holdPlacedAt">;

/** The marked credits on an account and where they end among its open holds. */
export interface ExpiredBackingAllocation {
  total: number;
  frontier: ExpiredBackingFrontier | null;
}

function compareHolds(
  a: { holdPlacedAt: string; id: string },
  b: { holdPlacedAt: string; id: string }
): number {
  if (a.holdPlacedAt !== b.holdPlacedAt) return a.holdPlacedAt < b.holdPlacedAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Mark `total` credits across open holds, oldest first, each up to its amount.
 *
 * Oldest first makes the shares a prefix of the holds, so one {@link ExpiredBackingFrontier}
 * on the account describes them all and no hold document has to change when the total
 * does. Raising the total extends the prefix and lowering it trims the newest, so
 * credits never move between holds, and the split does not depend on the order holds
 * later close in.
 *
 * The returned total is what the holds could carry, and is what the account stores: the
 * rest is not marked. Such credits stay out of reach anyway, because the `reserved`
 * that kept them still counts against them. A row without `holdPlacedAt` is a record,
 * not a hold, and a row with an unusable amount cannot close, so neither takes a share.
 */
export function allocateExpiredBacking(
  holds: readonly ExpiredBackingHold[],
  total: number
): ExpiredBackingAllocation {
  const placed = holds
    .filter((hold) => hold.holdPlacedAt && isValidCreditAmount(hold.amount))
    .map((hold) => ({ ...hold, holdPlacedAt: hold.holdPlacedAt as string }))
    .sort(compareHolds);
  const wanted = Math.max(0, total);
  let left = wanted;
  let frontier: ExpiredBackingFrontier | null = null;
  for (const hold of placed) {
    if (left <= 0) break;
    const share = Math.min(hold.amount, left);
    frontier = { holdPlacedAt: hold.holdPlacedAt, id: hold.id, share };
    left = sumAmounts(left, -share);
  }
  return { total: sumAmounts(wanted, -left), frontier };
}

/** This hold's share of the marked credits, from the account's frontier alone. */
export function holdExpiredBacking(
  hold: ExpiredBackingHold,
  frontier?: ExpiredBackingFrontier | null
): number {
  if (!frontier || !hold.holdPlacedAt) return 0;
  const order = compareHolds({ holdPlacedAt: hold.holdPlacedAt, id: hold.id }, frontier);
  if (order > 0) return 0;
  return order < 0 ? hold.amount : Math.min(frontier.share, hold.amount);
}

/**
 * When a new hold counts as placed: `now`, or just after the frontier if this server's
 * clock is behind the server that placed it. A hold that sorted before the frontier
 * would read as fully marked, taking expired credits that belong to older holds.
 */
export function holdPlacedAtAfter(
  now: string,
  frontier?: ExpiredBackingFrontier | null
): string {
  if (!frontier) return now;
  const earliest = new Date(Date.parse(frontier.holdPlacedAt) + 1).toISOString();
  return now > earliest ? now : earliest;
}

/** The account fields that hold the marked credits. */
export interface ExpiredBackingFields {
  expiredHoldBacking?: number;
  expiredBackingFrontier?: ExpiredBackingFrontier | null;
}

/**
 * The fields to write for a new marked total: nothing when it was and stays 0, so an
 * account that never had any keeps a document without the fields. A stored value that
 * is not the new one is overwritten, which is what repairs a bad one. A `frontier` left
 * undefined keeps the stored one.
 */
export function expiredBackingPatch(
  next: { total: number; frontier?: ExpiredBackingFrontier | null },
  stored: ExpiredBackingFields
): ExpiredBackingFields {
  const total = Math.max(0, next.total);
  const patch: ExpiredBackingFields = {};
  const storedTotal = stored.expiredHoldBacking;
  if (total > 0 || (storedTotal !== undefined && storedTotal !== 0)) {
    patch.expiredHoldBacking = total;
  }
  if (total <= 0) {
    if (stored.expiredBackingFrontier) patch.expiredBackingFrontier = null;
  } else if (next.frontier) {
    patch.expiredBackingFrontier = next.frontier;
  }
  return patch;
}

/**
 * Validate a balance target supplied by the application: a cap or the result of
 * a monthly-reset decision. It must be storable and cannot be negative.
 */
export function assertValidBalanceTarget(
  value: unknown,
  field: string,
  context?: Record<string, unknown>
): asserts value is number {
  assertRepresentableAmount(value, field, context);
  if (value < 0) {
    throw new CreditError(
      `${field} cannot be negative (got ${value})`,
      CreditErrorCode.INVALID_AMOUNT,
      { field, value, ...context }
    );
  }
}

/**
 * Validate how a tier write changes the balance. `balance` sets a value the
 * caller computed and `balanceCap` lowers the stored value, so naming both has
 * no single meaning and is refused.
 */
export function assertValidTierBalanceInput(
  input: { balance?: number; balanceCap?: number },
  context?: Record<string, unknown>
): void {
  if (input.balanceCap === undefined) {
    if (input.balance !== undefined) assertValidBalanceTarget(input.balance, "balance", context);
    return;
  }
  if (input.balance !== undefined) {
    throw new CreditError(
      "A tier update cannot set both balance and balanceCap",
      CreditErrorCode.INVALID_AMOUNT,
      { balance: input.balance, balanceCap: input.balanceCap, ...context }
    );
  }
  assertValidBalanceTarget(input.balanceCap, "balanceCap", context);
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
