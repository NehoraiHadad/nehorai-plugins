import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type {
  PortableUserCredits,
  SubscriptionTier,
  MonthlyResetResult,
  SubscriptionExpiryResult,
  CreditPolicyOptions,
  LotLedgerOptions,
  LotSpec,
} from "@nehorai/credits";
import {
  assertRepresentableFields,
  assertValidBalanceTarget,
  assertValidIdempotencyKey,
  assertValidLotSpec,
  CreditError,
  CreditErrorCode,
  getDefaultTier,
  isFreeTier,
  planBalanceCap,
  planBalanceTarget,
  planLotCap,
  planLotReplace,
  sameAmount,
  spendableBalance,
  sumAmounts,
} from "@nehorai/credits";
import {
  getUserCreditsCollection,
  BALANCE_DOC_ID,
  getNextMonthStart,
  DEFAULT_FREE_CREDITS,
  toDate,
} from "./shared.js";
import {
  applyCallerDocUpdate,
  deterministicDocId,
  readStoredCredits,
  toPortableCredits,
  type CallerDocUpdate,
  type FirestoreUserCredits,
} from "./credits-doc.js";
import { planHoldBacking } from "./hold-backing.js";
import { createJournalEntryInTransaction, getUserJournalCollection } from "./journal.js";
import {
  LotDriftReporter,
  lotBucketsAfter,
  planFirestoreLots,
  writeLotPlan,
} from "./lots.js";

/**
 * Options for monthly reset
 */
export interface MonthlyResetOptions
  extends Pick<CreditPolicyOptions, "resolveMonthlyReset">,
    LotLedgerOptions {
  /**
   * Function to get monthly limit for a tier
   * If not provided, defaults to current monthlyLimit value
   */
  getMonthlyLimit?: (tier: SubscriptionTier) => number;
}

/**
 * Options for the subscription-expiry downgrade
 */
export type SubscriptionExpiryOptions = Pick<CreditPolicyOptions, "getDowngradeBalanceCap"> &
  LotLedgerOptions;

/**
 * What a due reset writes, decided from the account read inside the transaction.
 * null means no reset.
 */
function planMonthlyReset(
  userId: string,
  current: FirestoreUserCredits,
  options?: MonthlyResetOptions
): { balance: number; expiredHoldBacking: number; monthlyLimit?: number } | null {
  const { tier, balance } = current;
  const reserved = current.reserved ?? 0;
  const bonusCredits = current.bonusCredits ?? 0;

  if (options?.resolveMonthlyReset) {
    // The resolver decides on credits the account may spend, not on those kept only
    // for holds; otherwise "keep the balance" would unmark them.
    const decision = options.resolveMonthlyReset({
      tier,
      balance: spendableBalance(balance, current.expiredHoldBacking),
    });
    if (decision === null) return null;

    assertValidBalanceTarget(decision.balance, "resolveMonthlyReset balance", { userId, tier });
    if (decision.monthlyLimit !== undefined) {
      assertValidBalanceTarget(decision.monthlyLimit, "resolveMonthlyReset monthlyLimit", {
        userId,
        tier,
      });
    }
    return {
      // Commit requires balance + bonusCredits to cover the hold, so a reset may
      // not cut through what backs outstanding holds.
      ...planBalanceTarget(decision.balance, reserved, bonusCredits),
      monthlyLimit: decision.monthlyLimit,
    };
  }

  const monthlyLimit = options?.getMonthlyLimit?.(tier) ?? current.monthlyLimit;
  // For unlimited tier (Infinity), preserve balance; for others, reset to monthly limit
  return monthlyLimit === Infinity
    ? { balance, expiredHoldBacking: current.expiredHoldBacking ?? 0 }
    : planBalanceTarget(monthlyLimit, reserved, bonusCredits);
}

/**
 * Atomically perform monthly reset if needed
 * Uses optimistic locking to prevent race conditions from concurrent requests
 *
 * The transaction will only update if:
 * 1. The monthlyResetAt is in the past (reset is needed)
 * 2. The monthlyResetAt matches expectedResetAt (no other request has reset)
 *
 * @param db - Firestore instance
 * @param userId - User ID
 * @param _tier - Not trusted. The caller read it before this transaction and the
 *   account may have changed tier since, so the reset uses the tier read inside the
 *   transaction. Kept so the signature matches `ICreditRepository`.
 * @param expectedResetAt - Expected monthlyResetAt value for optimistic locking
 * @param options - Optional configuration
 * @returns Result with wasReset flag and updated credits. The journal line of a reset
 *   that moved the balance is written in the same transaction (`journaled: true`).
 */
