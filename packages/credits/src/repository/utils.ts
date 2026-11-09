/**
 * Shared utilities for credit repository implementations
 *
 * These are pure functions with no server-only dependencies,
 * making them safe to use in any repository implementation.
 */

import {
  assertRepresentableFields,
  assertValidBalanceTarget,
  heldExpiredBacking,
  sumAmounts,
} from "../core/amount.js";
import type { PortableUserCredits, SubscriptionTier } from "../core/types.js";
import type { CreateJournalEntryInput, CreditBalanceUpdate } from "./types.js";

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
  const marked =
    updates.balance === undefined
      ? heldExpiredBacking(current.balance, current.expiredHoldBacking)
      : 0;
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

/**
 * The journal line of a new account's starting balance, or null when it starts at 0.
 * Write it in the step that creates the account: that step creates it once, so the
 * line needs no guard of its own.
 *
 * This is the line of the legacy call, where `initializeUserCredits` gets no
 * `signupBonus`. A repository writing account creation should use
 * {@link signupJournalInput}, which covers both calls.
 */
export function signupGrantJournalInput(
  userId: string,
  tier: SubscriptionTier,
  grant: number
): CreateJournalEntryInput | null {
  if (grant <= 0) return null;
  return {
    userId,
    entryType: "credit",
    amount: grant,
    balanceBefore: 0,
    balanceAfter: grant,
    source: "bonus",
    referenceId: `signup-${userId}`,
    referenceType: "adjustment",
    description: `Signup grant for ${tier} tier.`,
    metadata: { tier },
  };
}

/**
 * The one journal line of a new account, or null when it starts with nothing. Write it
 * in the step that creates the account, like {@link signupGrantJournalInput}.
 *
 * Without `signupBonus` (the legacy call) this is `signupGrantJournalInput`, unchanged.
 * With it, the one line covers both buckets: `amount` and `balanceAfter` are
 * `balance + signupBonus`, `balanceBefore` 0, and `metadata.buckets` splits it as
 * `{ balance, bonus }`. One line, not one per bucket: lines written in one step share a
 * timestamp, so the order of two of them on read is arbitrary and the "latest" could
 * show a partial total.
 *
 * `credit`, `source: "bonus"`, `referenceType: "adjustment"`, `referenceId`
 * `signup-<userId>`. Refuses an off-grid or negative bonus, and a total the journal
 * cannot record, so call it before writing anything.
 */
export function signupJournalInput(
  userId: string,
  tier: SubscriptionTier,
  balance: number,
  signupBonus?: number
): CreateJournalEntryInput | null {
  if (signupBonus === undefined) return signupGrantJournalInput(userId, tier, balance);
  assertValidBalanceTarget(signupBonus, "signupBonus", { userId });
  const total = sumAmounts(balance, signupBonus);
  assertRepresentableFields({ balanceAfter: total }, { userId, tier });
  if (total <= 0) return null;
  return {
    userId,
    entryType: "credit",
    amount: total,
    balanceBefore: 0,
    balanceAfter: total,
    source: "bonus",
    referenceId: `signup-${userId}`,
    referenceType: "adjustment",
    description: `Signup grant for ${tier} tier.`,
    metadata: { tier, buckets: { balance, bonus: signupBonus } },
  };
}

/**
 * The journal line of a tier write that moved the balance, or null when it did not.
 * Call it before writing anything: it refuses a total the ledger cannot record.
 *
 * `amount` follows the lines this one sits beside, not the difference between the
 * totals: a raise records the balance it set, like `subscription_grant`, and a cut
 * records 0, like the expiry `subscription_downgrade`. `balanceBefore` and
 * `balanceAfter` say how far the balance moved.
 */
export function tierChangeJournalInput(input: {
  userId: string;
  previousTier: SubscriptionTier;
  newTier: SubscriptionTier;
  previousBalance: number;
  newBalance: number;
  bonusCredits: number;
}): CreateJournalEntryInput | null {
  const { userId, previousTier, newTier, previousBalance, newBalance, bonusCredits } = input;
  const change = sumAmounts(newBalance, -previousBalance);
  if (change === 0) return null;

  const raised = change > 0;
  const amount = raised ? newBalance : 0;
  const balanceBefore = sumAmounts(previousBalance, bonusCredits);
  const balanceAfter = sumAmounts(newBalance, bonusCredits);
  assertRepresentableFields(
    {
      "journal amount": amount,
      "journal balanceBefore": balanceBefore,
      "journal balanceAfter": balanceAfter,
    },
    { userId, operation: "updateUserTier" }
  );
  return {
    userId,
    entryType: raised ? "credit" : "debit",
    amount,
    balanceBefore,
    balanceAfter,
    source: raised ? "subscription_upgrade" : "subscription_downgrade",
    referenceId: `tier-${Date.now()}`,
    referenceType: "subscription",
    description: `Tier changed from ${previousTier} to ${newTier}.`,
    metadata: { previousTier, newTier, previousBalance, newBalance },
  };
}
