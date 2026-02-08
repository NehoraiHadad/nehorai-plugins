import type {
  PortableUserCredits,
  PortableReservation,
  PortableTransaction,
  PortableUsageLog,
  PortableJournalEntry,
  CreditOperationType,
  SubscriptionTier,
  ReservationStatus,
  AIProviderType,
  MonthlyResetResult,
  SubscriptionExpiryResult,
  CreditSource,
  JournalReferenceType,
} from "../core/types.js";

/**
 * Input for creating a credit reservation
 */
export interface CreateReservationInput {
  userId: string;
  amount: number;
  operationType: CreditOperationType;
  expiresAt: Date;
}

/**
 * Input for creating a credit transaction
 */
export interface CreateTransactionInput {
  userId: string;
  type: PortableTransaction["type"];
  amount: number;
  description: string;
  paymentRef?: string;
  previousBalance: number;
  newBalance: number;
}

/**
 * Input for logging usage
 */
export interface CreateUsageLogInput {
  userId: string;
  operationType: CreditOperationType;
  provider: AIProviderType;
  creditsUsed: number;
  success: boolean;
  errorMessage?: string;
  resourceId?: string;
  resourceType?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Query options for usage logs
 */
export interface UsageLogQuery {
  userId?: string;
  operationType?: CreditOperationType;
  success?: boolean;
  limit?: number;
  offset?: number;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Input for creating a journal entry
 */
export interface CreateJournalEntryInput {
  userId: string;
  entryType: "debit" | "credit";
  amount: number;
  balanceAfter: number;
  source: CreditSource;
  referenceId: string;
  referenceType: JournalReferenceType;
  description: string;
  metadata?: Record<string, unknown>;
}

/**
 * Query options for journal entries
 */
export interface JournalEntryQuery {
  userId: string;
  source?: CreditSource;
  referenceType?: JournalReferenceType;
  limit?: number;
  offset?: number;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Partial update for user credits balance
 */
export interface CreditBalanceUpdate {
  balance?: number;
  bonusCredits?: number;
  reserved?: number;
  tier?: SubscriptionTier;
  monthlyLimit?: number;
  monthlyUsed?: number;
  monthlyResetAt?: Date | string;
  subscriptionExpiresAt?: Date | string | null;
  /** Increment balance by this amount (alternative to absolute value) */
  balanceIncrement?: number;
  /** Increment bonusCredits by this amount (alternative to absolute value) */
  bonusCreditsIncrement?: number;
  /** Increment reserved by this amount (alternative to absolute value) */
  reservedIncrement?: number;
  /** Increment monthlyUsed by this amount */
  monthlyUsedIncrement?: number;
}

/**
 * Input for tier update
 */
export interface TierUpdateInput {
  tier: SubscriptionTier;
  monthlyLimit: number;
  balance?: number;
  monthlyUsed?: number;
  subscriptionExpiresAt?: Date | string | null;
}

/**
 * Repository interface for credits database operations
 *
 * Implementations can use any database (Firestore, PostgreSQL, etc.)
 * All methods should handle their own error handling and transactions
 */
export interface ICreditRepository {
  // ==================== User Credits ====================

  /**
   * Get user credits balance
   * @param userId - User ID
   * @returns User credits or null if not found
   */
  getUserCredits(userId: string): Promise<PortableUserCredits | null>;

  /**
   * Initialize credits for a new user
   * @param userId - User ID
   * @param tier - Initial subscription tier
   * @param initialBalance - Initial credit balance
   * @returns Initialized user credits
   */
  initializeUserCredits(
    userId: string,
    tier: SubscriptionTier,
    initialBalance: number
  ): Promise<PortableUserCredits>;

  /**
   * Update user credits balance
   * @param userId - User ID
   * @param updates - Partial updates to apply
   */
  updateUserCredits(userId: string, updates: CreditBalanceUpdate): Promise<void>;

  /**
   * Update user subscription tier
   * @param userId - User ID
   * @param input - Tier update data
   */
  updateUserTier(userId: string, input: TierUpdateInput): Promise<void>;

  // ==================== Reservations ====================

  /**
   * Create a credit reservation (phase 1 of two-phase commit)
   * @param input - Reservation data
   * @returns Created reservation
   */
  createReservation(input: CreateReservationInput): Promise<PortableReservation>;

  /**
   * Get a reservation by ID
   * @param userId - User ID
   * @param reservationId - Reservation ID
   * @returns Reservation or null
   */
  getReservation(userId: string, reservationId: string): Promise<PortableReservation | null>;

  /**
   * Update reservation status
   * @param userId - User ID
   * @param reservationId - Reservation ID
   * @param status - New status
   * @param completedAt - Completion timestamp
   */
  updateReservationStatus(
    userId: string,
    reservationId: string,
    status: ReservationStatus,
    completedAt?: Date
  ): Promise<void>;

  // ==================== Atomic Operations ====================

  /**
   * Reserve credits atomically (creates reservation + updates balance in transaction)
   * @param userId - User ID
   * @param amount - Credits to reserve
   * @param operationType - Operation type for tracking
   * @param expiresAt - Reservation expiry time
   * @returns Created reservation
   * @throws Error if insufficient credits
   */
  reserveCreditsAtomic(
    userId: string,
    amount: number,
    operationType: CreditOperationType,
    expiresAt: Date
  ): Promise<PortableReservation>;

  /**
   * Commit a reservation atomically (deducts credits + marks reservation committed)
   * @param userId - User ID
   * @param reservationId - Reservation ID
   * @throws Error if reservation not found or not in reserved state
   */
  commitReservationAtomic(userId: string, reservationId: string): Promise<void>;

