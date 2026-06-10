/**
 * @nehorai/payments - Core Payment Types
 *
 * Defines the fundamental types for the payment system.
 * Follows TypeScript conventions with literal union types.
 */

// ============================================================================
// Enums as Union Types
// ============================================================================

/**
 * Supported payment providers - extensible string identifier
 */
export type PaymentProvider = string;

/**
 * Types of payment transactions
 */
export type TransactionType =
  | 'one_time_purchase'
  | 'subscription_initial'
  | 'subscription_renewal'
  | 'refund';

/**
 * Tax invoice status
 */
export type TaxInvoiceStatus = 'pending' | 'generated' | 'sent' | 'failed';

/**
 * Payment method types
 */
export type PaymentMethodType = 'card' | 'bank_account' | 'paypal';

/**
 * Card brands supported
 */
export type CardBrand =
  | 'visa'
  | 'mastercard'
  | 'amex'
  | 'discover'
  | 'isracard'
  | 'diners'
  | 'unknown';

// ============================================================================
// Core Value Objects
// ============================================================================

/**
 * Monetary amount in smallest currency unit (cents, agorot, etc.)
 * Zero Trust: All amounts validated server-side, never trust client
 */
export interface PaymentAmount {
  /** Amount in smallest currency unit (e.g., 1000 = $10.00) */
  amountMinor: number;
  /** ISO 4217 currency code (e.g., 'USD', 'ILS') */
  currency: string;
}

/**
 * Result of currency conversion
 */
export interface CurrencyConversion {
  originalAmount: PaymentAmount;
  convertedAmount: PaymentAmount;
  exchangeRate: number;
  convertedAt: Date;
}

// ============================================================================
// Payment Intent Types
// ============================================================================

/**
 * Parameters for creating a payment intent
 */
export interface CreatePaymentIntentParams {
  amount: PaymentAmount;
  userId: string;
  idempotencyKey: string;
  description?: string;
  metadata?: PaymentMetadata;
  returnUrl?: string;
  paymentMethodId?: string;
  /** If true, only authorize (J5 hold), don't capture */
  captureMethod?: 'automatic' | 'manual';
}

/**
 * Result from creating a payment intent
 */
export interface PaymentIntentResult {
  success: boolean;
  /** Provider's payment intent ID */
  providerIntentId?: string;
  /** Client secret for frontend SDK (Stripe Elements) */
  clientSecret?: string;
  /** Redirect URL for redirect-based flows */
  redirectUrl?: string;
  /** Current status of the payment */
  status?: string;
  error?: string;
  errorCode?: string;
}

// ============================================================================
// Authorization Types (J5 / Two-Phase Commit)
// ============================================================================

/**
 * Parameters for authorizing a payment (J5 hold)
 */
export interface AuthorizePaymentParams {
  providerIntentId: string;
  idempotencyKey: string;
}

/**
 * Result from authorization
 */
export interface AuthorizationResult {
  success: boolean;
  /** Authorization code for capture */
  authorizationCode?: string;
  status?: string;
  /** Deadline to capture before auth expires (typically 7 days) */
  captureDeadline?: Date;
  error?: string;
  errorCode?: string;
}

// ============================================================================
// Capture Types
// ============================================================================

/**
 * Parameters for capturing an authorized payment
 */
export interface CapturePaymentParams {
  providerIntentId: string;
  authorizationCode: string;
  /** For partial capture */
  amount?: PaymentAmount;
  idempotencyKey: string;
}

/**
 * Result from capture
 */
export interface CaptureResult {
  success: boolean;
  providerTransactionId?: string;
  status?: string;
  capturedAmount?: PaymentAmount;
  error?: string;
  errorCode?: string;
}

// ============================================================================
// Void Types
// ============================================================================

/**
 * Parameters for voiding an authorization
 */
export interface VoidPaymentParams {
  providerIntentId: string;
  authorizationCode: string;
  idempotencyKey: string;
  reason?: string;
}

/**
 * Result from void
 */
export interface VoidResult {
  success: boolean;
  status?: string;
  error?: string;
}

// ============================================================================
// Refund Types
// ============================================================================

/**
 * Parameters for refunding a payment
 */
export interface RefundParams {
  providerTransactionId: string;
  /** For partial refund */
  amount?: PaymentAmount;
  reason?: string;
  idempotencyKey: string;
}

