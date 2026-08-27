import type {
  ICreditRepositoryCreditsV2,
  ICreditRepositoryV2,
} from "./v2-types.js";
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
  /**
   * @deprecated Rejected — this writer does not place the hold.
   *
   * `createReservation` inserts a row and leaves `reserved` alone, so a keyed
   * row written here names a hold that does not exist, and `reserveCreditsV2`
   * would adopt it as a `replayed` reservation whose commit then spends another
   * hold's coverage. Both adapters throw `UNSUPPORTED_OPERATION` when this is
   * set. Pass the key to `reserveCredits` / `reserveCreditsV2` instead, which
   * claims the key and places the hold in one transaction.
   *
   * The field is kept rather than deleted so the refusal reaches a JavaScript
   * caller as a typed error instead of a silently ignored property.
   */
  idempotencyKey?: string;
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
  /** Deterministic key making this entry unique per user (V2, optional). */
  idempotencyKey?: string;
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
 * Optional journal customization for `addCreditsAtomic`.
 *
 * By default a credit add records a journal entry with `source: "purchase"`,
 * `referenceType: "transaction"`, and `{ paymentRef }` metadata. These options
 * let callers override that — e.g. tag a signup grant as `source: "bonus"`, or
 * carry revenue-attribution fields (gross amount, credits granted) so a single
 * journal can serve as the app's revenue ledger.
 */
export interface AddCreditsAtomicOptions {
  /** Journal entry source (defaults to `"purchase"`). */
  source?: CreditSource;
  /** Journal reference type (defaults to `"transaction"`). */
  referenceType?: JournalReferenceType;
  /**
   * Extra metadata merged onto the journal entry. When `paymentRef` is present
   * it is merged in too (explicit keys here win on collision).
   */
  metadata?: Record<string, unknown>;
}

/**
 * Repository interface for credits database operations
 *
 * Implementations can use any database (Firestore, PostgreSQL, etc.)
 * All methods should handle their own error handling and transactions
 */
export interface ICreditRepository
  extends Partial<ICreditRepositoryV2>,
    Partial<ICreditRepositoryCreditsV2> {
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
   * Create a reservation *record* — not a hold.
   *
   * Writes a row and leaves `reserved` untouched, so the row is not backed by
   * credits and no settlement path will move money for it: the commit /
   * release / expire transitions (legacy and V2 alike) refuse it with
   * `UNBACKED_RESERVATION`, and it refuses an `idempotencyKey` so it can never
   * be adopted as a V2 replay. Use it for imported or annotation-only records.
   *
   * To place a hold that can actually be committed, call `reserveCreditsAtomic`
   * or `reserveCreditsV2` — they raise `reserved` and write the row in one
   * atomic step.
   *
   * @param input - Reservation data
   * @returns Created reservation record
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
   * Annotate a reservation *record* with a status.
   *
   * Assigns a status and nothing else — no balance movement, no `reserved`
   * adjustment, no journal entry. It therefore refuses two writes that would
   * make the status lie about the ledger: any write to a row whose hold was
   * atomically placed (those statuses belong to commit/release/expire), and
   * any write back to `reserved` (nothing here re-places a hold). Rows written
   * by `createReservation` accept terminal statuses freely.
   *
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
   * @param options - Optional journal source / reference type / extra metadata
   *   for the credit journal entry (e.g. revenue attribution fields). Lets
   *   callers record a purchase's gross amount, a bonus/refund source, etc.,
   *   instead of the default `source: "purchase"` + `{ paymentRef }` metadata.
   */
  addCreditsAtomic(
    userId: string,
    amount: number,
    description: string,
    paymentRef?: string,
    options?: AddCreditsAtomicOptions
  ): Promise<void>;

  /**
   * Deduct credits from a user's balance atomically.
   *
   * Splits the deduction across `balance` and `bonusCredits`, draining
   * `balance` (monthly, resets each cycle) first so persistent bonus
   * credits survive longer. Runs in a single atomic transaction so
   * concurrent deducts cannot drive either field negative.
   *
   * Callers are responsible for writing any audit record (journal /
   * transaction) — this method only moves credits.
   *
   * @param userId - User ID
   * @param amount - Credits to deduct (positive)
   * @returns Combined totals (balance + bonusCredits) before and after.
   * @throws If user has no credits doc or insufficient credits
   */
  deductCreditsAtomic(
    userId: string,
    amount: number
  ): Promise<{ previousBalance: number; newBalance: number }>;

  // ==================== Transactions ====================

  /**
   * Create a credit transaction *record* — no balance moves.
   *
   * Refuses a `paymentRef`: the reference is the global identity of a credit
   * event, and a record that carried one without crediting anyone would make a
   * later `addCredits` with the same reference report `replayed` and credit
   * nothing. Deliver referenced payments through `addCreditsAtomic` /
   * `addCreditsV2`, which claim the reference and move the balance atomically.
   *
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
 * Narrow a repository to one that implements the full V2 boundary.
 *
 * V2 methods are optional on {@link ICreditRepository}, so callers that need
 * the idempotent/race-safe path must probe rather than assume. A repository
 * only counts as V2 when it implements *all four* transitions — a partial
 * implementation would leave one path silently unsafe.
 */
export function supportsCreditsV2(
  repository: ICreditRepository
): repository is ICreditRepository & ICreditRepositoryV2 {
  return (
    typeof repository.reserveCreditsV2 === "function" &&
    typeof repository.commitReservationV2 === "function" &&
    typeof repository.releaseReservationV2 === "function" &&
    typeof repository.expireReservationV2 === "function"
  );
}

/**
 * Narrow a repository to one that credits idempotently against a `paymentRef`.
 *
 * Deliberately a separate probe from {@link supportsCreditsV2}: serialising
 * reservations and enforcing a global payment reference are different
 * guarantees resting on different database objects, and an adapter may have one
 * without the other.
 */
export function supportsIdempotentCredit(
  repository: ICreditRepository
): repository is ICreditRepository & ICreditRepositoryCreditsV2 {
  return typeof repository.addCreditsV2 === "function";
}

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
