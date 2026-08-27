/**
 * Credits system core - framework agnostic
 *
 * This module provides the core credits functionality without any
 * framework-specific dependencies (no Next.js, no React, no Firebase types).
 *
 * Use this module when:
 * - Building non-Next.js applications
 * - Creating the TypeScript SDK
 * - Copy-pasting the credits system to other projects
 *
 * @example
 * ```typescript
 * import {
 *   calculateAvailableCredits,
 *   CreditError,
 *   CreditErrorCode,
 *   genericDeferred,
 * } from '@nehorai/credits/core';
 * ```
 */

// ==================== Types ====================
export type {
  BuiltinTier,
  SubscriptionTier,
  CreditOperationType,
  AIProviderType,
  ResourceType,
  ReservationStatus,
  TransactionType,
  CreditSource,
  JournalReferenceType,
  PortableUserCredits,
  PortableReservation,
  PortableTransaction,
  PortableJournalEntry,
  PortableUsageLog,
  CreditCheckResult,
  DeductCreditsResult,
  MonthlyResetResult,
  SubscriptionExpiryResult,
  UsageHistoryEntry,
  UsageHistoryResponse,
  TierConfig,
  WithCreditsOptions,
} from "./types.js";

// ==================== Type Utilities ====================
export {
  calculateAvailableCredits,
  toPortableTimestamp,
  toDate,
} from "./types.js";

// ==================== Outcomes (V2) ====================
export type {
  TerminalReservationStatus,
  ReserveOutcome,
  CommitOutcome,
  ReleaseOutcome,
  ExpireOutcome,
} from "./outcomes.js";

export { isWinningOutcome, isReservedOutcome } from "./outcomes.js";

// ==================== Errors ====================
export type { CreditErrorCodeType } from "./errors.js";

export {
  CreditError,
  CreditErrorCode,
  isCreditError,
  isInsufficientCreditsError,
  createInsufficientCreditsError,
  createReservationNotFoundError,
  createReservationExpiredError,
  createReservationAlreadyProcessedError,
  createUserNotFoundError,
  createInvalidOperationTypeError,
  createIdempotencyConflictError,
  createTransientError,
  createUnsupportedOperationError,
  createInvalidAmountError,
  isIdempotencyConflictError,
  isTransientError,
} from "./errors.js";

// ==================== Amount Validation ====================
export {
  CREDIT_AMOUNT_MAX,
  CREDIT_AMOUNT_SCALE,
  toCents,
  isValidCreditAmount,
  assertValidCreditAmount,
  numericToCents,
  sameAmount,
} from "./amount.js";

export {
  classifyDatabaseError,
  isTransientDatabaseError,
  isUniqueViolation,
  getSqlState,
} from "./error-classify.js";

// ==================== Deferred Execution ====================
export type { DeferredExecutor } from "./deferred.js";

export {
  genericDeferred,
  synchronousDeferred,
  noopDeferred,
  createDeferredExecutor,
} from "./deferred.js";

// ==================== Operations ====================
export {
  commitReservationWithJournal,
  releaseReservationWithJournal,
  reserveCreditsForOperation,
} from "./operations.js";
