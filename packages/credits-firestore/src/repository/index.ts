import type { Firestore } from "firebase-admin/firestore";
import type {
  ICreditRepository,
  PortableUserCredits,
  PortableReservation,
  PortableTransaction,
  PortableUsageLog,
  PortableJournalEntry,
  CreditOperationType,
  SubscriptionTier,
  ReservationStatus,
  MonthlyResetResult,
  SubscriptionExpiryResult,
  CreateReservationInput,
  CreateTransactionInput,
  CreateUsageLogInput,
  UsageLogQuery,
  CreditBalanceUpdate,
  TierUpdateInput,
  CreateJournalEntryInput,
  JournalEntryQuery,
} from "@nehorai/credits";

// Import module functions
import * as BalanceOps from "./balance.js";
import * as TransactionOps from "./transactions.js";
import * as ReservationCrudOps from "./reservation-crud.js";
import * as ReservationAtomicOps from "./reservation-atomic.js";
import * as UsageLogOps from "./usage-logs.js";
import * as CleanupOps from "./cleanup.js";
import * as SubscriptionOps from "./subscription-ops.js";
import * as JournalOps from "./journal.js";

// Export module functions for advanced use cases
export {
  BalanceOps,
  TransactionOps,
  ReservationCrudOps,
  ReservationAtomicOps,
  UsageLogOps,
  CleanupOps,
  SubscriptionOps,
  JournalOps,
};

// Export shared utilities
export * from "./shared.js";
export * from "./state-machine.js";
export * from "./validation.js";

/**
 * Options for creating a Firestore credit repository
 */
export interface FirestoreRepositoryOptions {
  /**
   * Function to get monthly limit for a tier.
   * Used during monthly reset operations.
   * If not provided, uses the current monthlyLimit value.
   */
  getMonthlyLimit?: (tier: SubscriptionTier) => number;
}

/**
 * Firestore implementation of ICreditRepository
 *
 * Uses Firebase Admin SDK for server-side operations.
 * All atomic operations use Firestore transactions for consistency.
 */
export class FirestoreCreditRepository implements ICreditRepository {
  private readonly db: Firestore;
  private readonly options: FirestoreRepositoryOptions;

  constructor(db: Firestore, options: FirestoreRepositoryOptions = {}) {
    this.db = db;
    this.options = options;
  }

  // ==================== User Credits (Balance) ====================

  async getUserCredits(userId: string): Promise<PortableUserCredits | null> {
    return BalanceOps.getUserCredits(this.db, userId);
  }

  async initializeUserCredits(
    userId: string,
    tier: SubscriptionTier,
    initialBalance: number
  ): Promise<PortableUserCredits> {
    return BalanceOps.initializeUserCredits(this.db, userId, tier, initialBalance);
  }

  async updateUserCredits(userId: string, updates: CreditBalanceUpdate): Promise<void> {
    return BalanceOps.updateUserCredits(this.db, userId, updates);
  }

  async updateUserTier(userId: string, input: TierUpdateInput): Promise<void> {
    return BalanceOps.updateUserTier(this.db, userId, input);
  }

  // ==================== Reservations ====================

  async createReservation(input: CreateReservationInput): Promise<PortableReservation> {
    return ReservationCrudOps.createReservation(this.db, input);
  }

  async getReservation(userId: string, reservationId: string): Promise<PortableReservation | null> {
    return ReservationCrudOps.getReservation(this.db, userId, reservationId);
  }

  async updateReservationStatus(
    userId: string,
    reservationId: string,
    status: ReservationStatus,
    completedAt?: Date
  ): Promise<void> {
    return ReservationCrudOps.updateReservationStatus(
      this.db,
      userId,
      reservationId,
      status,
      completedAt
    );
  }

  // ==================== Atomic Operations ====================

  async reserveCreditsAtomic(
    userId: string,
    amount: number,
    operationType: CreditOperationType,
    expiresAt: Date
  ): Promise<PortableReservation> {
    return ReservationAtomicOps.reserveCreditsAtomic(
      this.db,
      userId,
      amount,
      operationType,
      expiresAt
    );
  }

