import type {
  PortableUserCredits,
  PortableReservation,
  CreditCheckResult,
  CreditOperationType,
  SubscriptionTier,
  PortableUsageLog,
  PortableJournalEntry,
  UsageHistoryEntry,
  UsageHistoryResponse,
  DeductCreditsResult,
} from "../core/types.js";
import { toDate } from "../core/types.js";
import type {
  ICreditRepository,
  CreateUsageLogInput,
  JournalEntryQuery,
  AddCreditsAtomicOptions,
} from "../repository/types.js";
import { toClientUserCredits } from "../repository/types.js";
import {
  getConfig,
  getConfigMonthlyLimit,
  getOperationLabel,
  isFreeTier,
  isUnlimitedTier,
  getDefaultTier,
  getUnlimitedSentinelBalance,
} from "../config/index.js";

/**
 * Check if a date is past the monthly reset date
 */
function isPastMonthlyReset(resetAt: unknown): boolean {
  if (!resetAt) return false;
  const resetDate = toDate(resetAt);
  return new Date() >= resetDate;
}

/**
 * Notification callback type for low balance notifications
 */
export type LowBalanceNotificationCallback = (userId: string, balance: number) => Promise<void>;

/**
 * Notification callback type for subscription expired notifications
 */
export type SubscriptionExpiredNotificationCallback = (userId: string, wasDowngraded: boolean) => Promise<void>;

/**
 * Options for reserving credits.
 */
export interface ReserveCreditsOptions {
  /**
   * Time-to-live for the reservation, in milliseconds, before the cleanup
   * sweep may expire it. Defaults to `config.reservationExpiryMs` (suitable
   * for synchronous, in-request operations). Long-running async jobs
   * (e.g. background media generation) should pass a TTL matching their
   * own lifecycle so the reservation is not expired while the job is still
   * legitimately in flight.
   */
  ttlMs?: number;
}

/**
 * Options for a one-shot atomic credit deduction via `deductCredits`.
 */
export interface DeductCreditsOptions {
  /**
   * Operation type for cost tracking / journal + usage-log labeling.
   * Falls back to a generic "adjustment" description when omitted.
   */
  operationType?: CreditOperationType;
  /** Resource ID to attach to the usage log (e.g. the generated asset's id) */
  resourceId?: string;
  /** Resource type to attach to the usage log */
  resourceType?: string;
  /** Request ID to attach to the usage log, for tracing */
  requestId?: string;
  /** Additional metadata recorded on the journal entry */
  metadata?: Record<string, unknown>;
}

/**
 * Credits service with dependency injection for repository
 *
 * Provides business logic for credit operations, delegating
 * database operations to the injected repository.
 */
export class CreditsService {
  private lowBalanceCallback?: LowBalanceNotificationCallback;
  private subscriptionExpiredCallback?: SubscriptionExpiredNotificationCallback;

  constructor(private readonly repository: ICreditRepository) {}

  /**
   * Set callback for low balance notifications
   */
  setLowBalanceCallback(callback: LowBalanceNotificationCallback): void {
    this.lowBalanceCallback = callback;
  }

  /**
   * Set callback for subscription expired notifications
   */
  setSubscriptionExpiredCallback(callback: SubscriptionExpiredNotificationCallback): void {
    this.subscriptionExpiredCallback = callback;
  }