export async function atomicMonthlyReset(
  db: Firestore,
  userId: string,
  _tier: SubscriptionTier,
  expectedResetAt: Date | string,
  options?: MonthlyResetOptions
): Promise<MonthlyResetResult> {
  const creditsCol = getUserCreditsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);

  const expectedResetDate = toDate(expectedResetAt);
  const now = new Date();

  const report = new LotDriftReporter(options, userId, "atomicMonthlyReset");
  const result = await db.runTransaction(async (transaction): Promise<MonthlyResetResult> => {
    report.begin();
    const balanceDoc = await transaction.get(balanceRef);

    if (!balanceDoc.exists) {
      throw new Error(`User credits not found for userId: ${userId}`);
    }

    const raw = balanceDoc.data() as FirestoreUserCredits;
    const currentData = readStoredCredits(raw);
    const currentCredits = toPortableCredits(raw);
    const currentResetAt = toDate(currentData.monthlyResetAt);

    // Check if reset is still needed (another request may have done it)
    if (now < currentResetAt) {
      // No reset needed - already up to date
      return {
        wasReset: false,
        credits: currentCredits,
      };
    }

    // Check optimistic lock - if monthlyResetAt changed, another request handled it
    // Use time comparison with small tolerance (1 second) for timestamp precision issues
    const timeDiff = Math.abs(currentResetAt.getTime() - expectedResetDate.getTime());
    if (timeDiff > 1000) {
      // Another request already performed the reset
      return {
        wasReset: false,
        credits: currentCredits,
      };
    }

    const plan = planMonthlyReset(userId, currentData, options);
    if (plan === null) {
      return {
        wasReset: false,
        credits: currentCredits,
      };
    }

    // Perform the reset
    const newResetAt = getNextMonthStart(now);
    const newBalance = plan.balance;
    const limitUpdate = plan.monthlyLimit !== undefined ? { monthlyLimit: plan.monthlyLimit } : {};
    const bonusCredits = currentData.bonusCredits ?? 0;
    const balanceChange = sumAmounts(newBalance, -currentData.balance);
    // The reset keeps the balance lots up to the new total (an excess expires as
    // breakage) and tops a shortfall up with a free lot. On a paid tier the free top-up
    // is flagged: a paid allotment belongs to a subscription cycle grant.
    const referenceId = `reset-${now.getTime()}`;
    const after = lotBucketsAfter(newBalance, plan.expiredHoldBacking, bonusCredits);
    const lots = planFirestoreLots(options, {
      raw,
      after,
      opRef: `reset:${referenceId}`,
      apply: (lotPlan) =>
        planLotCap(lotPlan, {
          spendable: after.spendable,
          backing: after.backing,
          reason: "monthly_reset",
          ref: referenceId,
          topUp: {
            spec: { funding: "free" },
            sourceType: "monthly_reset",
            ...(isFreeTier(currentData.tier) ? {} : { anomaly: "paid_tier_reset" }),
          },
        }),
    });
    report.track(lots);
    const backingUpdate = await planHoldBacking(
      transaction,
      db,
      userId,
      plan.expiredHoldBacking,
      raw
    );

    // IMPORTANT: bonusCredits is NOT included in updateData - it is preserved
    const updateData = {
      monthlyUsed: 0,
      balance: newBalance,
      ...backingUpdate,
      ...writeLotPlan(transaction, db, userId, lots),
      ...limitUpdate,
      monthlyResetAt: newResetAt.toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
      // Note: bonusCredits is intentionally NOT reset - it persists across months
    };

    transaction.update(balanceRef, updateData);
    if (balanceChange !== 0) {
      createJournalEntryInTransaction(transaction, db, {
        userId,
        entryType: balanceChange > 0 ? "credit" : "debit",
        amount: Math.abs(balanceChange),
        balanceBefore: sumAmounts(currentData.balance, bonusCredits),
        balanceAfter: sumAmounts(newBalance, bonusCredits),
        source: "monthly_reset",
        referenceId,
        referenceType: "reset",
        description: `Monthly credit reset for ${currentData.tier} tier.`,
        metadata: {
          tier: currentData.tier,
          previousBalance: currentData.balance,
          newBalance,
        },
      });
    }

    // Return the updated credits (simulate what they will be after commit)
    const updatedCredits: PortableUserCredits = {
      ...currentCredits,
      monthlyUsed: 0,
      balance: newBalance,
      ...backingUpdate,
      ...limitUpdate,
      monthlyResetAt: newResetAt.toISOString(),
      updatedAt: now.toISOString(),
    };

    return {
      wasReset: true,
      credits: updatedCredits,
      journaled: true,
    };
  });
  report.flush();
  return result;
}

