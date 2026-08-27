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
  AddCreditsAtomicOptions,
} from "../types.js";
import type {
  CommitOutcome,
  ExpireOutcome,
  ReleaseOutcome,
  ReserveOutcome,
} from "../../core/outcomes.js";
import type {
  ExpireReservationV2Options,
  ReservationTransitionOptions,
  ReserveCreditsV2Input,
} from "../v2-types.js";
import {
  createInsufficientCreditsError,
  createReservationAlreadyProcessedError,
  createReservationNotFoundError,
} from "../../core/errors.js";
import { generateId, toDate, getNextMonthlyReset } from "../utils.js";
import { MemoryStore, scopedKey } from "./store.js";
import {
  commitReservationV2,
  expireReservationV2,
  releaseReservationV2,
  reserveCreditsV2,
} from "./v2.js";
import {
  getConfigMonthlyLimit,
  getConfigTierConfig,
  getDefaultTier,
  isFreeTier,
} from "../../config/index.js";

/**
 * In-Memory implementation of ICreditRepository
 *
 * Implements all repository methods using Map-based storage.
 * Useful for testing and as a reference implementation.
 */
export class InMemoryCreditRepository implements ICreditRepository {
  private readonly store = new MemoryStore();

  // ==================== User Credits ====================

  async getUserCredits(userId: string): Promise<PortableUserCredits | null> {
    return this.store.users.get(userId) ?? null;
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
    this.store.users.set(userId, credits);
    return credits;
  }

  async updateUserCredits(userId: string, updates: CreditBalanceUpdate): Promise<void> {
    const credits = this.store.users.get(userId);
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
    this.store.users.set(userId, credits);
  }

  async updateUserTier(userId: string, input: TierUpdateInput): Promise<void> {
    const credits = this.store.users.get(userId);
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

    this.store.users.set(userId, credits);
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
      idempotencyKey: input.idempotencyKey,
    };

    if (!this.store.reservations.has(input.userId)) {
      this.store.reservations.set(input.userId, new Map());
    }
    this.store.reservations.get(input.userId)!.set(reservation.id, reservation);
    if (input.idempotencyKey) {
      this.store.reservationKeys.set(
        scopedKey(input.userId, input.idempotencyKey),
        reservation.id
      );
    }

