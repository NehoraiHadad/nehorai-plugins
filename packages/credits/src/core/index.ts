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

export type { AddCreditsOutcome } from "./outcomes.js";

export {
  isWinningOutcome,
  isReservedOutcome,
  isCreditedOutcome,
} from "./outcomes.js";

// ==================== Persisted-row integrity ====================
export type { ReservationIntegrityView } from "./reservation-integrity.js";

export {
  RESERVATION_STATUSES,
  TERMINAL_RESERVATION_STATUSES,
  isReservationStatus,
  isTerminalReservationStatus,
  assertKnownReservationStatus,
  terminalStatusOf,
  assertHoldPlaced,
  assertUnkeyedDirectReservation,
  assertDirectStatusWriteAllowed,
  hasPlacedHold,
} from "./reservation-integrity.js";

// ==================== Payment references ====================
export type { PaymentEventPayload, StoredPaymentEvent } from "./payment-ref.js";

export {
  normalizePaymentRef,
  describePaymentMismatch,
  createPaymentRefConflictError,
  assertUnreferencedDirectTransaction,
} from "./payment-ref.js";

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
  sumAmounts,
  isValidCreditAmount,
  assertValidCreditAmount,
  numericToCents,
  sameAmount,
  isRepresentableAmount,
  assertRepresentableAmount,
  assertRepresentableFields,
  assertRepresentableTierAmount,
  assertValidStoredAmount,
  assertValidStoredAmountRaw,
  storedMonthlyLimit,
  backedBalanceFloor,
} from "./amount.js";

export {
  isValidIdempotencyKey,
  assertValidIdempotencyKey,
  assertPublicJournalKey,
  isReservedJournalKey,
  RESERVED_JOURNAL_KEY_PREFIX,
} from "./idempotency.js";

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
