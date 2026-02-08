import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type {
  PortableUserCredits,
  SubscriptionTier,
  CreditBalanceUpdate,
  TierUpdateInput,
} from "@nehorai/credits";
import {
  getUserCreditsCollection,
  BALANCE_DOC_ID,
  getNextMonthStart,
  toISOString,
} from "./shared.js";
import { assertValidBalanceUpdate } from "./validation.js";

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
 * Get user's credit balance
 */
export async function getUserCredits(
  db: Firestore,
  userId: string
): Promise<PortableUserCredits | null> {
  const creditsCol = getUserCreditsCollection(db, userId);
  const balanceDoc = await creditsCol.doc(BALANCE_DOC_ID).get();

  if (!balanceDoc.exists) {
    return null;
  }

  const data = balanceDoc.data() as FirestoreUserCredits;
  return toPortableCredits(data);
}

/**
 * Initialize user credits with starting balance
 */
export async function initializeUserCredits(
  db: Firestore,
  userId: string,
  tier: SubscriptionTier,
  initialBalance: number
): Promise<PortableUserCredits> {
  const creditsCol = getUserCreditsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);

  const now = new Date();
  const monthlyResetAt = getNextMonthStart(now);

  const initialCredits = {
    userId,
    balance: initialBalance,
    bonusCredits: 0,
    reserved: 0,
    tier,
    monthlyLimit: initialBalance,
    monthlyUsed: 0,
    monthlyResetAt: monthlyResetAt.toISOString(),
    subscriptionExpiresAt: null,
  };

  await balanceRef.set({
    ...initialCredits,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return {
    ...initialCredits,
    monthlyResetAt: monthlyResetAt.toISOString(),
    subscriptionExpiresAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/**
 * Update user credit balance with partial updates
 *
 * Validates that the update won't result in:
 * - Negative balance
 * - Negative reserved
 * - Reserved exceeding balance
 *
 * @throws Error if validation fails
 */
export async function updateUserCredits(
  db: Firestore,
  userId: string,
  updates: CreditBalanceUpdate
): Promise<void> {
  const creditsCol = getUserCreditsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);

  // Fetch current state for validation
  const currentDoc = await balanceRef.get();
  if (!currentDoc.exists) {
    throw new Error(`User credits not found for userId: ${userId}`);
  }
  const currentData = currentDoc.data() as FirestoreUserCredits;
  const currentCredits = toPortableCredits(currentData);

  // Validate the update won't result in invalid state
  assertValidBalanceUpdate(currentCredits, updates);

  const updateData: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };

  // Handle absolute value updates
  if (updates.balance !== undefined) updateData.balance = updates.balance;
  if (updates.bonusCredits !== undefined) updateData.bonusCredits = updates.bonusCredits;
  if (updates.reserved !== undefined) updateData.reserved = updates.reserved;
  if (updates.tier !== undefined) updateData.tier = updates.tier;
  if (updates.monthlyLimit !== undefined) updateData.monthlyLimit = updates.monthlyLimit;
  if (updates.monthlyUsed !== undefined) updateData.monthlyUsed = updates.monthlyUsed;
  if (updates.monthlyResetAt !== undefined) {
    updateData.monthlyResetAt = updates.monthlyResetAt instanceof Date
      ? updates.monthlyResetAt.toISOString()
      : updates.monthlyResetAt;
  }
  if (updates.subscriptionExpiresAt !== undefined) {
    updateData.subscriptionExpiresAt = updates.subscriptionExpiresAt instanceof Date
      ? updates.subscriptionExpiresAt.toISOString()
      : updates.subscriptionExpiresAt;
  }

  // Handle increment updates
  if (updates.balanceIncrement !== undefined) {
    updateData.balance = FieldValue.increment(updates.balanceIncrement);
  }
  if (updates.bonusCreditsIncrement !== undefined) {
    updateData.bonusCredits = FieldValue.increment(updates.bonusCreditsIncrement);
  }
  if (updates.reservedIncrement !== undefined) {
    updateData.reserved = FieldValue.increment(updates.reservedIncrement);
  }
  if (updates.monthlyUsedIncrement !== undefined) {
    updateData.monthlyUsed = FieldValue.increment(updates.monthlyUsedIncrement);
  }

  await balanceRef.update(updateData);
}

/**
 * Update user's subscription tier and limits
 */
export async function updateUserTier(
  db: Firestore,
  userId: string,
  input: TierUpdateInput
): Promise<void> {
  const creditsCol = getUserCreditsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);

  const updateData: Record<string, unknown> = {
    tier: input.tier,
    monthlyLimit: input.monthlyLimit,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (input.balance !== undefined) updateData.balance = input.balance;
  if (input.monthlyUsed !== undefined) updateData.monthlyUsed = input.monthlyUsed;
  if (input.subscriptionExpiresAt !== undefined) {
    updateData.subscriptionExpiresAt = input.subscriptionExpiresAt instanceof Date
      ? input.subscriptionExpiresAt.toISOString()
      : input.subscriptionExpiresAt;
  }

  await balanceRef.update(updateData);
}
