/**
 * @nehorai/credits - Framework-agnostic credits system
 *
 * Provides a complete credits/billing system with:
 * - Two-phase commit for safe credit deduction
 * - Journal-based audit trail
 * - Subscription tier management
 * - Notification hooks
 * - REST API SDK
 *
 * @example
 * ```typescript
 * import {
 *   CreditsService,
 *   createInMemoryCreditRepository,
 *   CreditError,
 * } from '@nehorai/credits';
 *
 * const repository = createInMemoryCreditRepository();
 * const service = new CreditsService(repository);
 *
 * // Check credits
 * const check = await service.checkCredits(userId, 10);
 * if (!check.hasCredits) {
 *   throw new Error(`Need ${check.shortfall} more credits`);
 * }
 *
 * // Reserve and execute
 * const reservation = await service.reserveCredits(userId, 10, 'story_generation');
 * try {
 *   await doWork();
 *   await service.commitCredits(userId, reservation.id);
 * } catch (error) {
 *   await service.releaseCredits(userId, reservation.id);
 *   throw error;
 * }
 * ```
 */

// ==================== Core ====================
export * from "./core/index.js";

// ==================== Config ====================
export {
  getConfig,
  initializeConfig,
  loadConfigFromEnv,
  getValidOperationTypes,
  isValidOperationType,
  getConfigOperationCost,
  getConfigTierConfig,
  getConfigMonthlyLimit,
  isFeatureEnabled,
  resetConfig,
  type CreditSystemConfig,
} from "./config/index.js";

export {
  getOperationCosts,
  getOperationCost,
  getTierConfig,
  getMonthlyLimit,
  getDefaultFreeCredits,
  getReservationExpiryMs,
  TIER_CONFIGS,
  DEFAULT_FREE_CREDITS,
  RESERVATION_EXPIRY_MS,
} from "./config/costs.js";

// ==================== Repository ====================
// Export types and classes (excluding toDate which is already exported from core)
export type {
  ICreditRepository,
  CreditRepositoryFactory,
  CreateReservationInput,
  CreateTransactionInput,
  CreateUsageLogInput,
  CreateJournalEntryInput,
  UsageLogQuery,
  JournalEntryQuery,
  CreditBalanceUpdate,
  TierUpdateInput,
} from "./repository/types.js";
export { toClientUserCredits } from "./repository/types.js";
export { generateId, getNextMonthlyReset } from "./repository/utils.js";
export {
  InMemoryCreditRepository,
  createInMemoryCreditRepository,
} from "./repository/memory/index.js";

// ==================== Auth ====================
export * from "./auth/index.js";

// ==================== Service ====================
export * from "./service/index.js";

// ==================== Adapters ====================
export * from "./adapters/index.js";

// ==================== Notifications ====================
export {
  registerNotificationHandler,
  clearNotificationHandlers,
  clearCooldownState,
  checkAndNotifyLowBalance,
  notifySubscriptionExpiring,
  notifySubscriptionExpired,
  ConsoleNotificationHandler,
  type CreditNotificationEvent,
  type ICreditNotificationHandler,
} from "./notifications/index.js";

// ==================== SDK ====================
// Export SDK (excluding types that conflict with core)
export { CreditsClient } from "./sdk/client.js";
export { AdminCreditsClient } from "./sdk/admin-client.js";
export type {
  CreditsClientConfig,
  AdminCreditsClientConfig,
  UserCredits,
  CreditReservation,
  CreditCheckResult as SDKCreditCheckResult,
  ReservationResult,
  PaginationOptions,
  UsageHistoryEntry as SDKUsageHistoryEntry,
  UsageHistoryResponse as SDKUsageHistoryResponse,
  ApiResponse,
  SDKErrorCodeType,
  SubscriptionTier as SDKSubscriptionTier,
} from "./sdk/types.js";
export type {
  CreditsConfig,
  ListUsersResponse,
  ListUsersOptions,
} from "./sdk/admin-client.js";
export { SDKErrorCode } from "./sdk/types.js";
export {
  CreditsSDKError,
  NetworkError,
  AuthenticationError,
  AuthorizationError,
  InsufficientCreditsError as SDKInsufficientCreditsError,
  ReservationNotFoundError as SDKReservationNotFoundError,
  ReservationExpiredError as SDKReservationExpiredError,
  ValidationError,
  ServerError,
  parseApiError,
} from "./sdk/errors.js";

// ==================== Utils ====================
export {
  getTotalCredits,
  generateRequestId,
  parseCreditError,
  isCreditErrorMessage,
  isPreviewMode,
  createDummyReservation,
  type CreditErrorInfo,
} from "./utils/index.js";
