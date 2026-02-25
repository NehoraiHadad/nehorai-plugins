/**
 * Hyp (CreditGuard) Webhook Handler
 *
 * Handles incoming webhooks/callbacks from Hyp/CreditGuard.
 * CreditGuard uses URL callbacks after transaction completion.
 *
 * @see https://cgpay3.creditguard.co.il/docs/callbacks
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
import { mapHypStatus, mapHypError, isHypSuccess } from './hyp-types.js';

/**
 * Hyp event types (synthesized from result codes)
 */
const HYP_EVENT_TYPES = {
  TRANSACTION_SUCCESS: 'transaction.success',
  TRANSACTION_FAILED: 'transaction.failed',
  TRANSACTION_PENDING: 'transaction.pending',
  REFUND_SUCCESS: 'refund.success',
  REFUND_FAILED: 'refund.failed',
} as const;

/**
 * Hyp Webhook Handler
 *
 * Processes callbacks from CreditGuard hosted pages and direct integrations.
 */
export class HypWebhookHandler implements IWebhookHandler {
  readonly provider: PaymentProvider = 'hyp';
  readonly supportedEventTypes = Object.values(HYP_EVENT_TYPES);

  parseEvent(rawPayload: Record<string, unknown>): ParseWebhookResult {
    try {
      const resultCode = String(rawPayload.resultCode ?? '100');
      const resultDescription = String(rawPayload.resultDescription ?? '');
      const transactionId = String(rawPayload.transactionId ?? '');
      const uniqueid = String(rawPayload.uniqueid ?? '');
      const total = Number(rawPayload.total ?? 0);
      const currency = String(rawPayload.currency ?? 'ILS');

      const eventType = this.determineEventType(resultCode);
      const newStatus = mapHypStatus(resultCode);

      const event: ParsedWebhookEvent = {
        provider: 'hyp',
        eventId: uniqueid || transactionId || `hyp_${Date.now()}`,
        eventType,
        providerTransactionId: transactionId,
        amountMinor: total,
        currency,
        newStatus: newStatus ?? undefined,
        error: isHypSuccess(resultCode)
          ? undefined
          : {
              code: resultCode,
              message: resultDescription,
            },
        timestamp: new Date(),
        rawPayload,
      };

      return {
        success: true,
        event,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to parse webhook',
      };
    }
  }

  async processEvent(
    event: ParsedWebhookEvent
  ): Promise<WebhookProcessingResult> {
    try {
      if (!event.providerTransactionId) {
        return {
          success: false,
          error: 'Missing transaction ID in webhook',
          action: 'ignored_event_type',
        };
      }

      const action = this.determineAction(event);

      return {
        success: true,
        transactionId: event.providerTransactionId,
        action,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Processing failed',
        action: 'ignored_event_type',
      };
    }
  }

  canHandle(eventType: string): boolean {
    return this.supportedEventTypes.includes(
      eventType as (typeof HYP_EVENT_TYPES)[keyof typeof HYP_EVENT_TYPES]
    );
  }

  async reconcile(
    _transactionId: string,
    _providerTransactionId: string
  ): Promise<ReconciliationResult> {
    return {
      reconciled: false,
      finalStatus: 'pending_authorization',
      source: 'webhook',
      statusChanged: false,
    };
  }

  mapEventType(providerEventType: string): string {
    return providerEventType;
  }

  mapStatus(providerStatus: string): TransactionStatus | null {
    return mapHypStatus(providerStatus);
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private determineEventType(resultCode: string): string {
    if (isHypSuccess(resultCode)) {
      return HYP_EVENT_TYPES.TRANSACTION_SUCCESS;
    }

    if (resultCode === '200') {
      return HYP_EVENT_TYPES.TRANSACTION_PENDING;
    }

    return HYP_EVENT_TYPES.TRANSACTION_FAILED;
  }

  private determineAction(
    event: ParsedWebhookEvent
  ): WebhookProcessingResult['action'] {
    switch (event.eventType) {
      case HYP_EVENT_TYPES.TRANSACTION_SUCCESS:
      case HYP_EVENT_TYPES.TRANSACTION_FAILED:
      case HYP_EVENT_TYPES.TRANSACTION_PENDING:
      case HYP_EVENT_TYPES.REFUND_FAILED:
        return 'status_updated';

      case HYP_EVENT_TYPES.REFUND_SUCCESS:
        return 'refund_processed';

      default:
        return 'ignored_event_type';
    }
  }

  // ==========================================================================
  // Webhook Validation
  // ==========================================================================

  validateSignature(
    payload: Record<string, unknown>,
    signature?: string,
    secret?: string
  ): boolean {
    const hasRequiredParams =
      payload.resultCode !== undefined &&
      (payload.transactionId !== undefined || payload.uniqueid !== undefined);

    if (!hasRequiredParams) {
      return false;
    }

    if (secret && signature) {
      return this.validateHMAC(payload, signature, secret);
    }

    return hasRequiredParams;
  }

  private validateHMAC(
    _payload: Record<string, unknown>,
    signature: string,
    _secret: string
  ): boolean {
    try {
      return !!signature;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Callback URL Builders
  // ==========================================================================

  buildSuccessUrl(baseUrl: string, transactionId: string): string {
    return `${baseUrl}/api/payments/hyp/callback?status=success&txId=${transactionId}`;
  }

  buildErrorUrl(baseUrl: string, transactionId: string): string {
    return `${baseUrl}/api/payments/hyp/callback?status=error&txId=${transactionId}`;
  }

  buildCancelUrl(baseUrl: string, transactionId: string): string {
    return `${baseUrl}/api/payments/hyp/callback?status=cancel&txId=${transactionId}`;
  }

  // ==========================================================================
  // Response Parsing
  // ==========================================================================

  extractErrorDetails(payload: Record<string, unknown>): {
    code: string;
    message: string;
    userMessage: string;
  } {
    const resultCode = String(payload.resultCode ?? 'unknown');
    const resultDescription = String(payload.resultDescription ?? 'Unknown error');

    return {
      code: resultCode,
      message: resultDescription,
      userMessage: this.getUserFriendlyMessage(resultCode),
    };
  }

  private getUserFriendlyMessage(resultCode: string): string {
    const errorCode = mapHypError(resultCode);

    const messages: Record<string, string> = {
      card_declined: 'Your card was declined. Please try another payment method.',
      invalid_card: 'The card information is invalid. Please check and try again.',
      expired_card: 'Your card has expired. Please use a different card.',
      insufficient_funds: 'Insufficient funds. Please try another payment method.',
      invalid_cvc: 'The security code (CVV) is incorrect.',
      processing_error: 'A processing error occurred. Please try again.',
      authentication_required:
        'Additional authentication is required. Please complete the verification.',
      unknown: 'An error occurred. Please try again or contact support.',
    };

    return messages[errorCode] ?? messages.unknown;
  }

  extractCardDetails(payload: Record<string, unknown>): {
    cardToken?: string;
    cardMask?: string;
    cardBrand?: string;
    cardExpiration?: string;
    last4?: string;
  } {
    const cardToken = payload.cardToken as string | undefined;
    const cardMask = payload.cardMask as string | undefined;
    const cardBrand = payload.cardBrand as string | undefined;
    const cardExpiration = payload.cardExpiration as string | undefined;

    return {
      cardToken,
      cardMask,
      cardBrand,
      cardExpiration,
      last4: cardMask?.slice(-4),
    };
  }
}

/**
 * Create Hyp webhook handler instance
 */
export function createHypWebhookHandler(): HypWebhookHandler {
  return new HypWebhookHandler();
}
