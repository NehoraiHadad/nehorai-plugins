/**
 * @nehorai/credits-firestore - Firestore adapter for the credits system
 *
 * This package provides a complete Firestore-based credit repository implementation.
 * It re-exports all types from @nehorai/credits and adds Firestore-specific utilities.
 *
 * @example
 * ```typescript
 * import { createFirestoreCreditRepository, CreditsService } from '@nehorai/credits-firestore';
 * import { getFirestore } from 'firebase-admin/firestore';
 *
 * // Create the repository with your Firestore instance
 * const db = getFirestore();
 * const repository = createFirestoreCreditRepository(db);
 *
 * // Use with CreditsService
 * const service = new CreditsService(repository);
 *
 * // Or use the repository directly
 * const credits = await repository.getUserCredits(userId);
 * ```
 */

// Re-export everything from core credits package
export * from "@nehorai/credits";

// Export the Firestore repository implementation
export {
  FirestoreCreditRepository,
  createFirestoreCreditRepository,
  type FirestoreRepositoryOptions,
  // Module functions for advanced use cases
  BalanceOps,
  TransactionOps,
  ReservationCrudOps,
  ReservationAtomicOps,
  UsageLogOps,
  CleanupOps,
  SubscriptionOps,
  JournalOps,
  // Shared utilities
  COLLECTIONS,
  BALANCE_DOC_ID,
  DEFAULT_FREE_CREDITS,
  getNextMonthStart,
  getUserCreditsCollection,
  getUserTransactionsCollection,
  getUserReservationsCollection,
  getUsageLogsCollection,
  calculateCreditDeduction,
  toISOString,
  toDate,
  getErrorMessage,
  // State machine
  isValidTransition,
  validateTransition,
  getValidNextStates,
  isTerminalState,
  // Validation
  validateBalanceUpdate,
  assertValidBalanceUpdate,
  type BalanceValidationResult,
} from "./repository/index.js";

// ==================== Additional Firestore Helpers ====================

/**
 * Get user credits collection path
 */
export function getUserCreditsPath(userId: string): string {
  return `users/${userId}/credits`;
}

/**
 * Get user transactions collection path
 */
export function getUserTransactionsPath(userId: string): string {
  return `users/${userId}/transactions`;
}

/**
 * Get user reservations collection path
 */
export function getUserReservationsPath(userId: string): string {
  return `users/${userId}/reservations`;
}

/**
 * Get user journal collection path
 */
export function getUserJournalPath(userId: string): string {
  return `users/${userId}/credits/data/journal`;
}

/**
 * Convert a Firestore Timestamp to ISO string (alias for toISOString)
 */
export function timestampToISO(value: unknown): string {
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
 * Convert a Firestore Timestamp to Date (alias for toDate)
 */
export function timestampToDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  // Handle Firestore Timestamp
  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof (value as { toDate: () => Date }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  return new Date();
}