  /**
   * Get user credits, performing monthly reset and subscription expiry checks if needed
   *
   * This method uses atomic operations to prevent race conditions:
   * 1. Checks subscription expiry with grace period
   * 2. Atomically performs monthly reset if needed (with optimistic locking)
   *
   * @param userId - User ID
   * @returns User credits or null if not found
   */
  async getUserCredits(userId: string): Promise<PortableUserCredits | null> {
    let data = await this.repository.getUserCredits(userId);

    if (!data) {
      return null;
    }

    // Step 1: Check subscription expiry (for non-free tiers)
    if (!isFreeTier(data.tier) && data.subscriptionExpiresAt) {
      const expiryResult = await this.repository.checkAndHandleSubscriptionExpiry(
        userId,
        getConfig().subscriptionGracePeriodDays
      );

      if (expiryResult.wasDowngraded) {
        // Create journal entry for downgrade
        await this.repository.createJournalEntry({
          userId,
          entryType: "debit",
          amount: 0, // No credits deducted, just tier change
          balanceAfter: expiryResult.credits.balance,
          source: "subscription_downgrade",
          referenceId: `downgrade-${Date.now()}`,
          referenceType: "subscription",
          description: `Subscription expired. Downgraded from ${data.tier} to free tier.`,
          metadata: {
            previousTier: data.tier,
            previousBalance: data.balance,
            newBalance: expiryResult.credits.balance,
          },
        });

        // Trigger subscription expired notification (non-blocking)
        if (this.subscriptionExpiredCallback) {
          this.subscriptionExpiredCallback(userId, true).catch((error) => {
            console.error("[Credits] Failed to send subscription expired notification:", error);
          });
        }
      }

      // Use the potentially updated credits
      data = expiryResult.credits;
    }

    // Step 2: Check if monthly reset is needed (use atomic operation)
    if (isPastMonthlyReset(data.monthlyResetAt)) {
      // Convert monthlyResetAt to a compatible type (Date or string)
      const expectedResetAt = toDate(data.monthlyResetAt);
      const resetResult = await this.repository.atomicMonthlyReset(
        userId,
        data.tier,
        expectedResetAt
      );

      if (resetResult.wasReset) {
        // Create journal entry for monthly reset
        const balanceChange = resetResult.credits.balance - data.balance;
        if (balanceChange !== 0) {
          await this.repository.createJournalEntry({
            userId,
            entryType: balanceChange > 0 ? "credit" : "debit",
            amount: Math.abs(balanceChange),
            balanceAfter: resetResult.credits.balance,
            source: "monthly_reset",
            referenceId: `reset-${Date.now()}`,
            referenceType: "reset",
            description: `Monthly credit reset for ${data.tier} tier.`,
            metadata: {
              tier: data.tier,
              previousBalance: data.balance,
              newBalance: resetResult.credits.balance,
            },
          });
        }
      }

      // Use the potentially updated credits
      data = resetResult.credits;
    }

    return toClientUserCredits(data);
  }

  /**
   * Initialize credits for a new user with free tier
   * @param userId - User ID
   * @returns Initialized user credits
   */
  async initializeUserCredits(userId: string): Promise<PortableUserCredits> {
    const credits = await this.repository.initializeUserCredits(
      userId,
      getDefaultTier(),
      getConfig().defaultFreeCredits
    );
    return toClientUserCredits(credits);
  }

  /**
   * Get or create user credits
   * Initializes with free tier if not exists
   * @param userId - User ID
   * @returns User credits
   */
  async getOrCreateUserCredits(userId: string): Promise<PortableUserCredits> {
    const existing = await this.getUserCredits(userId);
    if (existing) {
      return existing;
    }
    return this.initializeUserCredits(userId);
  }

  /**
   * Check if user has sufficient credits for an operation
   * @param userId - User ID
   * @param requiredCredits - Credits required
   * @returns Credit check result
   */
  async checkCredits(userId: string, requiredCredits: number): Promise<CreditCheckResult> {
    const credits = await this.getOrCreateUserCredits(userId);

    // Available = balance + bonusCredits - reserved
    const totalBalance = credits.balance + credits.bonusCredits;
    const available = totalBalance - credits.reserved;
    const hasCredits = available >= requiredCredits;

    return {
      hasCredits,
      balance: totalBalance,
      required: requiredCredits,
      shortfall: hasCredits ? 0 : requiredCredits - available,
    };
  }

  /**
   * Reserve credits for an operation (phase 1 of two-phase commit)
   * Creates a reservation and locks the credits
   * @param userId - User ID
   * @param amount - Credits to reserve
   * @param operationType - Operation type for tracking
   * @param options - Optional settings (e.g. a custom `ttlMs` for long-running async jobs)
   * @returns Reservation object
   * @throws Error if insufficient credits
   */
  async reserveCredits(
    userId: string,
    amount: number,
    operationType: CreditOperationType,
    options?: ReserveCreditsOptions
  ): Promise<PortableReservation> {
    const ttlMs = options?.ttlMs ?? getConfig().reservationExpiryMs;
    const expiresAt = new Date(Date.now() + ttlMs);
    return this.repository.reserveCreditsAtomic(userId, amount, operationType, expiresAt);
  }

  /**
   * Commit a reservation (phase 2 of two-phase commit - success)
   * Deducts credits and marks reservation as committed
   * Also triggers low balance notifications if balance drops below threshold
   */
  async commitCredits(userId: string, reservationId: string): Promise<void> {
    // Get the reservation to know the amount
    const reservation = await this.repository.getReservation(userId, reservationId);
    if (!reservation) {
      throw new Error(`Reservation ${reservationId} not found`);
    }

    // Idempotent: a re-delivered commit for an already-committed reservation
    // is a no-op. The balance + journal were applied by the first commit; the
    // atomic layer also guards the balance, this just avoids a duplicate
    // journal entry on the happy retry path.
    if (reservation.status === "committed") {
      return;
    }

    // Commit the reservation atomically
    await this.repository.commitReservationAtomic(userId, reservationId);

    // Create journal entry
    const credits = await this.repository.getUserCredits(userId);
    if (credits) {
      await this.repository.createJournalEntry({
        userId,
        entryType: "debit",
        amount: reservation.amount,
        balanceAfter: credits.balance,
        source: "operation_commit",
        referenceId: reservationId,
        referenceType: "reservation",
        description: `Committed ${reservation.amount} credits for ${getOperationLabel(reservation.operationType)}`,
        metadata: {
          operationType: reservation.operationType,
        },
      });

      // Trigger low balance notification (non-blocking)
      if (this.lowBalanceCallback) {
        this.lowBalanceCallback(userId, credits.balance).catch((error) => {
          console.error("[Credits] Failed to send low balance notification:", error);
        });
      }
    }
  }