    return reservation;
  }

  async getReservation(
    userId: string,
    reservationId: string
  ): Promise<PortableReservation | null> {
    const userReservations = this.store.reservations.get(userId);
    if (!userReservations) return null;
    return userReservations.get(reservationId) ?? null;
  }

  async updateReservationStatus(
    userId: string,
    reservationId: string,
    status: ReservationStatus,
    completedAt?: Date
  ): Promise<void> {
    const userReservations = this.store.reservations.get(userId);
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

  // ==================== V2 boundary ====================
  //
  // As in the Drizzle adapter, V2 is the real implementation and the legacy
  // `*Atomic` methods are adapters over it, so both APIs share one set of
  // guarantees.

  async reserveCreditsV2(input: ReserveCreditsV2Input): Promise<ReserveOutcome> {
    return reserveCreditsV2(this.store, input);
  }

  async commitReservationV2(
    userId: string,
    reservationId: string,
    options?: ReservationTransitionOptions
  ): Promise<CommitOutcome> {
    return commitReservationV2(this.store, userId, reservationId, options);
  }

  async releaseReservationV2(
    userId: string,
    reservationId: string,
    options?: ReservationTransitionOptions
  ): Promise<ReleaseOutcome> {
    return releaseReservationV2(this.store, userId, reservationId, options);
  }

  async expireReservationV2(
    userId: string,
    reservationId: string,
    options?: ExpireReservationV2Options
  ): Promise<ExpireOutcome> {
    return expireReservationV2(this.store, userId, reservationId, options);
  }

  // ==================== Legacy atomic operations ====================

  async reserveCreditsAtomic(
    userId: string,
    amount: number,
    operationType: string,
    expiresAt: Date
  ): Promise<PortableReservation> {
    const outcome = await this.reserveCreditsV2({ userId, amount, operationType, expiresAt });
    if (outcome.outcome === "created" || outcome.outcome === "replayed") {
      return outcome.reservation;
    }
    if (outcome.outcome === "insufficient") {
      throw createInsufficientCreditsError(outcome.required, outcome.available);
    }
    throw createReservationAlreadyProcessedError(outcome.existing.id, outcome.existing.status);
  }

  async commitReservationAtomic(userId: string, reservationId: string): Promise<void> {
    const outcome = await this.commitReservationV2(userId, reservationId);
    if (outcome.outcome === "committed") return;
    if (outcome.outcome === "not_found") throw createReservationNotFoundError(reservationId);
    // Re-delivering a commit for an already-committed reservation stays a no-op.
    if (outcome.terminalStatus === "committed") return;
    throw createReservationAlreadyProcessedError(reservationId, outcome.terminalStatus);
  }

  async releaseReservationAtomic(userId: string, reservationId: string): Promise<void> {
    const outcome = await this.releaseReservationV2(userId, reservationId);
    if (outcome.outcome === "not_found") throw createReservationNotFoundError(reservationId);
    // Releasing an already-terminal reservation is a no-op, as before.
  }

  async addCreditsAtomic(
    userId: string,
    amount: number,
    description: string,
    paymentRef?: string,
    options?: AddCreditsAtomicOptions
  ): Promise<void> {
    const credits = this.store.users.get(userId);
    if (!credits) {
      throw new Error(`User ${userId} not found`);
    }

    const previousTotal = credits.balance + credits.bonusCredits;
    credits.bonusCredits += amount;
    credits.updatedAt = new Date().toISOString();
    this.store.users.set(userId, credits);
    const newTotal = credits.balance + credits.bonusCredits;

    // Create transaction
    const transaction = await this.createTransaction({
      userId,
      type: "purchase",
      amount,
      description,
      paymentRef,
      previousBalance: previousTotal,
      newBalance: newTotal,
    });

    // Journal entry (parity with the Drizzle adapter): a single journal can then
    // serve as the app's credit ledger, including revenue-attribution metadata.
    const journalMetadata = {
      ...(paymentRef ? { paymentRef } : {}),
      ...(options?.metadata ?? {}),
    };
    await this.createJournalEntry({
      userId,
      entryType: "credit",
      amount,
      balanceAfter: newTotal,
      source: options?.source ?? "purchase",
      referenceId: transaction.id ?? paymentRef ?? "unknown",
      referenceType: options?.referenceType ?? "transaction",
      description,
      metadata: Object.keys(journalMetadata).length > 0 ? journalMetadata : undefined,
    });
  }

  async deductCreditsAtomic(
    userId: string,
    amount: number
  ): Promise<{ previousBalance: number; newBalance: number }> {
    if (amount <= 0) {
      throw new Error(`deductCreditsAtomic amount must be positive (got ${amount})`);
    }

    const credits = this.store.users.get(userId);
    if (!credits) {
      throw new Error(`User credits not found for userId: ${userId}`);
    }

    const available = credits.balance + credits.bonusCredits - credits.reserved;
    if (available < amount) {
      throw new Error(
        `Insufficient credits. Available: ${available}, requested: ${amount}`
      );
    }

    // Drain balance first, then bonusCredits — same policy as commit.
    const balanceDeduction = Math.min(credits.balance, amount);
    const bonusDeduction = amount - balanceDeduction;

    const previousBalance = credits.balance + credits.bonusCredits;
    credits.balance -= balanceDeduction;
    credits.bonusCredits -= bonusDeduction;
    credits.updatedAt = new Date().toISOString();
    this.store.users.set(userId, credits);

    return { previousBalance, newBalance: previousBalance - amount };
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

    if (!this.store.transactions.has(input.userId)) {
      this.store.transactions.set(input.userId, []);
    }
    this.store.transactions.get(input.userId)!.push(transaction);

    return transaction;
  }

  async getTransactions(
    userId: string,
    limit = 50,
    offset = 0
  ): Promise<PortableTransaction[]> {
    const userTransactions = this.store.transactions.get(userId) ?? [];
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

    this.store.usageLogs.push(log);
    return log;
  }

  async getUsageLogs(query: UsageLogQuery): Promise<PortableUsageLog[]> {
    let results = [...this.store.usageLogs];

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
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date().toISOString(),
    };

    if (!this.store.journalEntries.has(input.userId)) {
      this.store.journalEntries.set(input.userId, []);
    }
    this.store.journalEntries.get(input.userId)!.push(entry);

    return entry;
  }

  async getJournalEntries(query: JournalEntryQuery): Promise<PortableJournalEntry[]> {
    let results = this.store.journalEntries.get(query.userId) ?? [];

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

  /**
   * Expire every hold whose deadline has passed.
   *
   * Each candidate goes through the guarded {@link expireReservationV2}, which
   * re-checks the status and the deadline under the user's lock. The previous
   * implementation released the hold and then overwrote the status to
   * `expired`, so a commit landing in between got its credits handed back and
   * was then relabelled.
   */
  async findAndExpireReservations(
    _batchSize = 100,
    _maxIterations = 100
  ): Promise<{
    expiredCount: number;
    creditsReleased: number;
    errors: string[];
  }> {
    const asOf = new Date();
    let expiredCount = 0;
    let creditsReleased = 0;
    const errors: string[] = [];

    // Snapshot the candidates first: expiring mutates the maps being iterated.
    const candidates: Array<{ userId: string; reservationId: string }> = [];
    for (const [userId, userReservations] of this.store.reservations) {
      for (const [reservationId, reservation] of userReservations) {
        if (
          reservation.status === "reserved" &&
          toDate(reservation.expiresAt).getTime() < asOf.getTime()
        ) {
          candidates.push({ userId, reservationId });
        }
      }
    }

    for (const candidate of candidates) {
      try {
        const outcome = await this.expireReservationV2(
          candidate.userId,
          candidate.reservationId,
          { asOf }
        );
        if (outcome.outcome === "expired") {
          expiredCount++;
          creditsReleased += outcome.amount;
        }
      } catch (error) {
        errors.push(
          `Failed to expire reservation ${candidate.reservationId}: ${error}`
        );
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
    const credits = this.store.users.get(userId);
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

    this.store.users.set(userId, credits);

    return { wasReset: true, credits };
  }

  // ==================== Subscription Expiry ====================

  async checkAndHandleSubscriptionExpiry(
    userId: string,
    gracePeriodDays = 3
  ): Promise<SubscriptionExpiryResult> {
    const credits = this.store.users.get(userId);
    if (!credits) {
      throw new Error(`User ${userId} not found`);
    }

    // Free tier doesn't expire
    if (isFreeTier(credits.tier) || !credits.subscriptionExpiresAt) {
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

    // Grace period expired - downgrade to the default (free) tier
    const defaultTier = getDefaultTier();
    const defaultTierConfig = getConfigTierConfig(defaultTier);

    credits.tier = defaultTier;
    credits.monthlyLimit = defaultTierConfig.monthlyCredits;
    credits.balance = Math.min(credits.balance, defaultTierConfig.monthlyCredits);
    credits.subscriptionExpiresAt = null;
    credits.updatedAt = new Date().toISOString();

    this.store.users.set(userId, credits);

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
    this.store.clear();
  }

  /**
   * Install a yield point inside every V2 critical section (testing only).
   *
   * Unset, the critical sections run start-to-finish synchronously, so
   * concurrent callers never interleave and a concurrency test would pass even
   * with the locking removed. Setting this to a real yield (a macrotask or a
   * barrier) makes callers genuinely overlap, so the tests exercise the lock
   * instead of the event loop. Never call this in production code.
   */
  setSchedulingHook(hook: (() => Promise<void>) | undefined): void {
    this.store.schedulingHook = hook;
  }

  /**
   * Get all users (useful for testing/debugging)
   */
  getAllUsers(): PortableUserCredits[] {
    return Array.from(this.store.users.values());
  }

  /**
   * Get all reservations for a user (useful for testing)
   */
  getAllReservations(userId: string): PortableReservation[] {
    const userReservations = this.store.reservations.get(userId);
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
