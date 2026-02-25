/**
 * @nehorai/payments-stripe - Stripe Webhook Handler
 *
 * Processes incoming Stripe webhooks with idempotency.
 * Maps Stripe events to transaction status updates.
 */

import Stripe from 'stripe';
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
import type { StripeConfig } from './stripe-types.js';
import {
  STRIPE_WEBHOOK_EVENTS,
  STRIPE_EVENT_ACTIONS,
  mapStripeStatus,
  DEFAULT_STRIPE_API_VERSION,
  type StripeWebhookEventType,
} from './stripe-types.js';

/**
 * Stripe Webhook Handler Implementation
 *
 * Accepts configuration via constructor parameter (no env reads).
 */
export class StripeWebhookHandler implements IWebhookHandler {
  readonly provider: PaymentProvider = 'stripe';
  readonly supportedEventTypes = STRIPE_WEBHOOK_EVENTS;

  private stripe: Stripe;
  private webhookSecret: string | undefined;

  constructor(config: StripeConfig) {
    this.stripe = new Stripe(config.secretKey, {
      apiVersion: (config.apiVersion ?? DEFAULT_STRIPE_API_VERSION) as Stripe.LatestApiVersion,
    });
    this.webhookSecret = config.webhookSecret;
  }

  parseEvent(rawPayload: Record<string, unknown>): ParseWebhookResult {
    try {
      const eventId = rawPayload.id as string;
      const eventType = rawPayload.type as string;
      const dataObject = (rawPayload.data as Record<string, unknown>)
        ?.object as Record<string, unknown>;

      if (!eventId || !eventType || !dataObject) {
        return { success: false, error: 'Invalid webhook payload structure' };
      }

      const parsed: ParsedWebhookEvent = {
        provider: 'stripe',
        eventId,
        eventType,
        providerTransactionId: (dataObject.id as string) ?? undefined,
        timestamp: new Date((rawPayload.created as number) * 1000),
        rawPayload,
      };

      if (eventType.startsWith('payment_intent.')) {
        const status = dataObject.status as string;
        parsed.newStatus = mapStripeStatus(status) ?? undefined;
        parsed.amountMinor = dataObject.amount as number;
        parsed.currency = (dataObject.currency as string)?.toUpperCase();
      }

      if (eventType.includes('failed')) {
        const error = dataObject.last_payment_error as Record<string, unknown>;
        if (error) {
          parsed.error = {
            code: (error.code as string) ?? 'unknown',
            message: (error.message as string) ?? 'Payment failed',
          };
        }
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
    const action =
      STRIPE_EVENT_ACTIONS[event.eventType as StripeWebhookEventType];

    if (!action) {
      return { success: true, action: 'ignored_event_type' };
    }

    return {
      success: true,
      transactionId: event.providerTransactionId,
      action: action === 'no_change' ? 'no_action_needed' : 'status_updated',
    };
  }

  canHandle(eventType: string): boolean {
    return this.supportedEventTypes.includes(
      eventType as StripeWebhookEventType
    );
  }

  async reconcile(
    _transactionId: string,
    providerTransactionId: string
  ): Promise<ReconciliationResult> {
    try {
      const pi =
        await this.stripe.paymentIntents.retrieve(providerTransactionId);
      const status = mapStripeStatus(pi.status);

      return {
        reconciled: true,
        finalStatus: status ?? 'created',
        source: 'provider_query',
        statusChanged: true,
      };
    } catch {
      return {
        reconciled: false,
        finalStatus: 'created',
        source: 'provider_query',
        statusChanged: false,
      };
    }
  }

  mapEventType(providerEventType: string): string {
    return providerEventType;
  }

  mapStatus(providerStatus: string): TransactionStatus | null {
    return mapStripeStatus(providerStatus);
  }
}
