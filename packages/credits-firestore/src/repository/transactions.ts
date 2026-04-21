import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type { PortableTransaction, CreateTransactionInput } from "@nehorai/credits";
import {
  getUserTransactionsCollection,
  getUserCreditsCollection,
  BALANCE_DOC_ID,
  DEFAULT_FREE_CREDITS,
  getNextMonthStart,
  toISOString,
  calculateCreditDeduction,
} from "./shared.js";

/**
 * Internal type for Firestore document data
 */
interface FirestoreUserCredits {
  userId: string;
  balance: number;
  bonusCredits?: number;
  reserved: number;
  tier: string;
  monthlyLimit: number;
  monthlyUsed: number;
  monthlyResetAt: unknown;
  subscriptionExpiresAt?: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

/**
 * Create a credit transaction record
 */
export async function createTransaction(
  db: Firestore,
  input: CreateTransactionInput
): Promise<PortableTransaction> {
  const transactionsCol = getUserTransactionsCollection(db, input.userId);
  const txRef = transactionsCol.doc();

  const transaction: PortableTransaction = {
    id: txRef.id,
    userId: input.userId,
    type: input.type,
    amount: input.amount,
    description: input.description,
    paymentRef: input.paymentRef,
    previousBalance: input.previousBalance,
    newBalance: input.newBalance,
    createdAt: new Date().toISOString(),
  };

  await txRef.set({
    ...transaction,
    createdAt: FieldValue.serverTimestamp(),
  });

  return transaction;
}

/**
 * Get user's credit transaction history with pagination
 */
export async function getTransactions(
  db: Firestore,
  userId: string,
  limit = 50,
  offset = 0
): Promise<PortableTransaction[]> {
  const transactionsCol = getUserTransactionsCollection(db, userId);

  const snapshot = await transactionsCol
    .orderBy("createdAt", "desc")
    .offset(offset)
    .limit(limit)
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      ...data,
      id: doc.id,
      createdAt: toISOString(data.createdAt),
    } as PortableTransaction;
  });
}

/**
 * Atomically add credits to user balance and create transaction record
 */
export async function addCreditsAtomic(
  db: Firestore,
  userId: string,
  amount: number,
  description: string,
  paymentRef?: string
): Promise<void> {
  const creditsCol = getUserCreditsCollection(db, userId);
  const transactionsCol = getUserTransactionsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);

  await db.runTransaction(async (transaction) => {
    const balanceDoc = await transaction.get(balanceRef);
    const currentBalance = balanceDoc.exists
      ? (balanceDoc.data() as FirestoreUserCredits).balance
      : 0;

    // Get current bonusCredits for transaction record
    const currentBonusCredits = balanceDoc.exists
      ? ((balanceDoc.data() as FirestoreUserCredits).bonusCredits ?? 0)
      : 0;

    // Create transaction record
    const txRef = transactionsCol.doc();
    transaction.set(txRef, {
      id: txRef.id,
      userId,
      type: paymentRef ? "purchase" : "bonus",
      amount,
      description,
      paymentRef,
      previousBalance: currentBalance + currentBonusCredits,
      newBalance: currentBalance + currentBonusCredits + amount,
      createdAt: FieldValue.serverTimestamp(),
    });

    // Update bonusCredits (not balance - bonusCredits persist across monthly resets)
    if (balanceDoc.exists) {
      transaction.update(balanceRef, {
        bonusCredits: FieldValue.increment(amount),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      // Initialize with added credits in bonusCredits
      const now = new Date();
      transaction.set(balanceRef, {
        userId,
        balance: DEFAULT_FREE_CREDITS,
        bonusCredits: amount,
        reserved: 0,
        tier: "free",
        monthlyLimit: DEFAULT_FREE_CREDITS,
        monthlyUsed: 0,
        monthlyResetAt: getNextMonthStart(now).toISOString(),
        subscriptionExpiresAt: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });
}

/**
 * Atomically deduct credits from user balance.
 *
 * Splits the deduction between `balance` (monthly, resets each cycle) and
 * `bonusCredits` (persistent, never resets), draining `balance` first so the
 * user keeps credits they paid for longer. Runs inside a Firestore transaction
 * so the availability check and the split are coherent — concurrent deducts
 * cannot drive either field negative.
 *
 * This is the admin-deduct path. It does NOT touch `reserved` or
 * `monthlyUsed` (those are owned by the reservation lifecycle, not by
 * administrative adjustments). It also does NOT write a transaction or
 * journal entry — the caller owns the audit record so it can attach
 * admin-specific metadata (reason, adminAction, etc.).
 *
 * @returns combined totals (`balance + bonusCredits`) before and after.
 */
export async function deductCreditsAtomic(
  db: Firestore,
  userId: string,
  amount: number
): Promise<{ previousBalance: number; newBalance: number }> {
  if (amount <= 0) {
    throw new Error(`deductCreditsAtomic amount must be positive (got ${amount})`);
  }

  const creditsCol = getUserCreditsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);

  return db.runTransaction(async (transaction) => {
    const balanceDoc = await transaction.get(balanceRef);
    if (!balanceDoc.exists) {
      throw new Error(`User credits not found for userId: ${userId}`);
    }

    const credits = balanceDoc.data() as FirestoreUserCredits;
    const bonusCredits = credits.bonusCredits ?? 0;
    const reserved = credits.reserved ?? 0;
    const available = credits.balance + bonusCredits - reserved;

    if (available < amount) {
      throw new Error(
        `Insufficient credits. Available: ${available}, requested: ${amount}`
      );
    }

    const { balanceDeduction, bonusDeduction } = calculateCreditDeduction(
      credits.balance,
      bonusCredits,
      amount
    );

    const updateData: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (balanceDeduction > 0) {
      updateData.balance = FieldValue.increment(-balanceDeduction);
    }
    if (bonusDeduction > 0) {
      updateData.bonusCredits = FieldValue.increment(-bonusDeduction);
    }

    transaction.update(balanceRef, updateData);

    const previousBalance = credits.balance + bonusCredits;
    return { previousBalance, newBalance: previousBalance - amount };
  });
}
