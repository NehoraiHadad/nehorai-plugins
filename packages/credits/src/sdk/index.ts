/**
 * Credits SDK - barrel exports
 *
 * Provides TypeScript SDK for consuming the credits REST API
 * from external services or other applications.
 */

// Clients
export { CreditsClient } from "./client.js";
export { AdminCreditsClient } from "./admin-client.js";

// Types
export type {
  CreditsClientConfig,
  AdminCreditsClientConfig,
  UserCredits,
  CreditReservation,
  CreditCheckResult,
  ReservationResult,
  PaginationOptions,
  UsageHistoryEntry,
  UsageHistoryResponse,
  ApiResponse,
  SDKErrorCodeType,
  SubscriptionTier,
} from "./types.js";

export { SDKErrorCode } from "./types.js";

// Errors
export {
  CreditsSDKError,
  NetworkError,
  AuthenticationError,
  AuthorizationError,
  InsufficientCreditsError,
  ReservationNotFoundError,
  ReservationExpiredError,
  ValidationError,
  ServerError,
  parseApiError,
} from "./errors.js";

// Admin client types
export type {
  CreditsConfig,
  ListUsersResponse,
  ListUsersOptions,
} from "./admin-client.js";
