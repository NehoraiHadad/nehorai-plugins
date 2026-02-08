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
  MonthlyResetResult,
  SubscriptionExpiryResult,
  UsageHistoryEntry,
  UsageHistoryResponse,
  TierConfig,
  WithCreditsOptions,
} from "./types";

// ==================== Type Utilities ====================
export {
  calculateAvailableCredits,
  toPortableTimestamp,
  toDate,
  CREDIT_CONSTANTS,
} from "./types";

// ==================== Errors ====================
export type { CreditErrorCodeType } from "./errors";

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
} from "./errors";

// ==================== Deferred Execution ====================
export type { DeferredExecutor } from "./deferred";

export {
  genericDeferred,
  synchronousDeferred,
  noopDeferred,
  createDeferredExecutor,
} from "./deferred";

// ==================== Operations ====================
export {
  commitReservationWithJournal,
  releaseReservationWithJournal,
  reserveCreditsForOperation,
} from "./operations";