/**
 * Check and handle subscription expiry with grace period
 *
 * Grace period logic:
 * - If subscription expired < gracePeriodDays ago: return warning, no action
 * - If subscription expired >= gracePeriodDays ago: downgrade to free tier
 *
 * @param db - Firestore instance
 * @param userId - User ID
 * @param gracePeriodDays - Days after expiry before downgrade (default: 3)
 * @param options - Optional configuration
 * @returns Result indicating whether downgrade occurred. The downgrade's journal line
 *   is written in the same transaction (`journaled: true`).
 */
export async function checkAndHandleSubscriptionExpiry(
  db: Firestore,
  userId: string,
  gracePeriodDays = 3,
  options?: SubscriptionExpiryOptions
): Promise<SubscriptionExpiryResult> {
  const creditsCol = getUserCreditsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);

  const report = new LotDriftReporter(options, userId, "checkAndHandleSubscriptionExpiry");
  const result = await db.runTransaction(async (transaction): Promise<SubscriptionExpiryResult> => {
    report.begin();
    const balanceDoc = await transaction.get(balanceRef);

    if (!balanceDoc.exists) {
      throw new Error(`User credits not found for userId: ${userId}`);
    }

    const raw = balanceDoc.data() as FirestoreUserCredits;
    const currentData = readStoredCredits(raw);
    const currentCredits = toPortableCredits(raw);

    // Free/default tier users don't have subscription expiry
    if (isFreeTier(currentData.tier)) {
      return {
        wasDowngraded: false,
        inGracePeriod: false,
        graceDaysRemaining: 0,
        credits: currentCredits,
      };
    }

    // No expiry date set means subscription is valid indefinitely (shouldn't happen normally)
    if (!currentData.subscriptionExpiresAt) {
      return {
        wasDowngraded: false,
        inGracePeriod: false,
        graceDaysRemaining: 0,
        credits: currentCredits,
      };
    }

    const expiresAt = toDate(currentData.subscriptionExpiresAt);
    const now = new Date();

    // Subscription hasn't expired yet
    if (now < expiresAt) {
      return {
        wasDowngraded: false,
        inGracePeriod: false,
        graceDaysRemaining: 0,
        credits: currentCredits,
      };
    }

    // Calculate days since expiry
    const daysSinceExpiry = Math.floor(
      (now.getTime() - expiresAt.getTime()) / (1000 * 60 * 60 * 24)
    );

    // Check if still in grace period
    if (daysSinceExpiry < gracePeriodDays) {
      const graceDaysRemaining = gracePeriodDays - daysSinceExpiry;
      return {
        wasDowngraded: false,
        inGracePeriod: true,
        graceDaysRemaining,
        credits: currentCredits,
      };
    }

    // Grace period exceeded - downgrade to the default (free) tier
    const downgradeTier = getDefaultTier();
    const freeMonthlyLimit = options?.getDowngradeBalanceCap?.() ?? DEFAULT_FREE_CREDITS;
    assertValidBalanceTarget(freeMonthlyLimit, "getDowngradeBalanceCap", { userId });
    // The downgrade may cut the balance to the new limit, but not through what backs
    // outstanding holds. The part kept for them is marked, so a release cannot hand
    // expired credits back.
    const planned = planBalanceCap(
      currentData.balance,
      freeMonthlyLimit,
      currentData.reserved ?? 0,
      currentData.bonusCredits ?? 0,
      currentData.expiredHoldBacking
    );
    const newBalance = planned.balance;
    const bonusCredits = currentData.bonusCredits ?? 0;
    const referenceId = `downgrade-${now.getTime()}`;
    const after = lotBucketsAfter(newBalance, planned.expiredHoldBacking, bonusCredits);
    const lots = planFirestoreLots(options, {
      raw,
      after,
      opRef: `downgrade:${referenceId}`,
      apply: (lotPlan) =>
        planLotCap(lotPlan, {
          spendable: after.spendable,
          backing: after.backing,
          reason: "subscription_downgrade",
          ref: referenceId,
        }),
    });
    report.track(lots);
    const backingUpdate = await planHoldBacking(
      transaction,
      db,
      userId,
      planned.expiredHoldBacking,
      raw
    );

    // Note: bonusCredits is intentionally NOT modified during downgrade - it persists
    const updateData = {
      tier: downgradeTier,
      monthlyLimit: freeMonthlyLimit,
      balance: newBalance,
      ...backingUpdate,
      ...writeLotPlan(transaction, db, userId, lots),
      subscriptionExpiresAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    };

    transaction.update(balanceRef, updateData);
    createJournalEntryInTransaction(transaction, db, {
      userId,
      entryType: "debit",
      amount: 0, // 0, however far the cap lowered the balance: the totals record the move
      balanceBefore: sumAmounts(currentData.balance, bonusCredits),
      balanceAfter: sumAmounts(newBalance, bonusCredits),
      source: "subscription_downgrade",
      referenceId,
      referenceType: "subscription",
      description: `Subscription expired. Downgraded from ${currentData.tier} to ${downgradeTier} tier.`,
      metadata: {
        previousTier: currentData.tier,
        newTier: downgradeTier,
        previousBalance: currentData.balance,
        newBalance,
        gracePeriodDays,
      },
    });

    const updatedCredits: PortableUserCredits = {
      ...currentCredits,
      tier: downgradeTier,
      monthlyLimit: freeMonthlyLimit,
      balance: newBalance,
      ...backingUpdate,
      subscriptionExpiresAt: null,
      updatedAt: now.toISOString(),
    };

    return {
      wasDowngraded: true,
      inGracePeriod: false,
      graceDaysRemaining: 0,
      credits: updatedCredits,
      journaled: true,
    };
  });
  report.flush();
  return result;
}

