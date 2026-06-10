/**
 * SUMIT Webhook Handler
 *
 * SUMIT has NO dedicated, signed payment webhook. Webhooks are produced by the
 * generic "Triggers + Views" automation, which POSTs the fields of a chosen
 * View (JSON or FORM) on card/document create/update/delete/archive, with no
 * HMAC and possibly-missing linked fields.
 *
 * Consequences handled here:
 * - `parseEvent` reads candidate field names defensively and normalizes to the
 *   unified event set (payment.succeeded / payment.failed / subscription.* ).
 * - `eventId` is STABLE (paymentId + eventType), never time-based, so the
 *   `webhook_events (provider, provider_event_id)` unique constraint dedupes
 *   redelivered events — i.e. credits are never granted twice.
 * - `reconcile` actively queries SUMIT (the unsigned webhook is not trusted on
 *   its own) when a provider instance is supplied.
 *
 * The handler stays thin: it normalizes events only. Persisting orders and
 * granting credits is the application's responsibility.
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
  SUMIT_WEBHOOK_EVENTS,
  mapEventToTransactionStatus,
  pick,
  toBool,
  type SumitWebhookPayload,
  type SumitNormalizedEvent,
} from './sumit-types.js';
import type { SumitProvider } from './sumit-provider.js';

export class SumitWebhookHandler implements IWebhookHandler {
  readonly provider: PaymentProvider = 'sumit';
  readonly supportedEventTypes = SUMIT_WEBHOOK_EVENTS;

  /**
   * @param providerForReconcile Optional SumitProvider used by `reconcile` to
   *   verify state against the SUMIT API (recommended, since webhooks are
   *   unsigned). The factory wires this automatically.
   */
  constructor(private readonly providerForReconcile?: SumitProvider) {}

  parseEvent(rawPayload: Record<string, unknown>): ParseWebhookResult {
    try {
      const payload = rawPayload as SumitWebhookPayload;
      const eventType = this.normalizeEvent(payload);

      const paymentIdValue = pick(payload, [
        'PaymentID',
        'ID',
        'PaymentMethodID',
        'DocumentID',
        'RecurringCustomerItemID',
      ]);
      const paymentId = paymentIdValue !== undefined ? String(paymentIdValue) : '';

      if (!paymentId) {
        return {
          success: false,
          error: 'Missing payment/document id in SUMIT webhook payload',
        };
      }

      const amountMajor = Number(pick(payload, ['Amount', 'Total', 'Sum']) ?? 0);
      const amountMinor = Math.round(amountMajor * 100);
      const currency = String(pick(payload, ['Currency']) ?? 'ILS');
      const newStatus = mapEventToTransactionStatus(eventType) ?? undefined;

      const parsed: ParsedWebhookEvent = {
        provider: 'sumit',
        // Stable id → idempotent across redeliveries of the same logical event.
        eventId: `${paymentId}:${eventType}`,
        eventType,
        providerTransactionId: paymentId,
        amountMinor: amountMinor || undefined,
        currency,
        newStatus,
        timestamp: new Date(),
        rawPayload,
      };

      if (
        eventType === 'payment.failed' ||
        eventType === 'subscription.payment_failed'
      ) {
        parsed.error = {
          code: String(pick(payload, ['ErrorCode', 'StatusCode']) ?? 'failed'),
          message: String(
            pick(payload, ['ErrorMessage', 'StatusDescription', 'UserErrorMessage']) ??
              'Payment failed'
          ),
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
    // which reads the normalized event. We only report what kind of update the
    // event represents.
    return {
      success: true,
      transactionId: event.providerTransactionId,
      action: event.eventType === 'card.updated' ? 'no_action_needed' : 'status_updated',
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
    // Events are already normalized during parseEvent; pass through.
    return providerEventType;
  }

  mapStatus(providerStatus: string): TransactionStatus | null {
    return mapEventToTransactionStatus(providerStatus as SumitNormalizedEvent);
  }

  // ==========================================================================
  // Normalization
  // ==========================================================================

  private normalizeEvent(payload: SumitWebhookPayload): SumitNormalizedEvent {
    // 1) Explicit hint (e.g. a constant field configured on the SUMIT trigger,
    //    or an `event` value injected by the receiving route).
    const explicit = pick(payload, ['EventType', 'event']);
    if (
      explicit !== undefined &&
      (SUMIT_WEBHOOK_EVENTS as readonly string[]).includes(String(explicit))
    ) {
      return String(explicit) as SumitNormalizedEvent;
    }

    // 2) Derive from card/document fields.
    const canceled = toBool(pick(payload, ['Canceled', 'Cancelled', 'IsCanceled']));
    if (canceled === true) {
      return 'subscription.canceled';
    }

    const recurring =
      toBool(pick(payload, ['IsRecurring', 'Recurring'])) === true ||
      pick(payload, ['RecurringCustomerItemIDs', 'RecurringCustomerItemID', 'RecurringID']) !==
        undefined;

    const valid = toBool(pick(payload, ['ValidPayment', 'Valid', 'Success', 'Paid']));

    if (recurring) {
      return valid === false ? 'subscription.payment_failed' : 'subscription.renewed';
    }
    return valid === false ? 'payment.failed' : 'payment.succeeded';
  }
}
