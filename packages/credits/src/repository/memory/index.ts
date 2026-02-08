/**
 * In-Memory Credit Repository Implementation
 *
 * A database-agnostic implementation of ICreditRepository for testing and prototyping.
 * All data is stored in memory and lost when the process restarts.
 *
 * Usage:
 * - Unit tests without database dependency
 * - Local development and prototyping
 * - Reference implementation for custom repositories
 */

import type {
  PortableUserCredits,
  PortableReservation,
  PortableTransaction,
  PortableJournalEntry,
  PortableUsageLog,
  SubscriptionTier,
  ReservationStatus,
  MonthlyResetResult,
  SubscriptionExpiryResult,
} from "../../core/types.js";
import type {
  ICreditRepository,
  CreateReservationInput,
  CreateTransactionInput,
  CreateUsageLogInput,
  CreateJournalEntryInput,
  UsageLogQuery,
  JournalEntryQuery,
  CreditBalanceUpdate,
  TierUpdateInput,
} from "../types.js";
import { generateId, toDate, getNextMonthlyReset } from "../utils.js";
import { getConfig, getConfigMonthlyLimit } from "../../config/index.js";

/**
 * In-Memory implementation of ICreditRepository
 *
 * Implements all repository methods using Map-based storage.
 * Useful for testing and as a reference implementation.
 */
export class InMemoryCreditRepository implements ICreditRepository {
  private users = new Map<string, PortableUserCredits>();
  private reservations = new Map<string, Map<string, PortableReservation>>();
  private transactions = new Map<string, PortableTransaction[]>();
  private usageLogs: PortableUsageLog[] = [];
  private journalEntries = new Map<string, PortableJournalEntry[]>();

  // ==================== User Credits ====================

  async getUserCredits(userId: string): Promise<PortableUserCredits | null> {
    return this.users.get(userId) ?? null;
  }

