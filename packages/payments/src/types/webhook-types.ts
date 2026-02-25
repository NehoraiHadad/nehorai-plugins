/**
 * @nehorai/payments - Webhook Types
 *
 * Types for processing incoming webhooks from payment providers.
 * Includes signature verification and idempotent event handling.
 */

import type { PaymentProvider } from './payment-types.js';
import type { TransactionStatus } from './state-machine.js';

// ============================================================================
// Webhook Event Types
// ============================================================================

/**
 * Status of webhook processing
 */
export type WebhookStatus =
  | 'pending'
  | 'processing'
  | 'processed'
  | 'failed'
  | 'ignored';

/**
 * Incoming webhook event from any provider
 */
export interface WebhookEvent {
  /** Source payment provider */
  provider: PaymentProvider;
  /** Provider's unique event ID (for idempotency) */
  eventId: string;
  /** Type of event (e.g., 'payment_intent.succeeded') */
  eventType: string;
  /** When the event occurred */
  timestamp: Date;
  /** Raw event payload */
  payload: Record<string, unknown>;
  /** Signature from provider for verification */
  signature: string;
}

/**
 * Result of processing a webhook event
 */
export interface WebhookProcessingResult {
  success: boolean;
  /** Associated transaction ID if applicable */
  transactionId?: string;
  /** What action was taken */
  action?: WebhookAction;
  /** Error message if failed */
  error?: string;
  /** Whether this was a duplicate event */
  wasDuplicate?: boolean;
}

/**
 * Actions taken when processing webhooks
 */
export type WebhookAction =
  | 'transaction_created'
  | 'status_updated'
  | 'refund_processed'
  | 'dispute_created'
  | 'skipped_duplicate'
  | 'ignored_event_type'
  | 'no_action_needed';

// ============================================================================
// Provider-Specific Event Types
// ============================================================================

/**
 * Stripe webhook event types we handle
 */
export type StripeEventType =
  | 'payment_intent.created'
  | 'payment_intent.processing'
  | 'payment_intent.succeeded'
  | 'payment_intent.payment_failed'
  | 'payment_intent.canceled'
  | 'payment_intent.amount_capturable_updated'
  | 'charge.succeeded'
  | 'charge.failed'
  | 'charge.refunded'
  | 'charge.dispute.created'
  | 'charge.dispute.closed'
  | 'customer.subscription.created'
  | 'customer.subscription.updated'
  | 'customer.subscription.deleted'
  | 'invoice.paid'
  | 'invoice.payment_failed';

/**
 * Map of Stripe events to transaction status updates
 */
export const STRIPE_EVENT_TO_STATUS: Partial<Record<StripeEventType, TransactionStatus>> = {
  'payment_intent.succeeded': 'captured',
  'payment_intent.payment_failed': 'failed',
  'payment_intent.canceled': 'voided',
  'payment_intent.amount_capturable_updated': 'authorized',
  'charge.refunded': 'partially_refunded', // or fully_refunded based on amount
};

// ============================================================================
// Webhook Signature Verification
// ============================================================================

/**
 * Parameters for verifying webhook signature
 */
export interface WebhookVerificationParams {
  payload: string;
  signature: string;
  secret: string;
  /** Tolerance in seconds for timestamp validation */
  tolerance?: number;
}

/**
 * Result of webhook signature verification
 */
export interface WebhookVerificationResult {
  valid: boolean;
  error?: string;
}

// ============================================================================
// Webhook Queue Types (for SQS processing)
// ============================================================================

/**
 * Message format for webhook queue
 */
export interface WebhookQueueMessage {
  /** Message ID for deduplication */
  messageId: string;
  /** Provider that sent the webhook */
  provider: PaymentProvider;
  /** Provider's event ID */
  eventId: string;
  /** Event type */
  eventType: string;
  /** Raw payload (JSON string) */
  payload: string;
  /** Signature for verification */
  signature: string;
  /** When received by our API */
  receivedAt: string;
  /** Number of processing attempts */
  attemptCount: number;
}

/**
 * Result of queue message processing
 */
export interface QueueProcessingResult {
  success: boolean;
  messageId: string;
  action?: WebhookAction;
  shouldDelete: boolean;
  shouldRetry: boolean;
  error?: string;
}

// ============================================================================
// Reconciliation Types
// ============================================================================

/**
 * Result of reconciling payment state
 * Handles race condition between redirect and webhook
 */
export interface ReconciliationResult {
  reconciled: boolean;
  /** Final determined status */
  finalStatus: TransactionStatus;
  /** Source of truth (redirect callback vs webhook) */
  source: 'redirect' | 'webhook' | 'provider_query';
  /** Whether status was updated */
  statusChanged: boolean;
}

/**
 * Reconciliation strategy when redirect and webhook conflict
 */
export type ReconciliationStrategy =
  | 'prefer_webhook'      // Wait for webhook (more reliable)
  | 'prefer_redirect'     // Use redirect result immediately
  | 'query_provider';     // Query provider API directly
