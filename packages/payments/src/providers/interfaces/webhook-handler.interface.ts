/**
 * @nehorai/payments - Webhook Handler Interface
 *
 * Defines the contract for processing incoming webhooks from payment providers.
 * Handles idempotency, reconciliation, and event-to-action mapping.
 */

import type {
  PaymentProvider,
  TransactionStatus,
  WebhookProcessingResult,
  ReconciliationResult,
} from '../../types/index.js';

// ============================================================================
// Event Parsing Types
// ============================================================================

/**
 * Parsed webhook event with standardized fields
 */
export interface ParsedWebhookEvent {
  /** Provider that sent the webhook */
  provider: PaymentProvider;
  /** Provider's unique event ID */
  eventId: string;
  /** Standardized event type */
  eventType: string;
  /** Associated payment intent/transaction ID */
  providerTransactionId?: string;
  /** Amount in minor units (if applicable) */
  amountMinor?: number;
  /** Currency (if applicable) */
  currency?: string;
  /** New status (if status change event) */
  newStatus?: TransactionStatus;
  /** Error details (if failure event) */
  error?: {
    code: string;
    message: string;
  };
  /** Original timestamp from provider */
  timestamp: Date;
  /** Full raw payload */
  rawPayload: Record<string, unknown>;
}

/**
 * Result of parsing a webhook event
 */
export interface ParseWebhookResult {
  success: boolean;
  event?: ParsedWebhookEvent;
  error?: string;
}

// ============================================================================
// Event Handler Types
// ============================================================================

/**
 * Handler function for a specific event type
 */
export type EventHandler = (
  event: ParsedWebhookEvent
) => Promise<WebhookProcessingResult>;

/**
 * Map of event types to handler functions
 */
export type EventHandlerMap = Map<string, EventHandler>;

// ============================================================================
// Main Interface
// ============================================================================

/**
 * Webhook Handler Interface
 *
 * Provider-specific webhook handlers implement this interface.
 * Enables consistent webhook processing across all providers.
 */
export interface IWebhookHandler {
  /**
   * Provider this handler is for
   */
  readonly provider: PaymentProvider;

  /**
   * Event types this handler can process
   */
  readonly supportedEventTypes: readonly string[];

  // ==========================================================================
  // Event Processing
  // ==========================================================================

  parseEvent(rawPayload: Record<string, unknown>): ParseWebhookResult;

  processEvent(event: ParsedWebhookEvent): Promise<WebhookProcessingResult>;

  canHandle(eventType: string): boolean;

  // ==========================================================================
  // Reconciliation
  // ==========================================================================

  reconcile(
    transactionId: string,
    providerTransactionId: string
  ): Promise<ReconciliationResult>;

  // ==========================================================================
  // Event Type Mapping
  // ==========================================================================

  mapEventType(providerEventType: string): string;

  mapStatus(providerStatus: string): TransactionStatus | null;
}
