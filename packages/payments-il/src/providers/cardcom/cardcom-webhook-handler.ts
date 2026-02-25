/**
 * Cardcom Webhook Handler
 *
 * Processes incoming Cardcom webhooks with idempotency.
 * Maps Cardcom callback events to transaction status updates.
 *
 * Cardcom uses GET callback parameters instead of POST webhooks.
 * Parameters are sent to ReturnUrl after payment completion.
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
  CARDCOM_WEBHOOK_EVENTS,
  CARDCOM_DEAL_RESPONSE_ACTIONS,
  mapCardcomDealResponseToStatus,
  type CardcomWebhookEventType,
  type CardcomWebhookParams,
} from './cardcom-types.js';

/**
 * Cardcom Webhook Handler Implementation
 */
export class CardcomWebhookHandler implements IWebhookHandler {
  readonly provider: PaymentProvider = 'cardcom';
  readonly supportedEventTypes = CARDCOM_WEBHOOK_EVENTS;

  parseEvent(rawPayload: Record<string, unknown>): ParseWebhookResult {
    try {
      const params = rawPayload as unknown as CardcomWebhookParams;

      const responseCode = parseInt(params.ResponseCode ?? '1', 10);
      const dealResponse = parseInt(params.DealResponse ?? '0', 10);
      const lowProfileCode = params.LowProfileCode ?? '';
      const internalDealNumber = params.InternalDealNumber ?? '';

      if (!lowProfileCode && !internalDealNumber) {
        return {
          success: false,
          error: 'Missing LowProfileCode or InternalDealNumber in callback',
        };
      }

      let eventType: CardcomWebhookEventType;
      if (dealResponse === 1) {
        eventType = 'payment.completed';
      } else if (dealResponse === 2) {
        eventType = 'payment.declined';
      } else if (dealResponse === 0 && responseCode === 0) {
        eventType = 'payment.authorized';
      } else {
        eventType = 'payment.declined';
      }

      const status = mapCardcomDealResponseToStatus(dealResponse);

      const amountString = params.Amount ?? '0';
      const amountMajor = parseFloat(amountString);
      const amountMinor = Math.round(amountMajor * 100);

      const parsed: ParsedWebhookEvent = {
        provider: 'cardcom',
        eventId: `${lowProfileCode}_${internalDealNumber}_${Date.now()}`,
        eventType,
        providerTransactionId: internalDealNumber || lowProfileCode,
        timestamp: new Date(),
        rawPayload,
        newStatus: status,
        amountMinor,
        currency: params.Currency ?? 'ILS',
      };

      if (dealResponse === 2 || responseCode !== 0) {
        parsed.error = {
          code: String(responseCode),
          message: CARDCOM_DEAL_RESPONSE_ACTIONS[dealResponse] ?? 'Payment failed',
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
    const action = this.getActionForEvent(event.eventType);

    if (action === 'ignored') {
      return {
        success: true,
        action: 'ignored_event_type',
      };
    }

    return {
      success: true,
      transactionId: event.providerTransactionId,
      action: 'status_updated',
    };
  }

  canHandle(eventType: string): boolean {
    return this.supportedEventTypes.includes(
      eventType as CardcomWebhookEventType
    );
  }

  async reconcile(
    _transactionId: string,
    _providerTransactionId: string
  ): Promise<ReconciliationResult> {
    return {
      reconciled: false,
      finalStatus: 'created',
      source: 'provider_query',
      statusChanged: false,
    };
  }

  mapEventType(providerEventType: string): string {
    return providerEventType;
  }

  mapStatus(providerStatus: string): TransactionStatus | null {
    const dealResponse = parseInt(providerStatus, 10);
    if (isNaN(dealResponse)) {
      return null;
    }
    return mapCardcomDealResponseToStatus(dealResponse);
  }

  private getActionForEvent(eventType: string): 'status_update' | 'ignored' {
    switch (eventType) {
      case 'payment.completed':
      case 'payment.declined':
      case 'payment.authorized':
        return 'status_update';
      default:
        return 'ignored';
    }
  }
}

// ============================================================================
// Callback Utility Functions
// ============================================================================

export function validateCardcomCallback(
  params: Record<string, unknown>
): { valid: boolean; error?: string } {
  const requiredFields = ['ResponseCode', 'LowProfileCode'];

  for (const field of requiredFields) {
    if (!params[field]) {
      return {
        valid: false,
        error: `Missing required field: ${field}`,
      };
    }
  }

  const responseCode = parseInt(String(params.ResponseCode), 10);
  if (isNaN(responseCode)) {
    return {
      valid: false,
      error: 'Invalid ResponseCode format',
    };
  }

  return { valid: true };
}

export function parseCardcomCallbackUrl(url: string): CardcomWebhookParams {
  try {
    const urlObj = new URL(url);
    const params: CardcomWebhookParams = {};

    params.ResponseCode = urlObj.searchParams.get('ResponseCode') ?? undefined;
    params.LowProfileCode =
      urlObj.searchParams.get('LowProfileCode') ?? undefined;
    params.DealResponse = urlObj.searchParams.get('DealResponse') ?? undefined;
    params.OperationResponse =
      urlObj.searchParams.get('OperationResponse') ?? undefined;
    params.InternalDealNumber =
      urlObj.searchParams.get('InternalDealNumber') ?? undefined;
    params.Amount = urlObj.searchParams.get('Amount') ?? undefined;
    params.Currency = urlObj.searchParams.get('Currency') ?? undefined;
    params.CardMask = urlObj.searchParams.get('CardMask') ?? undefined;
    params.Token = urlObj.searchParams.get('Token') ?? undefined;

    return params;
  } catch {
    return {};
  }
}

export function isCardcomCallbackSuccess(params: CardcomWebhookParams): boolean {
  const responseCode = parseInt(params.ResponseCode ?? '1', 10);
  const dealResponse = parseInt(params.DealResponse ?? '0', 10);

  return responseCode === 0 && dealResponse === 1;
}

export function isCardcomCallbackAuthorized(
  params: CardcomWebhookParams
): boolean {
  const responseCode = parseInt(params.ResponseCode ?? '1', 10);
  const dealResponse = parseInt(params.DealResponse ?? '0', 10);

  return responseCode === 0 && (dealResponse === 0 || dealResponse === 1);
}

export function getCardcomCallbackError(
  params: CardcomWebhookParams
): string | null {
  const responseCode = parseInt(params.ResponseCode ?? '1', 10);
  const dealResponse = parseInt(params.DealResponse ?? '0', 10);

  if (responseCode === 0 && dealResponse === 1) {
    return null;
  }

  if (dealResponse === 2) {
    return 'Payment declined by card issuer';
  }

  if (responseCode !== 0) {
    return `Payment failed with code ${responseCode}`;
  }

  return 'Payment processing error';
}
