import type { Firestore } from "firebase-admin/firestore";

/**
 * Collection name constants
 */
export const COLLECTIONS = {
  users: "users",
  credits: "credits",
  transactions: "transactions",
  reservations: "reservations",
  usageLogs: "usage-logs",
} as const;

/**
 * Balance document ID (single doc per user)
 */
export const BALANCE_DOC_ID = "balance";

/**
 * Default free credits for new users
 */
export const DEFAULT_FREE_CREDITS = 25;

/**
 * Calculate the start of next month from a given date
 */
export function getNextMonthStart(date: Date = new Date()): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + 1);
  next.setDate(1);
  next.setHours(0, 0, 0, 0);
  return next;
}

/**
 * Get user credits collection reference
 */
export function getUserCreditsCollection(db: Firestore, userId: string) {
  return db
    .collection(COLLECTIONS.users)
    .doc(userId)
    .collection(COLLECTIONS.credits);
}

/**
 * Get user transactions collection reference
 */
export function getUserTransactionsCollection(db: Firestore, userId: string) {
  return db
    .collection(COLLECTIONS.users)
    .doc(userId)
    .collection(COLLECTIONS.transactions);
}

/**
 * Get user reservations collection reference
 */
export function getUserReservationsCollection(db: Firestore, userId: string) {
  return db
    .collection(COLLECTIONS.users)
    .doc(userId)
    .collection(COLLECTIONS.reservations);
}

/**
 * Get usage logs collection reference
 */
export function getUsageLogsCollection(db: Firestore) {
  return db.collection(COLLECTIONS.usageLogs);
}

/**
 * Calculate how to split a credit deduction between balance and bonusCredits
 * Deducts from balance first, then bonusCredits
 */
export function calculateCreditDeduction(
  balance: number,
  bonusCredits: number,
  amount: number
): { balanceDeduction: number; bonusDeduction: number } {
  const balanceDeduction = Math.min(balance, amount);
  const bonusDeduction = amount - balanceDeduction;
  return { balanceDeduction, bonusDeduction };
}

/**
 * Convert any timestamp-like value to ISO string
 */
export function toISOString(value: unknown): string {
  if (!value) return new Date().toISOString();
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  // Handle Firestore Timestamp
  if (
    typeof value === "object" &&
    "toDate" in value &&
    typeof (value as { toDate: () => Date }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return new Date().toISOString();
}

/**
 * Convert date-like value to Date object
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
 * Get error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}