  /**
   * Release a reservation atomically (releases reserved credits + marks reservation released)
   * @param userId - User ID
   * @param reservationId - Reservation ID
   */
  releaseReservationAtomic(userId: string, reservationId: string): Promise<void>;

  /**
   * Add credits atomically (creates transaction + updates balance)
   * @param userId - User ID
   * @param amount - Credits to add
   * @param description - Transaction description
   * @param paymentRef - Optional payment reference
   */
  addCreditsAtomic(
    userId: string,
    amount: number,
    description: string,
    paymentRef?: string
  ): Promise<void>;

  // ==================== Transactions ====================

  /**
   * Create a credit transaction record
   * @param input - Transaction data
   * @returns Created transaction
   */
  createTransaction(input: CreateTransactionInput): Promise<PortableTransaction>;

  /**
   * Get user's transaction history
   * @param userId - User ID
   * @param limit - Max results
   * @param offset - Skip results
   * @returns List of transactions
   */
  getTransactions(
    userId: string,
    limit?: number,
    offset?: number
  ): Promise<PortableTransaction[]>;

  // ==================== Usage Logs ====================

  /**
   * Log a usage event
   * @param input - Usage log data
   * @returns Created usage log
   */
  logUsage(input: CreateUsageLogInput): Promise<PortableUsageLog>;

  /**
   * Query usage logs
   * @param query - Query parameters
   * @returns List of usage logs
   */
  getUsageLogs(query: UsageLogQuery): Promise<PortableUsageLog[]>;

  /**
   * Get usage log count (for pagination)
   * @param query - Query parameters (without limit/offset)
   * @returns Count of matching logs
   */
  getUsageLogsCount(query: Omit<UsageLogQuery, "limit" | "offset">): Promise<number>;

  // ==================== Cleanup Operations ====================

  /**
   * Find and expire reservations past their expiration time
   * Used by cron job to clean up stale reservations
   * @param batchSize - Maximum number of reservations to process per batch (default: 100)
   * @param maxIterations - Maximum number of pagination iterations to prevent infinite loops (default: 100)
   * @returns Cleanup results with counts and errors
   */
  findAndExpireReservations(batchSize?: number, maxIterations?: number): Promise<{
    expiredCount: number;
    creditsReleased: number;
    errors: string[];
  }>;

  // ==================== Atomic Monthly Reset ====================

  /**
   * Atomically perform monthly reset if needed
   * Uses optimistic locking to prevent race conditions
   *
   * @param userId - User ID
   * @param tier - User's current subscription tier (for determining new balance)
   * @param expectedResetAt - The expected monthlyResetAt value (for optimistic locking)
   * @returns Result indicating whether reset was performed and updated credits
   */
  atomicMonthlyReset(
    userId: string,
    tier: SubscriptionTier,
    expectedResetAt: Date | string
  ): Promise<MonthlyResetResult>;

  // ==================== Subscription Expiry ====================

  /**
   * Check and handle subscription expiry with grace period
   * Auto-downgrades expired subscriptions after grace period
   *
   * @param userId - User ID
   * @param gracePeriodDays - Days to allow after expiry before downgrade (default: 3)
   * @returns Result indicating whether downgrade occurred
   */
  checkAndHandleSubscriptionExpiry(
    userId: string,
    gracePeriodDays?: number
  ): Promise<SubscriptionExpiryResult>;

  // ==================== Journal Entries ====================

  /**
   * Create a journal entry for audit trail
   * @param input - Journal entry data
   * @returns Created journal entry
   */
  createJournalEntry(input: CreateJournalEntryInput): Promise<PortableJournalEntry>;

  /**
   * Get journal entries for a user
   * @param query - Query parameters
   * @returns List of journal entries
   */
  getJournalEntries(query: JournalEntryQuery): Promise<PortableJournalEntry[]>;

  /**
   * Get journal entry count for pagination
   * @param query - Query parameters (without limit/offset)
   * @returns Count of matching entries
   */
  getJournalEntriesCount(query: Omit<JournalEntryQuery, "limit" | "offset">): Promise<number>;
}

/**
 * Factory type for creating repository instances
 */
export type CreditRepositoryFactory = () => ICreditRepository;

/**
 * Convert PortableUserCredits to client-safe format
 * Utility function that implementations can use
 */
export function toClientUserCredits(credits: PortableUserCredits): PortableUserCredits {
  // Already in portable format, just ensure all timestamps are ISO strings
  return {
    userId: credits.userId,
    balance: credits.balance,
    bonusCredits: credits.bonusCredits ?? 0,
    reserved: credits.reserved,
    tier: credits.tier,
    monthlyLimit: credits.monthlyLimit,
    monthlyUsed: credits.monthlyUsed,
    monthlyResetAt: toISOString(credits.monthlyResetAt),
    subscriptionExpiresAt: credits.subscriptionExpiresAt
      ? toISOString(credits.subscriptionExpiresAt)
      : null,
    createdAt: toISOString(credits.createdAt),
    updatedAt: toISOString(credits.updatedAt),
  };
}

/**
 * Convert any timestamp-like value to ISO string
 */
function toISOString(value: unknown): string {
  if (!value) return new Date().toISOString();
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  // Handle Firestore Timestamp-like objects
  if (typeof value === "object" && "toDate" in value && typeof (value as { toDate: () => Date }).toDate === "function") {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return new Date().toISOString();
}