/**
 * One paid subscription allotment: a renewal or an upgrade.
 */
export interface SubscriptionCycleGrantInput {
  userId: string;
  /** The cycle or upgrade id. A repeat of this key changes nothing. */
  grantKey: string;
  tier: SubscriptionTier;
  /** The balance this grant sets. */
  credits: number;
  /** Defaults to `credits`. */
  monthlyLimit?: number;
  subscriptionExpiresAt: Date | string;
  monthlyResetAt: Date | string;
  description: string;
  metadata?: Record<string, unknown>;
  /** Written only when the grant applies, for example a `creditsGranted` flag. */
  alsoUpdate?: CallerDocUpdate;
  /**
   * What the allotment was paid, for a repository that records lots. Default `unknown`.
   * `sourceType` defaults to `subscription_cycle` (pass `subscription_upgrade` for an
   * upgrade) and `sourceRef` to `grantKey`. Validated even when lots are off.
   */
  lot?: LotSpec;
}

export type SubscriptionCycleGrantOutcome =
  | { outcome: "granted"; credits: PortableUserCredits; journalEntryId: string }
  | { outcome: "replayed"; journalEntryId: string }
  /** The key was already used for another amount or tier. Nothing was written. */
  | { outcome: "conflict"; journalEntryId: string; mismatch: string };

const isoOf = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);

/**
 * Atomically apply a subscription allotment and journal it from the snapshot read.
 *
 * The journal document, at an id derived from `grantKey`, is the guard: it is written
 * with the balance, so a retry cannot restore credits already spent. `bonusCredits`
 * and `reserved` are untouched.
 *
 * The grant replaces the balance, so earlier marked credits are gone with it. The
 * balance is still floored at what backs outstanding holds, and only a floor above
 * `credits` stays marked: otherwise a grant smaller than the holds would turn expired
 * credits spendable on release.
 */