  /**
   * Release a reservation (phase 2 of two-phase commit - failure)
   * Returns reserved credits and marks reservation as released
   */
  async releaseCredits(userId: string, reservationId: string): Promise<void> {
    // Get the reservation to check its state
    const reservation = await this.repository.getReservation(userId, reservationId);

    // Release the reservation atomically
    await this.repository.releaseReservationAtomic(userId, reservationId);

    // Create journal entry only if reservation was in reserved state
    if (reservation?.status === "reserved") {
      const credits = await this.repository.getUserCredits(userId);
      if (credits) {
        await this.repository.createJournalEntry({
          userId,
          entryType: "credit",
          amount: 0, // No actual credits returned (they were reserved, not spent)
          balanceAfter: credits.balance,
          source: "operation_release",
          referenceId: reservationId,
          referenceType: "reservation",
          description: `Released ${reservation.amount} reserved credits for ${getOperationLabel(reservation.operationType)}`,
          metadata: {
            operationType: reservation.operationType,
            amount: reservation.amount,
          },
        });
      }
    }
  }

  /**
   * Log usage for audit trail
   * @param log - Usage log data
   */
  async logUsage(log: Omit<PortableUsageLog, "id" | "createdAt">): Promise<void> {
    await this.repository.logUsage(log as CreateUsageLogInput);
  }

  /**
   * Add credits to user account (for purchases, bonuses, etc.)
   * @param userId - User ID
   * @param amount - Credits to add
   * @param description - Transaction description
   * @param paymentRef - Optional payment reference
   * @param options - Optional journal source / reference type / extra metadata
   *   for the credit journal entry (e.g. revenue-attribution fields).
   */
  async addCredits(
    userId: string,
    amount: number,
    description: string,
    paymentRef?: string,
    options?: AddCreditsAtomicOptions
  ): Promise<void> {
    return this.repository.addCreditsAtomic(userId, amount, description, paymentRef, options);
  }

  /**
   * One-shot atomic "deduct-if-sufficient" credit charge.
   *
   * Unlike the reserve/commit/release two-phase flow, this performs a single
   * atomic check-and-deduct against the repository — suited for synchronous,
   * in-request operations that don't need a hold across an async job. Exactly
   * one call is made to `repository.deductCreditsAtomic`, which enforces
   * atomicity so concurrent callers can never both succeed against the same
   * limited balance.
   *
   * On success, creates a journal entry (same audit trail as `commitCredits`)
   * and, if `options.operationType` is provided, a usage log entry via the
   * same `logUsage` path.
   *
   * @param userId - User ID
   * @param amount - Credits to deduct (must be > 0)
   * @param options - Optional usage-log / journal metadata
   * @returns Typed result: `{ success: true, newBalance }` or
   *   `{ success: false, reason: 'insufficient', available, required, shortfall }`
   * @throws Error if amount is not a positive number
   */
  async deductCredits(
    userId: string,
    amount: number,
    options?: DeductCreditsOptions
  ): Promise<DeductCreditsResult> {
    if (!(amount > 0)) {
      throw new Error(`deductCredits amount must be positive (got ${amount})`);
    }

    let deduction: { previousBalance: number; newBalance: number };
    try {
      deduction = await this.repository.deductCreditsAtomic(userId, amount);
    } catch (error) {
      // The repository layer throws on insufficient funds (and on missing
      // user docs, which we surface as unavailable rather than a shortfall).
      const credits = await this.repository.getUserCredits(userId);
      const available = credits
        ? credits.balance + credits.bonusCredits - credits.reserved
        : 0;

      if (available >= amount) {
        // Not an insufficient-credits condition (e.g. missing user record) —
        // this is unexpected, so let the original error propagate.
        throw error;
      }

      return {
        success: false,
        reason: "insufficient",
        available,
        required: amount,
        shortfall: amount - available,
      };
    }

    const operationType = options?.operationType;
    await this.repository.createJournalEntry({
      userId,
      entryType: "debit",
      amount,
      balanceAfter: deduction.newBalance,
      source: "operation_commit",
      referenceId: options?.requestId ?? `deduct-${Date.now()}`,
      referenceType: "adjustment",
      description: operationType
        ? `Deducted ${amount} credits for ${getOperationLabel(operationType)}`
        : `Deducted ${amount} credits`,
      metadata: {
        ...(operationType && { operationType }),
        ...options?.metadata,
      },
    });

    if (operationType) {
      await this.logUsage({
        userId,
        operationType,
        provider: "gemini",
        creditsUsed: amount,
        success: true,
        resourceId: options?.resourceId,
        resourceType: options?.resourceType,
        requestId: options?.requestId,
        metadata: options?.metadata,
      });
    }

    // Trigger low balance notification (non-blocking) — same hook commitCredits uses.
    if (this.lowBalanceCallback) {
      this.lowBalanceCallback(userId, deduction.newBalance).catch((error) => {
        console.error("[Credits] Failed to send low balance notification:", error);
      });
    }

    return { success: true, newBalance: deduction.newBalance };
  }