/**
 * Result from refund
 */
export interface RefundResult {
  success: boolean;
  providerRefundId?: string;
  refundedAmount?: PaymentAmount;
  status?: 'pending' | 'succeeded' | 'failed';
  error?: string;
}

// ============================================================================
// Metadata Types
// ============================================================================

/**
 * Application-specific metadata attached to payments
 */
export interface PaymentMetadata {
  /** Credit package being purchased */
  creditPackageId?: string;
  /** Subscription plan being purchased */
  subscriptionPlanId?: string;
  /** Number of credits being purchased */
  creditsAmount?: number;
  /** Custom fields */
  [key: string]: unknown;
}

/**
 * Provider-specific metadata (raw response data)
 */
export interface ProviderMetadata {
  /** Raw response from provider for debugging */
  rawResponse?: Record<string, unknown>;
  /** Provider-specific transaction ID */
  providerTransactionId?: string;
  /** Provider-specific authorization code */
  authorizationCode?: string;
  /** Additional provider data */
  [key: string]: unknown;
}

// ============================================================================
// Health & Status Types
// ============================================================================

/**
 * Provider health status for circuit breaker
 */
export interface ProviderHealthStatus {
  provider: PaymentProvider;
  healthy: boolean;
  lastChecked: Date;
  /** Average response time in milliseconds */
  avgLatencyMs?: number;
  /** Error rate (0-1) */
  errorRate?: number;
  /** Whether circuit breaker is open */
  circuitBreakerOpen: boolean;
  /** When circuit breaker will attempt to close */
  nextRetryAt?: Date;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Standardized payment error codes
 */
export type PaymentErrorCode =
  | 'insufficient_funds'
  | 'invalid_card'
  | 'expired_card'
  | 'card_declined'
  | 'processing_error'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'rate_limit'
  | 'webhook_signature_invalid'
  | 'idempotency_conflict'
  | 'invalid_amount'
  | 'invalid_currency'
  | 'authentication_required'
  | 'unknown';

/**
 * Payment error with structured information
 */
export interface PaymentError {
  code: PaymentErrorCode;
  message: string;
  provider?: PaymentProvider;
  retryable: boolean;
  details?: Record<string, unknown>;
}

// ============================================================================
// Subscription Types (optional capability - see ISubscriptionProvider)
// ============================================================================

/**
 * Lifecycle status of a recurring subscription / standing order.
 * The provider is the source of truth for billing; the application maps
 * this status onto its own subscription/credit logic.
 */
export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'paused';

/**
 * Billing interval for a subscription.
 * SUMIT standing orders are billed monthly; kept as a union for future intervals.
 */
export type SubscriptionInterval = 'monthly';

/**
 * Parameters for creating a recurring subscription / standing order
 */
export interface CreateSubscriptionParams {
  /** Amount charged on every billing cycle */
  amount: PaymentAmount;
  userId: string;
  idempotencyKey: string;
  /** Billing interval (default: monthly) */
  interval?: SubscriptionInterval;
  /**
   * Number of charges before the standing order ends.
   * Omit for an open-ended subscription (charged until canceled).
   */
  recurrenceCount?: number;
  /**
   * Provider payment-method token representing a vaulted/single-use card.
   * Required by providers (e.g. SUMIT) whose recurring API is server-to-server
   * and cannot collect card details itself.
   */
  paymentMethodToken?: string;
  description?: string;
  metadata?: PaymentMetadata;
  /** Return URL for hosted-page subscription setup (redirect flows) */
  returnUrl?: string;
}

/**
 * Result of creating a subscription
 */
export interface SubscriptionResult {
  success: boolean;
  /** Provider's subscription / standing-order identifier */
  providerSubscriptionId?: string;
  /** Redirect URL when setup uses a hosted payment page */
  redirectUrl?: string;
  status?: SubscriptionStatus;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  error?: string;
  errorCode?: string;
}

/**
 * Parameters for canceling a subscription
 */
export interface CancelSubscriptionParams {
  providerSubscriptionId: string;
  idempotencyKey: string;
  /** Cancel at the end of the current period instead of immediately */
  atPeriodEnd?: boolean;
  reason?: string;
}

/**
 * Result of canceling a subscription
 */
export interface CancelSubscriptionResult {
  success: boolean;
  status?: SubscriptionStatus;
  canceledAt?: Date;
  error?: string;
}
