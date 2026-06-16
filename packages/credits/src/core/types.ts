/**
 * Portable credits types - framework and database agnostic
 *
 * These types use standard JavaScript types (string, Date) instead of
 * Firebase-specific types (Timestamp). This makes the credits system
 * portable to other environments without Firebase dependencies.
 *
 * Note: Firestore Timestamp is handled by the credits-firestore adapter.
 */

// ==================== Utility Functions ====================

/**
 * Calculate available credits from balance, bonus, and reserved amounts.
 *
 * Available = balance + bonusCredits - reserved
 *
 * @param balance - Regular monthly credits
 * @param bonusCredits - Purchased/admin credits
 * @param reserved - Credits locked for in-flight operations
 * @returns Available credits for new operations
 */
export function calculateAvailableCredits(
  balance: number,
  bonusCredits: number,
  reserved: number
): number {
  return balance + bonusCredits - reserved;
}

/**
 * Convert various timestamp formats to ISO string.
 *
 * Handles:
 * - Date objects
 * - ISO string (returned as-is)
 * - Timestamp-like objects with toDate() method (Firebase)
 * - undefined/null (returns current time)
 *
 * @param value - Value to convert
 * @returns ISO 8601 string
 */
export function toPortableTimestamp(value: unknown): string {
  if (!value) {
    return new Date().toISOString();
  }

  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof (value as { toDate: () => Date }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }

  return new Date().toISOString();
}

/**
 * Convert various timestamp formats to Date object.
 *
 * Handles:
 * - Date objects (returned as-is)
 * - ISO string
 * - Timestamp-like objects with toDate() method (Firebase)
 * - Invalid values (returns current date)
 *
 * @param value - Value to convert
 * @returns Date object
 */
export function toDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "string") {
    return new Date(value);
  }

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

// ==================== Subscription Types ====================

/**
 * Built-in tier ids (autocomplete) — apps may add more via config.
 */
export type BuiltinTier = "free" | "basic" | "premium" | "unlimited";

/**
 * Subscription tiers for the credits system.
 *
 * Any built-in OR any config-defined tier id. The `(string & {})` keeps builtin
 * autocomplete while accepting arbitrary configured tiers.
 */
export type SubscriptionTier = BuiltinTier | (string & {});

// ==================== Operation Types ====================

/**
 * Operation types for cost tracking (provider-agnostic)
 *
 * Dynamic string type - any operation configured in the system is valid.
 */
export type CreditOperationType = string;

/**
 * AI providers
 */
export type AIProviderType = "gemini";

/**
 * Resource type for usage logging
 */
export type ResourceType = string;

// ==================== User Credits ====================

/**
 * Portable user credits balance
 *
 * Uses ISO string timestamps instead of Firebase Timestamp.
 * This type is safe for JSON serialization and works across frameworks.
 */
export interface PortableUserCredits {
  userId: string;
  /** Current available balance (monthly credits, reset each month) */
  balance: number;
  /** Bonus credits from purchases/admin (never reset, persist until used) */
  bonusCredits: number;
  /** Credits currently reserved for in-flight operations */
  reserved: number;
  /** User's subscription tier */
  tier: SubscriptionTier;
  /** Monthly credit limit based on tier (0 = unlimited) */
  monthlyLimit: number;
  /** Credits used this month (resets monthly) */
  monthlyUsed: number;
  /** When monthly credits reset (start of next month) - ISO 8601 */
  monthlyResetAt: string;
  /** Subscription expiry (null/undefined for free tier) - ISO 8601 or null */
  subscriptionExpiresAt?: string | null;
  /** Creation timestamp - ISO 8601 */
  createdAt: string;
  /** Last update timestamp - ISO 8601 */
  updatedAt: string;
}

// ==================== Reservation Types ====================

/**
 * Credit reservation status for two-phase commit
 */
export type ReservationStatus = "reserved" | "committed" | "released" | "expired";

/**
 * Portable credit reservation
 *
 * Used for two-phase commit to prevent double-spending.
 */
export interface PortableReservation {
  id: string;
  userId: string;
  /** Amount of credits reserved */
  amount: number;
  /** Operation type for tracking */
  operationType: CreditOperationType;
  /** Current status of reservation */
  status: ReservationStatus;
  /** When reservation was created - ISO 8601 */
  createdAt: string;
  /** When reservation expires (for cleanup) - ISO 8601 */
  expiresAt: string;
  /** When reservation was committed/released - ISO 8601 or undefined */
  completedAt?: string;
}

// ==================== Result Types ====================

/**
 * Result of a credit check operation
 */
