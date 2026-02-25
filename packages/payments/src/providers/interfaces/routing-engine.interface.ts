/**
 * @nehorai/payments - Routing Engine Interface
 *
 * Defines the contract for intelligent payment routing.
 * Routes transactions to optimal providers based on:
 * - Card BIN rules (configurable per deployment)
 * - Provider health and availability
 * - Transaction fees
 * - Currency support
 */

import type { PaymentProvider, PaymentAmount } from '../../types/index.js';

// ============================================================================
// Routing Context
// ============================================================================

/**
 * Context for making routing decisions
 */
export interface RoutingContext {
  /** User making the payment */
  userId: string;
  /** Payment amount and currency */
  amount: PaymentAmount;
  /** Card BIN (first 6-8 digits) for card type detection */
  cardBin?: string;
  /** User's country (ISO 2-letter code) */
  userCountry?: string;
  /** User's preferred provider (if any) */
  preferredProvider?: PaymentProvider;
  /** Whether this is a recurring payment */
  isRecurring: boolean;
  /** Saved payment method ID (if using saved method) */
  savedPaymentMethodId?: string;
  /** Provider of saved payment method */
  savedPaymentMethodProvider?: PaymentProvider;
}

// ============================================================================
// Routing Decision
// ============================================================================

/**
 * Result of routing decision
 */
export interface RoutingDecision {
  /** Selected provider */
  provider: PaymentProvider;
  /** Reason for selection */
  reason: string;
  /** Fallback providers in order of priority */
  fallbackProviders: PaymentProvider[];
  /** Estimated transaction fee percentage */
  estimatedFeePercent: number;
  /** Additional routing metadata */
  metadata?: {
    matchedBinRule?: boolean;
    cardIssuer?: string;
    cardCountry?: string;
    primaryProviderUnavailable?: boolean;
  };
}

// ============================================================================
// Main Interface
// ============================================================================

/**
 * Routing Engine Interface
 *
 * Implementations of this interface handle intelligent routing
 * of payments to optimal providers.
 */
export interface IRoutingEngine {
  /**
   * Determine optimal provider for a transaction
   */
  route(context: RoutingContext): Promise<RoutingDecision>;

  /**
   * Get next provider after a failure
   */
  getFailoverProvider(
    failedProvider: PaymentProvider,
    context: RoutingContext
  ): Promise<PaymentProvider | null>;

  /**
   * Check if a card BIN matches a configured rule
   */
  matchCardBin(bin: string): boolean;

  /**
   * Get all available (healthy) providers
   */
  getAvailableProviders(): Promise<PaymentProvider[]>;

  /**
   * Get provider recommendation without full context
   */
  getQuickRecommendation(
    currency: string,
    isRecurring: boolean
  ): Promise<PaymentProvider | null>;
}