  /**
   * Update user subscription tier
   * @param userId - User ID
   * @param tier - New subscription tier
   * @param expiresAt - Subscription expiry date (optional)
   */
  async updateTier(
    userId: string,
    tier: SubscriptionTier,
    expiresAt?: Date
  ): Promise<void> {
    const monthlyLimit = getConfigMonthlyLimit(tier);
    const unlimited = isUnlimitedTier(tier);
    const free = isFreeTier(tier);

    await this.repository.updateUserTier(userId, {
      tier,
      // Stored monthlyLimit uses the 0-means-unlimited convention.
      monthlyLimit: unlimited ? 0 : monthlyLimit,
      // Reset balance to new tier limit if upgrading
      balance: !free
        ? (unlimited ? getUnlimitedSentinelBalance() : monthlyLimit)
        : undefined,
      monthlyUsed: !free ? 0 : undefined,
      subscriptionExpiresAt: expiresAt ? expiresAt.toISOString() : null,
    });
  }

  /**
   * Get usage logs with optional filtering
   * @param userId - Optional user ID filter
   * @param limit - Max results
   * @param offset - Skip results
   * @returns List of usage logs
   */
  async getUsageLogs(
    userId?: string,
    limit = 50,
    offset = 0
  ): Promise<PortableUsageLog[]> {
    return this.repository.getUsageLogs({ userId, limit, offset });
  }

  /**
   * Get user-friendly usage history
   * Combines journal entries into a user-facing format
   *
   * @param userId - User ID
   * @param limit - Max results per page
   * @param offset - Skip results for pagination
   * @returns Paginated usage history response
   */
  async getUsageHistory(
    userId: string,
    limit = 20,
    offset = 0
  ): Promise<UsageHistoryResponse> {
    // Get journal entries
    const [entries, total] = await Promise.all([
      this.repository.getJournalEntries({ userId, limit, offset }),
      this.repository.getJournalEntriesCount({ userId }),
    ]);

    // Convert journal entries to user-friendly format
    const historyEntries: UsageHistoryEntry[] = entries.map((entry) => {
      const type = this.mapSourceToHistoryType(entry.source);
      const creditsChange = entry.entryType === "credit" ? entry.amount : -entry.amount;

      return {
        id: entry.id,
        type,
        creditsChange,
        balanceAfter: entry.balanceAfter,
        description: entry.description,
        createdAt: typeof entry.createdAt === "string"
          ? entry.createdAt
          : toDate(entry.createdAt).toISOString(),
      };
    });

    return {
      entries: historyEntries,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + entries.length < total,
      },
    };
  }

  /**
   * Map journal entry source to user-friendly history type
   */
  private mapSourceToHistoryType(
    source: PortableJournalEntry["source"]
  ): UsageHistoryEntry["type"] {
    switch (source) {
      case "operation_commit":
      case "reservation_expired":
        return "usage";
      case "purchase":
        return "purchase";
      case "subscription_grant":
      case "subscription_upgrade":
      case "bonus":
        return "bonus";
      case "monthly_reset":
        return "reset";
      case "refund":
      case "operation_release":
        return "refund";
      case "admin_adjustment":
      case "subscription_downgrade":
      case "expiry":
      default:
        return "adjustment";
    }
  }

  /**
   * Get journal entries directly (for admin or debugging)
   * @param query - Journal entry query parameters
   * @returns List of journal entries
   */
  async getJournalEntries(query: JournalEntryQuery): Promise<PortableJournalEntry[]> {
    return this.repository.getJournalEntries(query);
  }

  /**
   * Get the underlying repository (for advanced use cases)
   */
  getRepository(): ICreditRepository {
    return this.repository;
  }
}

/**
 * Create a credits service with a repository
 */
export function createCreditsService(repository: ICreditRepository): CreditsService {
  return new CreditsService(repository);
}
