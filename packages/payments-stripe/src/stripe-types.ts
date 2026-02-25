/**
 * @nehorai/payments-stripe - Stripe-Specific Types
 *
 * Type definitions for Stripe API interactions.
 * Maps Stripe concepts to @nehorai/payments internal types.
 */

import type { TransactionStatus } from '@nehorai/payments/types';

// ============================================================================
// Stripe Configuration
// ============================================================================

/**
 * Stripe provider configuration
 */
export interface StripeConfig {
  secretKey: string;
  publishableKey?: string;
  webhookSecret?: string;
  apiVersion?: string;
}

/**
 * Default Stripe API version
 * @see https://docs.stripe.com/api/versioning
 */
export const DEFAULT_STRIPE_API_VERSION = '2025-12-15.clover';

// ============================================================================
// Stripe Status Mapping
// ============================================================================

export type StripePaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'canceled'
  | 'succeeded';

export const STRIPE_STATUS_MAP: Record<
  StripePaymentIntentStatus,
  TransactionStatus
> = {
  requires_payment_method: 'created',
  requires_confirmation: 'created',
  requires_action: 'pending_authorization',
  processing: 'pending_authorization',
  requires_capture: 'authorized',
  canceled: 'voided',
  succeeded: 'captured',
};

// ============================================================================
// Stripe Webhook Event Types
// ============================================================================

export const STRIPE_WEBHOOK_EVENTS = [
  'payment_intent.created',
  'payment_intent.processing',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'payment_intent.amount_capturable_updated',
  'charge.succeeded',
  'charge.failed',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'setup_intent.succeeded',
  'setup_intent.setup_failed',
] as const;

export type StripeWebhookEventType = (typeof STRIPE_WEBHOOK_EVENTS)[number];

export const STRIPE_EVENT_ACTIONS: Partial<
  Record<StripeWebhookEventType, TransactionStatus | 'no_change'>
> = {
  'payment_intent.succeeded': 'captured',
  'payment_intent.payment_failed': 'failed',
  'payment_intent.canceled': 'voided',
  'payment_intent.amount_capturable_updated': 'authorized',
  'charge.refunded': 'partially_refunded',
};

// ============================================================================
// Stripe Error Mapping
// ============================================================================

export type StripeDeclineCode =
  | 'insufficient_funds'
  | 'lost_card'
  | 'stolen_card'
  | 'expired_card'
  | 'incorrect_cvc'
  | 'processing_error'
  | 'incorrect_number'
  | 'card_declined'
  | 'authentication_required'
  | 'call_issuer'
  | 'do_not_honor'
  | 'generic_decline';

export const STRIPE_ERROR_MAP: Record<string, string> = {
  insufficient_funds: 'insufficient_funds',
  lost_card: 'card_declined',
  stolen_card: 'card_declined',
  expired_card: 'expired_card',
  incorrect_cvc: 'invalid_card',
  processing_error: 'processing_error',
  incorrect_number: 'invalid_card',
  card_declined: 'card_declined',
  authentication_required: 'authentication_required',
  call_issuer: 'card_declined',
  do_not_honor: 'card_declined',
  generic_decline: 'card_declined',
};

// ============================================================================
// Stripe Supported Currencies
// ============================================================================

export const STRIPE_SUPPORTED_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'ILS', 'CAD', 'AUD', 'JPY',
  'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF',
  'RON', 'BGN', 'HRK',
] as const;

// ============================================================================
// Helper Functions
// ============================================================================

export function mapStripeStatus(
  stripeStatus: string
): TransactionStatus | null {
  return (
    STRIPE_STATUS_MAP[stripeStatus as StripePaymentIntentStatus] ?? null
  );
}

export function mapStripeError(stripeCode: string): string {
  return STRIPE_ERROR_MAP[stripeCode] ?? 'unknown';
}

export function isStripeSupportedCurrency(currency: string): boolean {
  return STRIPE_SUPPORTED_CURRENCIES.includes(
    currency as (typeof STRIPE_SUPPORTED_CURRENCIES)[number]
  );
}
