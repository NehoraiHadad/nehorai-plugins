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

/**
 * Extract { amountMinor, currency } from a webhook resource, handling BOTH
 * money shapes PayPal uses: the v2 capture/refund shape
 * ({ currency_code, value }) and the deprecated v1 sale shape used by the
 * recurring PAYMENT.SALE.COMPLETED event ({ currency, total }).
 */
function extractAmount(resource: Record<string, unknown>): {
  amountMinor?: number;
  currency?: string;
} {
  const amount = resource.amount as
    | {
        currency_code?: unknown;
        value?: unknown;
        currency?: unknown;
        total?: unknown;
      }
    | undefined;
  if (!amount) return {};

  // v2 shape first (capture/refund), then v1 sale shape (currency/total).
  const currency =
    typeof amount.currency_code === 'string'
      ? amount.currency_code
      : typeof amount.currency === 'string'
        ? amount.currency
        : undefined;
  const rawValue =
    typeof amount.value === 'string'
      ? amount.value
      : typeof amount.total === 'string'
        ? amount.total
        : undefined;

  if (!currency || rawValue === undefined) return { currency };
  return { amountMinor: decimalStringToMinor(rawValue, currency), currency };
}

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

      // providerTransactionId semantics differ by event family:
      //  - PAYMENT.CAPTURE.* / *.SALE.COMPLETED / refunds → resource.id is the
      //    capture/sale/refund CHARGE id (the app's per-cycle idempotency key).
      //  - BILLING.SUBSCRIPTION.* → resource.id is the SUBSCRIPTION id (I-...).
      // For the recurring sale event the owning subscription id lives in
      // resource.billing_agreement_id and is always reachable via
      // rawPayload.resource.billing_agreement_id (the app resolves it there,
      // exactly as it reads custom_id from rawPayload for one-time payments).
      const providerTransactionId =
        typeof resource.id === 'string' ? resource.id : undefined;

      // PayPal's own event id is globally unique → idempotent across redeliveries.
      const eventId =
        typeof payload.id === 'string' && payload.id
          ? payload.id
          : `${providerTransactionId ?? 'unknown'}:${eventType}`;

      // Amount shapes: v2 capture/refund use { currency_code, value }; the v1
      // recurring sale (PAYMENT.SALE.COMPLETED) uses { currency, total }.
      const { amountMinor, currency } = extractAmount(resource);

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

      if (
        eventType === 'payment.failed' ||
        eventType === 'subscription.payment_failed'
      ) {
        const statusDetails = resource.status_details as
          | { reason?: string }
          | undefined;
        parsed.error = {
          code: statusDetails?.reason ?? 'PAYMENT_FAILED',
          message:
            payload.summary ??
            (eventType === 'subscription.payment_failed'
              ? 'Subscription payment failed'
              : 'Payment capture denied'),
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
