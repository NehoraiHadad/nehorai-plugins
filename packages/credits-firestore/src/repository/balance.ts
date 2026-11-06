import { FieldValue } from "firebase-admin/firestore";
import type { DocumentReference, Firestore } from "firebase-admin/firestore";
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
} from "./shared.js";
import {
  assertValidTierBalanceInput,
  isFreeTier,
  planBalanceCap,
  planBalanceTarget,
  sumAmounts,
} from "@nehorai/credits";
import { toPortableCredits, type FirestoreUserCredits } from "./credits-doc.js";
import { planHoldBacking } from "./hold-backing.js";
import { assertValidBalanceUpdate } from "./validation.js";

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
 * Firestore-only options for `initializeUserCredits`.
 */
export interface InitializeUserCreditsOptions {
  /**
   * The document that records a signup grant was already given, computed by the
   * app (for example from a keyed email hash). It decides the starting balance when
   * this call creates the account, and is never read for an existing account.
   */
  signupGrantClaim?: DocumentReference;
}

/**
 * Create the account if it is missing, in one transaction. An existing account is
 * returned unchanged, so a late second call cannot wipe a balance already in use.
 *
 * With `signupGrantClaim`, a new account starts at 0 when the claim document exists.
 * Otherwise it gets `initialBalance`, and a grant above 0 writes the claim holding
 * only a server timestamp. `signupGrant` on the balance document records a grant that
 * was given and is absent otherwise, and `monthlyLimit` is `initialBalance` either
 * way, because it describes the tier and not this account's grant.
 */
export async function initializeUserCredits(
  db: Firestore,
  userId: string,
  tier: SubscriptionTier,
  initialBalance: number,
  options?: InitializeUserCreditsOptions
): Promise<PortableUserCredits> {
  const creditsCol = getUserCreditsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);
  const claimRef = options?.signupGrantClaim;

  return db.runTransaction(async (transaction) => {
    const balanceDoc = await transaction.get(balanceRef);
    if (balanceDoc.exists) {
      return toPortableCredits(balanceDoc.data() as FirestoreUserCredits);
    }

    const claimTaken = claimRef ? (await transaction.get(claimRef)).exists : false;
    const balance = claimTaken ? 0 : initialBalance;
    if (claimRef && !claimTaken && balance > 0) {
      transaction.create(claimRef, { claimedAt: FieldValue.serverTimestamp() });
    }

    const now = new Date();
    const initialCredits = {
      userId,
      balance,
      bonusCredits: 0,
      reserved: 0,
      tier,
      monthlyLimit: initialBalance,
      monthlyUsed: 0,
      monthlyResetAt: getNextMonthStart(now).toISOString(),
      subscriptionExpiresAt: null,
      ...(claimRef && balance > 0 ? { signupGrant: balance } : {}),
    };
    transaction.create(balanceRef, {
      ...initialCredits,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      ...initialCredits,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
  });
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

  // One transaction, so the validated state is the state the write lands on and
  // increments can be applied as exact cent-grid values (FieldValue.increment adds
  // in IEEE 754: 0.1 + 0.2 stores 0.30000000000000004).
  await db.runTransaction(async (transaction) => {
    const currentDoc = await transaction.get(balanceRef);
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
    if (updates.balance !== undefined) {
      updateData.balance = updates.balance;
    }
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
      updateData.balance = sumAmounts(
        updates.balance ?? currentCredits.balance,
        updates.balanceIncrement
      );
    }
    if (updates.bonusCreditsIncrement !== undefined) {
      updateData.bonusCredits = sumAmounts(
        updates.bonusCredits ?? currentCredits.bonusCredits ?? 0,
        updates.bonusCreditsIncrement
      );
    }
    if (updates.reservedIncrement !== undefined) {
      updateData.reserved = sumAmounts(
        updates.reserved ?? currentCredits.reserved ?? 0,
        updates.reservedIncrement
      );
    }
    if (updates.monthlyUsedIncrement !== undefined) {
      updateData.monthlyUsed = sumAmounts(
        updates.monthlyUsed ?? currentCredits.monthlyUsed ?? 0,
        updates.monthlyUsedIncrement
      );
    }

    // An absolute balance replaces what the marked credits were part of. An increment
    // cannot reach them: the validator refused it.
    const marked = currentCredits.expiredHoldBacking ?? 0;
    if (marked > 0 && updates.balance !== undefined) {
      const backing = await planHoldBacking(transaction, db, userId, 0, marked);
      Object.assign(updateData, backing.patch);
      backing.write();
    }

    transaction.update(balanceRef, updateData);
  });
}

/**
 * Update user's subscription tier and limits
 *
 * A balance change runs in a transaction from the stored document. `balanceCap`
 * cannot write back a balance a concurrent charge has spent, and neither it nor
 * `balance` cuts through the credits backing outstanding holds. A write with neither
 * is a plain update.
 */
export async function updateUserTier(
  db: Firestore,
  userId: string,
  input: TierUpdateInput
): Promise<void> {
  assertValidTierBalanceInput(input, { userId, operation: "updateUserTier" });

  const creditsCol = getUserCreditsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);

  const updateData: Record<string, unknown> = {
    tier: input.tier,
    monthlyLimit: input.monthlyLimit,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (input.monthlyUsed !== undefined) updateData.monthlyUsed = input.monthlyUsed;
  if (input.subscriptionExpiresAt !== undefined) {
    updateData.subscriptionExpiresAt = input.subscriptionExpiresAt instanceof Date
      ? input.subscriptionExpiresAt.toISOString()
      : input.subscriptionExpiresAt;
  }

  const { balance, balanceCap } = input;
  if (balance === undefined && balanceCap === undefined) {
    await balanceRef.update(updateData);
    return;
  }

  await db.runTransaction(async (transaction) => {
    const currentDoc = await transaction.get(balanceRef);
    if (!currentDoc.exists) {
      throw new Error(`User credits not found for userId: ${userId}`);
    }
    const current = currentDoc.data() as FirestoreUserCredits;
    const reserved = current.reserved ?? 0;
    const bonusCredits = current.bonusCredits ?? 0;

    let planned: ReturnType<typeof planBalanceTarget> | undefined;
    if (balance !== undefined) {
      planned = planBalanceTarget(balance, reserved, bonusCredits);
    } else if (balanceCap !== undefined && !isFreeTier(current.tier)) {
      planned = planBalanceCap(
        current.balance,
        balanceCap,
        reserved,
        bonusCredits,
        current.expiredHoldBacking
      );
    }

    const backing = planned
      ? await planHoldBacking(
          transaction,
          db,
          userId,
          planned.expiredHoldBacking,
          current.expiredHoldBacking
        )
      : undefined;
    backing?.write();

    transaction.update(
      balanceRef,
      planned
        ? {
            ...updateData,
            balance: planned.balance,
            ...backing?.patch,
          }
        : updateData
    );
  });
}
