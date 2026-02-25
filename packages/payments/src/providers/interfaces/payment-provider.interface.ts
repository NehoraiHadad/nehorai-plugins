/**
 * @nehorai/payments - Payment Provider Interface
 *
 * Defines the contract that all payment provider adapters must implement.
 * Supports Two-Phase Commit (J5) pattern: Authorize -> Capture/Void
 */

import type {
  PaymentProvider,
  CreatePaymentIntentParams,
  PaymentIntentResult,
  AuthorizePaymentParams,
  AuthorizationResult,
  CapturePaymentParams,
  CaptureResult,
  VoidPaymentParams,
  VoidResult,
  RefundParams,
  RefundResult,
  ProviderHealthStatus,
} from '../../types/index.js';

// ============================================================================
// Payment Method Types
// ============================================================================

/**
 * Parameters for saving a payment method
 */
export interface SavePaymentMethodParams {
  userId: string;
  /** Provider-specific setup data (e.g., SetupIntent confirmation) */
  setupData: Record<string, unknown>;
}

/**
 * Result of saving a payment method
 */
export interface SavePaymentMethodResult {
  success: boolean;
  paymentMethodId?: string;
  cardBrand?: string;
  cardLast4?: string;
  cardExpMonth?: string;
  cardExpYear?: string;
  cardBin?: string;
  error?: string;
}

/**
 * Result of deleting a payment method
 */
export interface DeletePaymentMethodResult {
  success: boolean;
  error?: string;
}

// ============================================================================
// Setup Intent Types (for tokenization)
// ============================================================================

/**
 * Parameters for creating a setup intent
 */
export interface CreateSetupIntentParams {
  userId: string;
  /** Customer ID in provider system */
  customerId?: string;
}

/**
 * Result of creating a setup intent
 */
export interface SetupIntentResult {
  success: boolean;
  setupIntentId?: string;
  clientSecret?: string;
  error?: string;
}

// ============================================================================
// Customer Types
// ============================================================================

/**
 * Parameters for creating a customer
 */
export interface CreateCustomerParams {
  userId: string;
  email: string;
  name?: string;
  metadata?: Record<string, string>;
}

/**
 * Result of creating a customer
 */
export interface CreateCustomerResult {
  success: boolean;
  customerId?: string;
  error?: string;
}

// ============================================================================
// Main Interface
// ============================================================================

/**
 * Payment Provider Interface
 *
 * All payment provider adapters must implement this interface.
 * Enables the adapter pattern for multi-provider support.
 */
export interface IPaymentProvider {
  /**
   * Provider identifier
   */
  readonly name: PaymentProvider;

  /**
   * Supported currencies (ISO 4217 codes)
   */
  readonly supportedCurrencies: readonly string[];

  /**
   * Whether provider supports recurring billing
   */
  readonly supportsRecurring: boolean;

  /**
   * Whether provider supports split payments (marketplace)
   */
  readonly supportsSplitPayments: boolean;

  // ==========================================================================
  // Two-Phase Commit Flow (J5)
  // ==========================================================================

  createPaymentIntent(
    params: CreatePaymentIntentParams
  ): Promise<PaymentIntentResult>;

  authorize(params: AuthorizePaymentParams): Promise<AuthorizationResult>;

  capture(params: CapturePaymentParams): Promise<CaptureResult>;

  void(params: VoidPaymentParams): Promise<VoidResult>;

  // ==========================================================================
  // Refunds
  // ==========================================================================

  refund(params: RefundParams): Promise<RefundResult>;

  // ==========================================================================
  // Payment Methods (Tokenization)
  // ==========================================================================

  createSetupIntent(params: CreateSetupIntentParams): Promise<SetupIntentResult>;

  savePaymentMethod(
    params: SavePaymentMethodParams
  ): Promise<SavePaymentMethodResult>;

  deletePaymentMethod(
    paymentMethodId: string
  ): Promise<DeletePaymentMethodResult>;

  // ==========================================================================
  // Customer Management
  // ==========================================================================

  createCustomer(params: CreateCustomerParams): Promise<CreateCustomerResult>;

  getOrCreateCustomer(
    userId: string,
    email: string
  ): Promise<CreateCustomerResult>;

  // ==========================================================================
  // Health & Security
  // ==========================================================================

  getHealth(): Promise<ProviderHealthStatus>;

  validateWebhookSignature(payload: string, signature: string): boolean;

  // ==========================================================================
  // Query Methods
  // ==========================================================================

  getPaymentIntentStatus(
    providerIntentId: string
  ): Promise<{ status: string; error?: string }>;
}