export async function grantSubscriptionCycle(
  db: Firestore,
  input: SubscriptionCycleGrantInput,
  lotOptions?: LotLedgerOptions
): Promise<SubscriptionCycleGrantOutcome> {
  const { userId, grantKey, tier, credits, description, metadata, alsoUpdate } = input;
  const context = { userId, grantKey, operation: "grantSubscriptionCycle" };
  assertValidIdempotencyKey(grantKey, context);
  if (input.lot !== undefined) assertValidLotSpec(input.lot);
  assertValidBalanceTarget(credits, "credits", context);
  const monthlyLimit = input.monthlyLimit ?? credits;
  assertValidBalanceTarget(monthlyLimit, "monthlyLimit", context);

  const balanceRef = getUserCreditsCollection(db, userId).doc(BALANCE_DOC_ID);
  const entryRef = getUserJournalCollection(db, userId).doc(
    deterministicDocId("subscription-grant", grantKey)
  );

  const report = new LotDriftReporter(lotOptions, userId, "grantSubscriptionCycle");
  const outcome = await db.runTransaction(async (transaction): Promise<SubscriptionCycleGrantOutcome> => {
    report.begin();
    const [entryDoc, balanceDoc] = await transaction.getAll(entryRef, balanceRef);

    if (entryDoc.exists) {
      const entry = entryDoc.data() ?? {};
      const mismatch = !sameAmount(entry.amount, credits)
        ? "amount"
        : entry.metadata?.tier !== tier
          ? "tier"
          : null;
      return mismatch
        ? { outcome: "conflict", journalEntryId: entryRef.id, mismatch }
        : { outcome: "replayed", journalEntryId: entryRef.id };
    }

    if (!balanceDoc.exists) {
      throw new CreditError(
        `User credits not found for user ${userId}`,
        CreditErrorCode.USER_NOT_FOUND,
        context
      );
    }
    const raw = balanceDoc.data() as FirestoreUserCredits;
    const current = readStoredCredits(raw);
    const bonusCredits = current.bonusCredits ?? 0;
    const planned = planBalanceTarget(credits, current.reserved ?? 0, bonusCredits);
    const balanceAfter = sumAmounts(planned.balance, bonusCredits);
    assertRepresentableFields({ balance: planned.balance, balanceAfter }, context);
    // Only the new allotment: the old balance lots keep what backs open holds, and the
    // rest of them expires as breakage.
    const after = lotBucketsAfter(planned.balance, planned.expiredHoldBacking, bonusCredits);
    const lots = planFirestoreLots(lotOptions, {
      raw,
      after,
      opRef: `cycle:${grantKey}`,
      apply: (plan) =>
        planLotReplace(plan, {
          spendable: after.spendable,
          backing: after.backing,
          grant: {
            spec: input.lot ?? { funding: "unknown" },
            sourceType: "subscription_cycle",
            sourceRef: grantKey,
          },
          reason: "cycle_replaced",
          ref: grantKey,
        }),
    });
    report.track(lots);
    const backing = await planHoldBacking(
      transaction,
      db,
      userId,
      planned.expiredHoldBacking,
      raw
    );

    const fields = {
      tier,
      balance: planned.balance,
      ...backing,
      monthlyLimit,
      monthlyUsed: 0,
      subscriptionExpiresAt: isoOf(input.subscriptionExpiresAt),
      monthlyResetAt: isoOf(input.monthlyResetAt),
    };
    transaction.update(balanceRef, {
      ...fields,
      ...writeLotPlan(transaction, db, userId, lots),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(entryRef, {
      userId,
      entryType: "credit",
      amount: credits,
      balanceBefore: sumAmounts(current.balance, bonusCredits),
      balanceAfter,
      source: "subscription_grant",
      referenceId: grantKey,
      referenceType: "subscription",
      description,
      // Caller metadata first: `tier` is what a repeat is compared on.
      metadata: { ...metadata, tier },
      createdAt: FieldValue.serverTimestamp(),
    });
    applyCallerDocUpdate(transaction, alsoUpdate);

    return {
      outcome: "granted",
      journalEntryId: entryRef.id,
      credits: {
        ...toPortableCredits(raw),
        ...fields,
        updatedAt: new Date().toISOString(),
      },
    };
  });
  report.flush();
  return outcome;
}