  async initializeUserCredits(
    userId: string,
    tier: SubscriptionTier,
    initialBalance: number
  ): Promise<PortableUserCredits> {
    const now = new Date().toISOString();
    const credits: PortableUserCredits = {
      userId,
      balance: initialBalance,
      bonusCredits: 0,
      reserved: 0,
      tier,
      monthlyLimit: getConfigMonthlyLimit(tier),
      monthlyUsed: 0,
      monthlyResetAt: getNextMonthlyReset().toISOString(),
      subscriptionExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(userId, credits);
    return credits;
  }

  async updateUserCredits(userId: string, updates: CreditBalanceUpdate): Promise<void> {
    const credits = this.users.get(userId);
    if (!credits) {
      throw new Error(`User ${userId} not found`);
    }

    const now = new Date().toISOString();

    // Apply absolute updates
    if (updates.balance !== undefined) credits.balance = updates.balance;
    if (updates.bonusCredits !== undefined) credits.bonusCredits = updates.bonusCredits;
    if (updates.reserved !== undefined) credits.reserved = updates.reserved;
    if (updates.tier !== undefined) credits.tier = updates.tier;
    if (updates.monthlyLimit !== undefined) credits.monthlyLimit = updates.monthlyLimit;
    if (updates.monthlyUsed !== undefined) credits.monthlyUsed = updates.monthlyUsed;
    if (updates.monthlyResetAt !== undefined) {
      credits.monthlyResetAt = updates.monthlyResetAt instanceof Date
        ? updates.monthlyResetAt.toISOString()
        : updates.monthlyResetAt;
    }
    if (updates.subscriptionExpiresAt !== undefined) {
      if (updates.subscriptionExpiresAt === null) {
        credits.subscriptionExpiresAt = null;
      } else {
        credits.subscriptionExpiresAt = updates.subscriptionExpiresAt instanceof Date
          ? updates.subscriptionExpiresAt.toISOString()
          : updates.subscriptionExpiresAt;
      }
    }

    // Apply increments
    if (updates.balanceIncrement !== undefined) {
      credits.balance += updates.balanceIncrement;
    }
    if (updates.bonusCreditsIncrement !== undefined) {
      credits.bonusCredits += updates.bonusCreditsIncrement;
    }
    if (updates.reservedIncrement !== undefined) {
      credits.reserved += updates.reservedIncrement;
    }
    if (updates.monthlyUsedIncrement !== undefined) {
      credits.monthlyUsed += updates.monthlyUsedIncrement;
    }

    credits.updatedAt = now;
    this.users.set(userId, credits);
  }

  async updateUserTier(userId: string, input: TierUpdateInput): Promise<void> {
    const credits = this.users.get(userId);
    if (!credits) {
      throw new Error(`User ${userId} not found`);
    }

    credits.tier = input.tier;
    credits.monthlyLimit = input.monthlyLimit;
    if (input.balance !== undefined) credits.balance = input.balance;
    if (input.monthlyUsed !== undefined) credits.monthlyUsed = input.monthlyUsed;
    if (input.subscriptionExpiresAt !== undefined) {
      if (input.subscriptionExpiresAt === null) {
        credits.subscriptionExpiresAt = null;
      } else {
        credits.subscriptionExpiresAt = input.subscriptionExpiresAt instanceof Date
          ? input.subscriptionExpiresAt.toISOString()
          : input.subscriptionExpiresAt;
      }
    }
    credits.updatedAt = new Date().toISOString();

    this.users.set(userId, credits);
  }

  // ==================== Reservations ====================

  async createReservation(input: CreateReservationInput): Promise<PortableReservation> {
    const now = new Date().toISOString();
    const reservation: PortableReservation = {
      id: generateId(),
      userId: input.userId,
      amount: input.amount,
      operationType: input.operationType,
      status: "reserved",
      createdAt: now,
      expiresAt: input.expiresAt.toISOString(),
    };

    if (!this.reservations.has(input.userId)) {
      this.reservations.set(input.userId, new Map());
    }
    this.reservations.get(input.userId)!.set(reservation.id, reservation);

    return reservation;
  }

  async getReservation(
    userId: string,
    reservationId: string
  ): Promise<PortableReservation | null> {
    const userReservations = this.reservations.get(userId);
    if (!userReservations) return null;
    return userReservations.get(reservationId) ?? null;
  }

  async updateReservationStatus(
    userId: string,
    reservationId: string,
    status: ReservationStatus,
    completedAt?: Date
  ): Promise<void> {
    const userReservations = this.reservations.get(userId);
    if (!userReservations) {
      throw new Error(`No reservations found for user ${userId}`);
    }

    const reservation = userReservations.get(reservationId);
    if (!reservation) {
      throw new Error(`Reservation ${reservationId} not found`);
    }

    reservation.status = status;
    if (completedAt) reservation.completedAt = completedAt.toISOString();

    userReservations.set(reservationId, reservation);
  }

  // ==================== Atomic Operations ====================

  async reserveCreditsAtomic(
    userId: string,
    amount: number,
    operationType: string,
    expiresAt: Date
  ): Promise<PortableReservation> {
    const credits = this.users.get(userId);
    if (!credits) {
      throw new Error(`User ${userId} not found`);
    }

    // Calculate available credits (balance + bonusCredits - reserved)
    const available = credits.balance + credits.bonusCredits - credits.reserved;
    if (available < amount) {
      throw new Error(
        `Insufficient credits. Available: ${available}, Required: ${amount}`
      );
    }

    // Create reservation
    const reservation = await this.createReservation({
      userId,
      amount,
      operationType,
      expiresAt,
    });

    // Update reserved amount
    credits.reserved += amount;
    credits.updatedAt = new Date().toISOString();
    this.users.set(userId, credits);

    return reservation;
  }

  async commitReservationAtomic(userId: string, reservationId: string): Promise<void> {
    const credits = this.users.get(userId);
    if (!credits) {
      throw new Error(`User ${userId} not found`);
    }

    const reservation = await this.getReservation(userId, reservationId);
    if (!reservation) {
      throw new Error(`Reservation ${reservationId} not found`);
    }

    if (reservation.status !== "reserved") {
      throw new Error(
        `Cannot commit reservation in ${reservation.status} state`
      );
    }

    const amount = reservation.amount;

    // Deduct from balance (bonus credits first logic can be added if needed)
    credits.balance -= amount;
    credits.reserved -= amount;
    credits.monthlyUsed += amount;
    credits.updatedAt = new Date().toISOString();
    this.users.set(userId, credits);

    // Update reservation status
    await this.updateReservationStatus(userId, reservationId, "committed", new Date());
  }

  async releaseReservationAtomic(userId: string, reservationId: string): Promise<void> {
    const credits = this.users.get(userId);
    if (!credits) {
      throw new Error(`User ${userId} not found`);
    }

    const reservation = await this.getReservation(userId, reservationId);
    if (!reservation) {
      throw new Error(`Reservation ${reservationId} not found`);
    }

    if (reservation.status !== "reserved") {
      // Already processed, no-op
      return;
    }

    // Release reserved credits
    credits.reserved -= reservation.amount;
    credits.updatedAt = new Date().toISOString();
    this.users.set(userId, credits);

    // Update reservation status
    await this.updateReservationStatus(userId, reservationId, "released", new Date());
  }

  async addCreditsAtomic(
    userId: string,
    amount: number,
    description: string,
    paymentRef?: string
  ): Promise<void> {
    const credits = this.users.get(userId);
    if (!credits) {
      throw new Error(`User ${userId} not found`);
    }

    const previousBalance = credits.bonusCredits;
    credits.bonusCredits += amount;
    credits.updatedAt = new Date().toISOString();
    this.users.set(userId, credits);

    // Create transaction
    await this.createTransaction({
      userId,
      type: "purchase",
      amount,
      description,
      paymentRef,
      previousBalance,
      newBalance: credits.bonusCredits,
    });
  }

  // ==================== Transactions ====================

  async createTransaction(input: CreateTransactionInput): Promise<PortableTransaction> {
    const transaction: PortableTransaction = {
      id: generateId(),
      userId: input.userId,
      type: input.type,
      amount: input.amount,
      description: input.description,
      paymentRef: input.paymentRef,
      previousBalance: input.previousBalance,
      newBalance: input.newBalance,
      createdAt: new Date().toISOString(),
    };

    if (!this.transactions.has(input.userId)) {
      this.transactions.set(input.userId, []);
    }
    this.transactions.get(input.userId)!.push(transaction);

    return transaction;
  }

  async getTransactions(
    userId: string,
    limit = 50,
    offset = 0
  ): Promise<PortableTransaction[]> {
    const userTransactions = this.transactions.get(userId) ?? [];
    // Sort by createdAt descending (most recent first)
    const sorted = [...userTransactions].sort((a, b) => {
      const aDate = toDate(a.createdAt).getTime();
      const bDate = toDate(b.createdAt).getTime();
      return bDate - aDate;
    });
    return sorted.slice(offset, offset + limit);
  }

  // ==================== Usage Logs ====================

  async logUsage(input: CreateUsageLogInput): Promise<PortableUsageLog> {
    const log: PortableUsageLog = {
      id: generateId(),
      userId: input.userId,
      operationType: input.operationType,
      provider: input.provider,
      creditsUsed: input.creditsUsed,
      success: input.success,
      errorMessage: input.errorMessage,
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      requestId: input.requestId,
      metadata: input.metadata,
      createdAt: new Date().toISOString(),
    };

    this.usageLogs.push(log);
    return log;
  }

  async getUsageLogs(query: UsageLogQuery): Promise<PortableUsageLog[]> {
    let results = [...this.usageLogs];

    // Apply filters
    if (query.userId) {
      results = results.filter((log) => log.userId === query.userId);
    }
    if (query.operationType) {
      results = results.filter((log) => log.operationType === query.operationType);
    }
    if (query.success !== undefined) {
      results = results.filter((log) => log.success === query.success);
    }
    if (query.startDate) {
      const startTime = query.startDate.getTime();
      results = results.filter(
        (log) => toDate(log.createdAt).getTime() >= startTime
      );
    }
    if (query.endDate) {
      const endTime = query.endDate.getTime();
      results = results.filter(
        (log) => toDate(log.createdAt).getTime() <= endTime
      );
    }

    // Sort by createdAt descending
    results.sort((a, b) => {
      return toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime();
    });

    // Apply pagination
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return results.slice(offset, offset + limit);
  }

  async getUsageLogsCount(
    query: Omit<UsageLogQuery, "limit" | "offset">
  ): Promise<number> {
    const results = await this.getUsageLogs({ ...query, limit: Infinity, offset: 0 });
    return results.length;
  }

  // ==================== Journal Entries ====================

  async createJournalEntry(input: CreateJournalEntryInput): Promise<PortableJournalEntry> {
    const entry: PortableJournalEntry = {
      id: generateId(),
      userId: input.userId,
      entryType: input.entryType,
      amount: input.amount,
      balanceAfter: input.balanceAfter,
      source: input.source,
      referenceId: input.referenceId,
      referenceType: input.referenceType,
      description: input.description,
      metadata: input.metadata,
      createdAt: new Date().toISOString(),
    };

    if (!this.journalEntries.has(input.userId)) {
      this.journalEntries.set(input.userId, []);
    }
    this.journalEntries.get(input.userId)!.push(entry);

    return entry;
  }

  async getJournalEntries(query: JournalEntryQuery): Promise<PortableJournalEntry[]> {
    let results = this.journalEntries.get(query.userId) ?? [];

    // Apply filters
    if (query.source) {
      results = results.filter((entry) => entry.source === query.source);
    }
    if (query.referenceType) {
      results = results.filter((entry) => entry.referenceType === query.referenceType);
    }
    if (query.startDate) {
      const startTime = query.startDate.getTime();
      results = results.filter(
        (entry) => toDate(entry.createdAt).getTime() >= startTime
      );
    }
    if (query.endDate) {
      const endTime = query.endDate.getTime();
      results = results.filter(
        (entry) => toDate(entry.createdAt).getTime() <= endTime
      );
    }

    // Sort by createdAt descending
    results = [...results].sort((a, b) => {
      return toDate(b.createdAt).getTime() - toDate(a.createdAt).getTime();
    });

    // Apply pagination
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return results.slice(offset, offset + limit);
  }

  async getJournalEntriesCount(
    query: Omit<JournalEntryQuery, "limit" | "offset">
  ): Promise<number> {
    const results = await this.getJournalEntries({
      ...query,
      limit: Infinity,
      offset: 0,
    });
    return results.length;
  }

  // ==================== Cleanup Operations ====================

  async findAndExpireReservations(
    _batchSize = 100,
    _maxIterations = 100
  ): Promise<{
    expiredCount: number;
    creditsReleased: number;
    errors: string[];
  }> {
    const now = new Date();
    let expiredCount = 0;
    let creditsReleased = 0;
    const errors: string[] = [];

    for (const [userId, userReservations] of this.reservations) {
      for (const [reservationId, reservation] of userReservations) {
        if (
          reservation.status === "reserved" &&
          toDate(reservation.expiresAt).getTime() < now.getTime()
        ) {
          try {
            // Release the reservation
            await this.releaseReservationAtomic(userId, reservationId);
            // Mark as expired instead of released
            reservation.status = "expired";
            userReservations.set(reservationId, reservation);

            expiredCount++;
            creditsReleased += reservation.amount;
          } catch (error) {
            errors.push(
              `Failed to expire reservation ${reservationId}: ${error}`
            );
          }
        }
      }
    }

    return { expiredCount, creditsReleased, errors };
  }

  // ==================== Atomic Monthly Reset ====================

  async atomicMonthlyReset(
    userId: string,
    tier: SubscriptionTier,
    expectedResetAt: Date | string
  ): Promise<MonthlyResetResult> {
    const credits = this.users.get(userId);
    if (!credits) {
      throw new Error(`User ${userId} not found`);
    }

    // Optimistic locking: check if expectedResetAt matches current value
    const currentResetAt = toDate(credits.monthlyResetAt).getTime();
    const expected = toDate(expectedResetAt).getTime();

    if (currentResetAt !== expected) {
      // Another request already performed the reset
      return { wasReset: false, credits };
    }

    // Perform the reset
    const newBalance = getConfigMonthlyLimit(tier);
    const nextReset = getNextMonthlyReset();

    credits.balance = newBalance === Infinity ? credits.balance : newBalance;
    credits.monthlyUsed = 0;
    credits.monthlyResetAt = nextReset.toISOString();
    credits.updatedAt = new Date().toISOString();

    this.users.set(userId, credits);

    return { wasReset: true, credits };
  }

  // ==================== Subscription Expiry ====================

  async checkAndHandleSubscriptionExpiry(
    userId: string,
    gracePeriodDays = 3
  ): Promise<SubscriptionExpiryResult> {
    const credits = this.users.get(userId);
    if (!credits) {
      throw new Error(`User ${userId} not found`);
    }

    // Free tier doesn't expire
    if (credits.tier === "free" || !credits.subscriptionExpiresAt) {
      return {
        wasDowngraded: false,
        inGracePeriod: false,
        graceDaysRemaining: 0,
        credits,
      };
    }

    const now = new Date();
    const expiresAt = toDate(credits.subscriptionExpiresAt);
    const daysSinceExpiry =
      (now.getTime() - expiresAt.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceExpiry <= 0) {
      // Not expired yet
      return {
        wasDowngraded: false,
        inGracePeriod: false,
        graceDaysRemaining: 0,
        credits,
      };
    }

    if (daysSinceExpiry <= gracePeriodDays) {
      // In grace period
      return {
        wasDowngraded: false,
        inGracePeriod: true,
        graceDaysRemaining: Math.ceil(gracePeriodDays - daysSinceExpiry),
        credits,
      };
    }

    // Grace period expired - downgrade to free
    const config = getConfig();
    const freeTierConfig = config.tierConfigs.free!;

    credits.tier = "free";
    credits.monthlyLimit = freeTierConfig.monthlyCredits;
    credits.balance = Math.min(credits.balance, freeTierConfig.monthlyCredits);
    credits.subscriptionExpiresAt = null;
    credits.updatedAt = new Date().toISOString();

    this.users.set(userId, credits);

    return {
      wasDowngraded: true,
      inGracePeriod: false,
      graceDaysRemaining: 0,
      credits,
    };
  }

  // ==================== Testing Utilities ====================

  /**
   * Clear all data (useful for testing)
   */
  clear(): void {
    this.users.clear();
    this.reservations.clear();
    this.transactions.clear();
    this.usageLogs = [];
    this.journalEntries.clear();
  }

  /**
   * Get all users (useful for testing/debugging)
   */
  getAllUsers(): PortableUserCredits[] {
    return Array.from(this.users.values());
  }

  /**
   * Get all reservations for a user (useful for testing)
   */
  getAllReservations(userId: string): PortableReservation[] {
    const userReservations = this.reservations.get(userId);
    if (!userReservations) return [];
    return Array.from(userReservations.values());
  }
}

/**
 * Create a new in-memory repository instance
 * Each call creates a fresh, isolated instance
 */
export function createInMemoryCreditRepository(): InMemoryCreditRepository {
  return new InMemoryCreditRepository();
}