  async commitReservationAtomic(userId: string, reservationId: string): Promise<void> {
    return ReservationAtomicOps.commitReservationAtomic(this.db, userId, reservationId);
  }

  async releaseReservationAtomic(userId: string, reservationId: string): Promise<void> {
    return ReservationAtomicOps.releaseReservationAtomic(this.db, userId, reservationId);
  }

  async addCreditsAtomic(
    userId: string,
    amount: number,
    description: string,
    paymentRef?: string
  ): Promise<void> {
    return TransactionOps.addCreditsAtomic(
      this.db,
      userId,
      amount,
      description,
      paymentRef
    );
  }

  // ==================== Transactions ====================

  async createTransaction(input: CreateTransactionInput): Promise<PortableTransaction> {
    return TransactionOps.createTransaction(this.db, input);
  }

  async getTransactions(
    userId: string,
    limit = 50,
    offset = 0
  ): Promise<PortableTransaction[]> {
    return TransactionOps.getTransactions(this.db, userId, limit, offset);
  }

  // ==================== Usage Logs ====================

  async logUsage(input: CreateUsageLogInput): Promise<PortableUsageLog> {
    return UsageLogOps.logUsage(this.db, input);
  }

  async getUsageLogs(query: UsageLogQuery): Promise<PortableUsageLog[]> {
    return UsageLogOps.getUsageLogs(this.db, query);
  }

  async getUsageLogsCount(query: Omit<UsageLogQuery, "limit" | "offset">): Promise<number> {
    return UsageLogOps.getUsageLogsCount(this.db, query);
  }

  // ==================== Cleanup Operations ====================

  async findAndExpireReservations(batchSize = 100, maxIterations = 100): Promise<{
    expiredCount: number;
    creditsReleased: number;
    errors: string[];
  }> {
    return CleanupOps.findAndExpireReservations(this.db, batchSize, maxIterations);
  }

  // ==================== Atomic Monthly Reset ====================

  async atomicMonthlyReset(
    userId: string,
    tier: SubscriptionTier,
    expectedResetAt: Date | string
  ): Promise<MonthlyResetResult> {
    return SubscriptionOps.atomicMonthlyReset(this.db, userId, tier, expectedResetAt, {
      getMonthlyLimit: this.options.getMonthlyLimit,
    });
  }

  // ==================== Subscription Expiry ====================

  async checkAndHandleSubscriptionExpiry(
    userId: string,
    gracePeriodDays = 3
  ): Promise<SubscriptionExpiryResult> {
    return SubscriptionOps.checkAndHandleSubscriptionExpiry(
      this.db,
      userId,
      gracePeriodDays
    );
  }

  // ==================== Journal Entries ====================

  async createJournalEntry(input: CreateJournalEntryInput): Promise<PortableJournalEntry> {
    return JournalOps.createJournalEntry(this.db, input);
  }

  async getJournalEntries(query: JournalEntryQuery): Promise<PortableJournalEntry[]> {
    return JournalOps.getJournalEntries(this.db, query);
  }

  async getJournalEntriesCount(
    query: Omit<JournalEntryQuery, "limit" | "offset">
  ): Promise<number> {
    return JournalOps.getJournalEntriesCount(this.db, query);
  }
}

/**
 * Factory function to create a Firestore credit repository
 *
 * @param db - Firestore instance from firebase-admin
 * @param options - Optional configuration
 * @returns ICreditRepository implementation for Firestore
 *
 * @example
 * ```typescript
 * import { createFirestoreCreditRepository } from '@nehorai/credits-firestore';
 * import { getFirestore } from 'firebase-admin/firestore';
 *
 * const db = getFirestore();
 * const repository = createFirestoreCreditRepository(db);
 *
 * // Use with CreditsService
 * const service = new CreditsService(repository);
 * ```
 */
export function createFirestoreCreditRepository(
  db: Firestore,
  options: FirestoreRepositoryOptions = {}
): ICreditRepository {
  return new FirestoreCreditRepository(db, options);
}