export interface CreditCheckResult {
  /** Whether user has sufficient credits */
  hasCredits: boolean;
  /** Current balance (balance + bonusCredits) */
  balance: number;
  /** Required credits for operation */
  required: number;
  /** Shortfall if insufficient */
  shortfall: number;
}

/**
 * Result of monthly reset operation
 */
export interface MonthlyResetResult {
  /** Whether the reset was performed */
  wasReset: boolean;
  /** The user credits after the operation */
  credits: PortableUserCredits;
}

/**
 * Result of subscription expiry check
 */
export interface SubscriptionExpiryResult {
  /** Whether the subscription was downgraded */
  wasDowngraded: boolean;
  /** Whether user is in grace period */
  inGracePeriod: boolean;
  /** Days remaining in grace period (0 if not in grace) */
  graceDaysRemaining: number;
  /** The user credits after the operation */
  credits: PortableUserCredits;
}

// ==================== Transaction Types ====================

/**
 * Credit transaction type
 */
export type TransactionType = "purchase" | "subscription" | "bonus" | "refund" | "adjustment";

/**
 * Portable credit transaction
 */
export interface PortableTransaction {
  id: string;
  userId: string;
  type: TransactionType;
  /** Amount of credits (positive for additions, negative for deductions) */
  amount: number;
  description: string;
  /** Reference to payment provider */
  paymentRef?: string;
  previousBalance: number;
  newBalance: number;
  createdAt: string;
}

// ==================== Journal Types ====================

/**
 * Source of a credit journal entry
 */
export type CreditSource =
  | "operation_commit"
  | "operation_release"
  | "purchase"
  | "subscription_grant"
  | "subscription_upgrade"
  | "subscription_downgrade"
  | "monthly_reset"
  | "bonus"
  | "refund"
  | "admin_adjustment"
  | "expiry"
  | "reservation_expired";

/**
 * Type of reference for a journal entry
 */
export type JournalReferenceType =
  | "reservation"
  | "transaction"
  | "adjustment"
  | "reset"
  | "subscription";

/**
 * Portable credit journal entry for audit trail
 */
export interface PortableJournalEntry {
  id: string;
  userId: string;
  /** Type of entry - debit decreases balance, credit increases balance */
  entryType: "debit" | "credit";
  /** Amount of credits involved */
  amount: number;
  /** Balance after this entry */
  balanceAfter: number;
  /** Source of the credit change */
  source: CreditSource;
  /** Reference ID (e.g., reservationId, transactionId) */
  referenceId: string;
  /** Type of reference */
  referenceType: JournalReferenceType;
  /** Human-readable description */
  description: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** When this entry was created - ISO 8601 */
  createdAt: string;
}

// ==================== Usage Types ====================

/**
 * Portable usage log entry
 */
export interface PortableUsageLog {
  id: string;
  userId: string;
  operationType: CreditOperationType;
  provider: AIProviderType;
  creditsUsed: number;
  success: boolean;
  errorMessage?: string;
  resourceId?: string;
  resourceType?: ResourceType;
  requestId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/**
 * User-friendly usage history entry
 */
export interface UsageHistoryEntry {
  id: string;
  /** Type of entry for display */
  type: "usage" | "purchase" | "bonus" | "reset" | "refund" | "adjustment";
  /** Positive = earned, Negative = spent */
  creditsChange: number;
  /** Balance after this entry */
  balanceAfter: number;
  /** Human-readable description */
  description: string;
  /** When this occurred - ISO 8601 */
  createdAt: string;
}

/**
 * Paginated usage history response
 */
export interface UsageHistoryResponse {
  entries: UsageHistoryEntry[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

// ==================== Tier Configuration ====================

/**
 * Tier configuration for credit limits and pricing
 */
export interface TierConfig {
  tier: SubscriptionTier;
  monthlyCredits: number;
  priceUsd: number;
  features: string[];
  /** Free/default tier marker — no subscription expiry, balance untouched on tier change. Defaults to priceUsd === 0. */
  isFree?: boolean;
  /** Unlimited tier marker. Defaults to monthlyCredits === 0. */
  unlimited?: boolean;
  /** Tier assigned to brand-new users. Defaults to the tier flagged isFree. */
  isDefault?: boolean;
}

// ==================== Options Types ====================

/**
 * Options for withCredits HOF
 */
export interface WithCreditsOptions {
  /** Operation type for cost lookup */
  operationType: CreditOperationType;
  /** AI provider (defaults to "gemini") */
  provider?: AIProviderType;
  /** Custom cost override (use with caution) */
  customCost?: number;
  /** Resource ID for usage logging */
  resourceId?: string;
  /** Resource type for usage logging */
  resourceType?: ResourceType;
}

// ==================== Constants ====================
