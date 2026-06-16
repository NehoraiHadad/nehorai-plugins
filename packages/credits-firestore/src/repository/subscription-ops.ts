import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type {
  PortableUserCredits,
  SubscriptionTier,
  MonthlyResetResult,
  SubscriptionExpiryResult,
} from "@nehorai/credits";
import { isFreeTier, getDefaultTier } from "@nehorai/credits";
import {
  getUserCreditsCollection,
  BALANCE_DOC_ID,
  getNextMonthStart,
  DEFAULT_FREE_CREDITS,
  toDate,
  toISOString,
} from "./shared.js";

/**
 * Internal type for Firestore document data
 */
interface FirestoreUserCredits {
  userId: string;
  balance: number;
  bonusCredits?: number;
  reserved: number;
  tier: SubscriptionTier;
  monthlyLimit: number;
  monthlyUsed: number;
  monthlyResetAt: unknown;
  subscriptionExpiresAt?: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

/**
 * Convert Firestore document to portable format
 */
function toPortableCredits(data: FirestoreUserCredits): PortableUserCredits {
  return {
    userId: data.userId,
    balance: data.balance,
    bonusCredits: data.bonusCredits ?? 0,
    reserved: data.reserved,
    tier: data.tier,
    monthlyLimit: data.monthlyLimit,
    monthlyUsed: data.monthlyUsed,
    monthlyResetAt: toISOString(data.monthlyResetAt),
    subscriptionExpiresAt: data.subscriptionExpiresAt
      ? toISOString(data.subscriptionExpiresAt)
      : null,
    createdAt: toISOString(data.createdAt),
    updatedAt: toISOString(data.updatedAt),
  };
}

/**
 * Options for monthly reset
 */
export interface MonthlyResetOptions {
  /**
   * Function to get monthly limit for a tier
   * If not provided, defaults to current monthlyLimit value
   */
  getMonthlyLimit?: (tier: SubscriptionTier) => number;
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
 * @param tier - User's subscription tier
 * @param expectedResetAt - Expected monthlyResetAt value for optimistic locking
 * @param options - Optional configuration
 * @returns Result with wasReset flag and updated credits
 */
export async function atomicMonthlyReset(
  db: Firestore,
  userId: string,
  tier: SubscriptionTier,
  expectedResetAt: Date | string,
  options?: MonthlyResetOptions
): Promise<MonthlyResetResult> {
  const creditsCol = getUserCreditsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);

  const expectedResetDate = toDate(expectedResetAt);
  const now = new Date();

  return db.runTransaction(async (transaction) => {
    const balanceDoc = await transaction.get(balanceRef);

    if (!balanceDoc.exists) {
      throw new Error(`User credits not found for userId: ${userId}`);
    }

    const currentData = balanceDoc.data() as FirestoreUserCredits;
    const currentCredits = toPortableCredits(currentData);
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

    // Perform the reset
    const monthlyLimit = options?.getMonthlyLimit?.(tier) ?? currentData.monthlyLimit;
    const newResetAt = getNextMonthStart(now);

    // For unlimited tier (Infinity), preserve balance; for others, reset to monthly limit
    // IMPORTANT: bonusCredits is NOT included in updateData - it is preserved
    const newBalance = monthlyLimit === Infinity ? currentData.balance : monthlyLimit;

    const updateData = {
      monthlyUsed: 0,
      balance: newBalance,
      monthlyResetAt: newResetAt.toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
      // Note: bonusCredits is intentionally NOT reset - it persists across months
    };

    transaction.update(balanceRef, updateData);

    // Return the updated credits (simulate what they will be after commit)
    const updatedCredits: PortableUserCredits = {
      ...currentCredits,
      monthlyUsed: 0,
      balance: newBalance,
      monthlyResetAt: newResetAt.toISOString(),
      updatedAt: now.toISOString(),
    };

    return {
      wasReset: true,
      credits: updatedCredits,
    };
  });
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
 * @returns Result indicating whether downgrade occurred
 */
export async function checkAndHandleSubscriptionExpiry(
  db: Firestore,
  userId: string,
  gracePeriodDays = 3
): Promise<SubscriptionExpiryResult> {
  const creditsCol = getUserCreditsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);

  return db.runTransaction(async (transaction) => {
    const balanceDoc = await transaction.get(balanceRef);

    if (!balanceDoc.exists) {
      throw new Error(`User credits not found for userId: ${userId}`);
    }

    const currentData = balanceDoc.data() as FirestoreUserCredits;
    const currentCredits = toPortableCredits(currentData);

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
    const freeMonthlyLimit = DEFAULT_FREE_CREDITS;
    const newBalance = Math.min(currentData.balance, freeMonthlyLimit);

    // Note: bonusCredits is intentionally NOT modified during downgrade - it persists
    const updateData = {
      tier: downgradeTier,
      monthlyLimit: freeMonthlyLimit,
      balance: newBalance,
      subscriptionExpiresAt: null,
      updatedAt: FieldValue.serverTimestamp(),
    };

    transaction.update(balanceRef, updateData);

    const updatedCredits: PortableUserCredits = {
      ...currentCredits,
      tier: downgradeTier,
      monthlyLimit: freeMonthlyLimit,
      balance: newBalance,
      subscriptionExpiresAt: null,
      updatedAt: now.toISOString(),
    };

    return {
      wasDowngraded: true,
      inGracePeriod: false,
      graceDaysRemaining: 0,
      credits: updatedCredits,
    };
  });
}
