/**
 * PayPal Webhook Handler
 *
 * Normalizes PayPal webhook events (PAYMENT.CAPTURE.*) into the unified event
 * set shared with the SUMIT adapter, so the application consumes both providers
 * through the identical seam. The handler stays thin: it parses/normalizes only.
 * Persisting orders and granting credits is the application's responsibility.
 *
 * Signature authenticity is NOT checked here — it is an async postback handled
 * by PaypalProvider.verifyWebhookSignature(), which the receiving route must
 * call BEFORE trusting the event.
 *
 * Idempotency: `eventId` is PayPal's own globally-unique event `id` (e.g.
 * "WH-..."), so a `(provider, provider_event_id)` unique constraint dedupes
 * redelivered events — credits are never granted twice.
 */

import type {
  PaymentProvider,
  TransactionStatus,
  WebhookProcessingResult,
  ReconciliationResult,
} from '@nehorai/payments/types';
import type {
  IWebhookHandler,
  ParsedWebhookEvent,
  ParseWebhookResult,
} from '@nehorai/payments/providers';
import {
  PAYPAL_NORMALIZED_EVENTS,
  PAYPAL_WEBHOOK_EVENT_MAP,
  mapEventToTransactionStatus,
  decimalStringToMinor,
  type PaypalWebhookPayload,
  type PaypalNormalizedEvent,
} from './paypal-types.js';
import type { PaypalProvider } from './paypal-provider.js';

export class PaypalWebhookHandler implements IWebhookHandler {
  readonly provider: PaymentProvider = 'paypal';
  readonly supportedEventTypes = PAYPAL_NORMALIZED_EVENTS;

  /**
   * @param providerForReconcile Optional PaypalProvider used by `reconcile` to
   *   verify state against the PayPal API. The factory wires this automatically.
   */
  constructor(private readonly providerForReconcile?: PaypalProvider) {}

  parseEvent(rawPayload: Record<string, unknown>): ParseWebhookResult {
    try {
      const payload = rawPayload as PaypalWebhookPayload;
      const rawEventType = payload.event_type;

      if (!rawEventType) {
        return {
          success: false,
          error: 'Missing event_type in PayPal webhook payload',
        };
      }

      const eventType = PAYPAL_WEBHOOK_EVENT_MAP[rawEventType];
      if (!eventType) {
        // Not an event we model — report it so the route can 200-ack + ignore.
        return {
          success: false,
          error: `Unsupported PayPal event_type: ${rawEventType}`,
        };
      }

      const resource = payload.resource ?? {};
      // For capture/refund events, resource.id is the capture/refund id.
      const providerTransactionId =
        typeof resource.id === 'string' ? resource.id : undefined;

      // PayPal's own event id is globally unique → idempotent across redeliveries.
      const eventId =
        typeof payload.id === 'string' && payload.id
          ? payload.id
          : `${providerTransactionId ?? 'unknown'}:${eventType}`;

      const amount = resource.amount;
      const currency =
        amount && typeof amount.currency_code === 'string'
          ? amount.currency_code
          : undefined;
      const amountMinor =
        amount && currency && typeof amount.value === 'string'
          ? decimalStringToMinor(amount.value, currency)
          : undefined;

      const newStatus = mapEventToTransactionStatus(eventType) ?? undefined;

      const parsed: ParsedWebhookEvent = {
        provider: 'paypal',
        eventId,
        eventType,
        providerTransactionId,
        amountMinor,
        currency,
        newStatus,
        timestamp: payload.create_time
          ? new Date(payload.create_time)
          : new Date(),
        rawPayload,
      };

      if (eventType === 'payment.failed') {
        const statusDetails = resource.status_details as
          | { reason?: string }
          | undefined;
        parsed.error = {
          code: statusDetails?.reason ?? 'PAYMENT_DENIED',
          message: payload.summary ?? 'Payment capture denied',
        };
      }

      return { success: true, event: parsed };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Parse error',
      };
    }
  }

  async processEvent(
    event: ParsedWebhookEvent
  ): Promise<WebhookProcessingResult> {
    if (!this.canHandle(event.eventType)) {
      return { success: true, action: 'ignored_event_type' };
    }
    // Intentionally thin: order/credit persistence happens in the app layer,
    // which reads the normalized event.
    return {
      success: true,
      transactionId: event.providerTransactionId,
      action:
        event.eventType === 'payment.refunded'
          ? 'refund_processed'
          : 'status_updated',
    };
  }

  canHandle(eventType: string): boolean {
    return (this.supportedEventTypes as readonly string[]).includes(eventType);
  }

  async reconcile(
    _transactionId: string,
    providerTransactionId: string
  ): Promise<ReconciliationResult> {
    if (!this.providerForReconcile) {
      return {
        reconciled: false,
        finalStatus: 'created',
        source: 'provider_query',
        statusChanged: false,
      };
    }

    const result =
      await this.providerForReconcile.getPaymentIntentStatus(providerTransactionId);
    const finalStatus = (result.status as TransactionStatus) ?? 'created';

    return {
      reconciled: !result.error,
      finalStatus,
      source: 'provider_query',
      statusChanged: false,
    };
  }

  mapEventType(providerEventType: string): string {
    // Accept either a raw PayPal event_type or an already-normalized value.
    return (
      PAYPAL_WEBHOOK_EVENT_MAP[providerEventType] ?? providerEventType
    );
  }

  mapStatus(providerStatus: string): TransactionStatus | null {
    return mapEventToTransactionStatus(providerStatus as PaypalNormalizedEvent);
  }
}
