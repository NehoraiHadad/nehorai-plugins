/**
 * SDK types for the credits system
 *
 * These types are used by the client SDKs for REST API consumption.
 */

// Re-export core types for SDK consumers
export type {
  PortableUserCredits as UserCredits,
  PortableReservation as CreditReservation,
  CreditCheckResult,
  SubscriptionTier,
} from "../core/types.js";

/**
 * Configuration for CreditsClient
 */
export interface CreditsClientConfig {
  /** Base URL of the credits API (e.g., "https://api.example.com") */
  baseUrl: string;
  /** Function to get the auth token for session-based auth */
  getAuthToken?: () => Promise<string>;
  /** Optional custom fetch function for testing */
  fetch?: typeof fetch;
}

/**
 * Configuration for AdminCreditsClient
 */
export interface AdminCreditsClientConfig {
  /** Base URL of the credits API */
  baseUrl: string;
  /** Admin API key */
  apiKey: string;
  /** Optional custom fetch function for testing */
  fetch?: typeof fetch;
}

/**
 * Result of a credit reservation
 */
export interface ReservationResult {
  /** The reservation ID */
  reservationId: string;
  /** Amount of credits reserved */
  amount: number;
  /** When the reservation expires (ISO 8601) */
  expiresAt: string;
}

/**
 * Pagination options for API requests
 */
export interface PaginationOptions {
  /** Page number (1-indexed) */
  page?: number;
  /** Number of items per page */
  limit?: number;
}

/**
 * Usage history entry
 */
export interface UsageHistoryEntry {
  /** Unique ID of the usage log */
  id: string;
  /** Type of operation */
  operationType: string;
  /** AI provider used */
  provider: string;
  /** Credits consumed */
  creditsUsed: number;
  /** Whether the operation was successful */
  success: boolean;
  /** Error message if unsuccessful */
  errorMessage?: string;
  /** ID of the related resource */
  resourceId?: string;
  /** Type of the related resource */
  resourceType?: string;
  /** When the operation occurred (ISO 8601) */
  createdAt: string;
}

/**
 * Response from usage history endpoint
 */
export interface UsageHistoryResponse {
  /** List of usage entries */
  entries: UsageHistoryEntry[];
  /** Whether there are more results */
  hasMore: boolean;
  /** Total count (if available) */
  total?: number;
}

/**
 * Generic API response wrapper
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * SDK error codes
 */
export const SDKErrorCode = {
  NETWORK_ERROR: "NETWORK_ERROR",
  AUTHENTICATION_ERROR: "AUTHENTICATION_ERROR",
  AUTHORIZATION_ERROR: "AUTHORIZATION_ERROR",
  INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",
  RESERVATION_NOT_FOUND: "RESERVATION_NOT_FOUND",
  RESERVATION_EXPIRED: "RESERVATION_EXPIRED",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  SERVER_ERROR: "SERVER_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const;

export type SDKErrorCodeType = (typeof SDKErrorCode)[keyof typeof SDKErrorCode];
