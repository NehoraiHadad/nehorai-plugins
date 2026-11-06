/**
 * Shared utilities for credit repository implementations
 *
 * These are pure functions with no server-only dependencies,
 * making them safe to use in any repository implementation.
 */

import { sumAmounts } from "../core/amount.js";
import type { PortableUserCredits } from "../core/types.js";
import type { CreditBalanceUpdate } from "./types.js";

/**
 * Generate a unique ID
 * Uses timestamp + random string for uniqueness
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Convert date-like value to Date object
 * Handles: Date, string, Firestore Timestamp
 */
export function toDate(value: Date | string | unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  // Handle Firestore Timestamp
  if (typeof value === "object" && value !== null && "toDate" in value) {
    return (value as { toDate: () => Date }).toDate();
  }
  return new Date();
}

/**
 * Get the first day of next month
 * Used for calculating monthly reset dates
 */
export function getNextMonthlyReset(from: Date = new Date()): Date {
  // From components: `setMonth` on the 31st overflows (31 Jan became 3 March, then
  // 1 March after `setDate(1)`), which skipped a whole month.
  return new Date(from.getFullYear(), from.getMonth() + 1, 1);
}

/** Result of validating a balance update. */
export interface BalanceValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Whether an update leaves a valid account: no negative field, and `reserved` covered
 * by `balance + bonusCredits`, which is the floor outstanding holds put under the
 * balance. An increment is applied on top of the absolute value when a call names both.
 *
 * An update is a delta the caller asked for, so one that cannot be honoured is refused,
 * as a deduct is. Only tier writes and resets stop at the floor: they state a target.
 *
 * A negative balance increment is a charge, so it draws only on the balance above
 * `expiredHoldBacking`: those credits are expired and leave when their hold closes, so
 * charging them would hand the charge back. An absolute balance replaces the field and
 * the marks with it, so only an increment on the stored balance meets this limit.
 */
export function validateBalanceUpdate(
  current: Pick<PortableUserCredits, "balance" | "bonusCredits" | "reserved" | "expiredHoldBacking">,
  updates: CreditBalanceUpdate
): BalanceValidationResult {
  const next = (base: number, absolute?: number, increment?: number) =>
    sumAmounts(absolute ?? base, increment ?? 0);
  const balance = next(current.balance, updates.balance, updates.balanceIncrement);
  const bonusCredits = next(
    current.bonusCredits ?? 0,
    updates.bonusCredits,
    updates.bonusCreditsIncrement
  );
  const reserved = next(current.reserved ?? 0, updates.reserved, updates.reservedIncrement);

  const errors: string[] = [];
  if (balance < 0) errors.push(`Balance cannot be negative: ${balance}`);
  const marked = updates.balance === undefined ? (current.expiredHoldBacking ?? 0) : 0;
  if ((updates.balanceIncrement ?? 0) < 0 && balance >= 0 && balance < marked) {
    errors.push(`Balance (${balance}) cannot go below expired hold backing (${marked})`);
  }
  if (bonusCredits < 0) errors.push(`BonusCredits cannot be negative: ${bonusCredits}`);
  if (reserved < 0) errors.push(`Reserved cannot be negative: ${reserved}`);

  const covering = sumAmounts(balance, bonusCredits);
  if (reserved > covering) {
    errors.push(`Reserved (${reserved}) exceeds balance + bonusCredits (${covering})`);
  }
  return { valid: errors.length === 0, errors };
}

/** Refuse an update {@link validateBalanceUpdate} finds invalid. */
export function assertValidBalanceUpdate(
  current: Pick<PortableUserCredits, "balance" | "bonusCredits" | "reserved" | "expiredHoldBacking">,
  updates: CreditBalanceUpdate
): void {
  const result = validateBalanceUpdate(current, updates);
  if (!result.valid) {
    throw new Error(`Invalid balance update: ${result.errors.join("; ")}`);
  }
}
