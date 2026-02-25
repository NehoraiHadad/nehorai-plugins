/**
 * Cardcom Type Definitions
 *
 * Type definitions for Cardcom payment gateway API v11.
 * Supports JSON API endpoints for Low Profile (hosted page) and direct transactions.
 *
 * @see https://secure.cardcom.solutions/api/v11/swagger/ui/index
 */

import type { TransactionStatus } from '@nehorai/payments/types';

// ============================================================================
// API Configuration
// ============================================================================

export const CARDCOM_API_BASE = 'https://secure.cardcom.solutions';

export const CARDCOM_ENDPOINTS = {
  LOW_PROFILE_CREATE: '/api/v11/LowProfile/Create',
  LOW_PROFILE_STATUS: '/Interface/BillGoldGetLowProfileIndicator.aspx',
  DIRECT_CHARGE: '/api/v11/Transactions/Transaction',
  REFUND: '/api/v11/Transactions/RefundByTransactionId',
} as const;

export const CARDCOM_SUPPORTED_CURRENCIES = ['ILS', 'USD', 'EUR', 'GBP'] as const;

export const CARDCOM_API_VERSION = 'v11';

// ============================================================================
// Cardcom Configuration
// ============================================================================

export interface CardcomConfig {
  /** Terminal number (merchant ID) */
  terminalNumber: string;
  /** API username */
  apiName: string;
  /** API password */
  apiPassword: string;
  /** Webhook secret for signature validation */
  webhookSecret?: string;
  /** Environment (sandbox uses same endpoints but different credentials) */
  environment: 'sandbox' | 'production';
}

// ============================================================================
// Operation Types
// ============================================================================

export enum CardcomOperation {
  /** Charge immediately */
  BILL_ONLY = 1,
  /** Charge + save card token */
  BILL_AND_CREATE_TOKEN = 2,
  /** Save card without charging */
  CREATE_TOKEN_ONLY = 3,
  /** Authorize without capture (J5) */
  SUSPEND_DEAL_ONLY = 4,
}

export enum CardcomTransactionType {
  REGULAR = 1,
  CREDIT = 2,
  INSTALLMENTS = 3,
}

// ============================================================================
// Request Types
// ============================================================================

export interface CardcomLowProfileRequest {
  TerminalNumber: string;
  ApiName: string;
  ApiPassword: string;
  Sum: number;
  CoinID?: number;
  Operation?: CardcomOperation;
  Language?: string;
  ReturnUrl?: string;
  ErrorUrl?: string;
  ProductName?: string;
  CustomerName?: string;
  Email?: string;
  InvoiceLanguage?: string;
  SendEmail?: boolean;
  IndicatorUrl?: string;
  InternalDealNumber?: string;
}

export interface CardcomLowProfileStatusRequest {
  terminalnumber: string;
  lowprofilecode: string;
  username: string;
}

export interface CardcomDirectChargeRequest {
  TerminalNumber: string;
  ApiName: string;
  ApiPassword: string;
  CardNumber: string;
  CVV: string;
  Year: string;
  Month: string;
  CardOwnerID: string;
  Sum: number;
  CoinID?: number;
  NumOfPayments?: number;
  Operation?: CardcomOperation;
  Token?: string;
}

export interface CardcomRefundRequest {
  TerminalNumber: string;
  ApiName: string;
  ApiPassword: string;
  InternalDealNumber: string;
  Amount: number;
  CoinID?: number;
}

// ============================================================================
// Response Types
// ============================================================================

export interface CardcomLowProfileResponse {
  ResponseCode: number;
  Description?: string;
  LowProfileCode?: string;
  PaymentUrl?: string;
  DealCode?: string;
}

export interface CardcomLowProfileStatusResponse {
  ResponseCode: number;
  Description?: string;
  DealResponse?: number;
  OperationResponse?: number;
  InternalDealNumber?: string;
  Token?: string;
  CardMask?: string;
  CardType?: string;
  CardExpiration?: string;
  Amount?: number;
  Currency?: string;
  CardBin?: string;
}

export interface CardcomDirectChargeResponse {
  ResponseCode: number;
  Description?: string;
  InternalDealNumber?: string;
  ApprovalNumber?: string;
  CardMask?: string;
  Token?: string;
  DealCode?: string;
}

export interface CardcomRefundResponse {
  ResponseCode: number;
  Description?: string;
  InternalDealNumber?: string;
  Amount?: number;
}

// ============================================================================
// Webhook Types
// ============================================================================

export interface CardcomWebhookParams {
  ResponseCode?: string;
  LowProfileCode?: string;
  DealResponse?: string;
  OperationResponse?: string;
  InternalDealNumber?: string;
  Amount?: string;
  Currency?: string;
  CardMask?: string;
  Token?: string;
}

export const CARDCOM_WEBHOOK_EVENTS = [
  'payment.completed',
  'payment.declined',
  'payment.authorized',
] as const;

export type CardcomWebhookEventType = (typeof CARDCOM_WEBHOOK_EVENTS)[number];

export const CARDCOM_DEAL_RESPONSE_ACTIONS: Record<number, string> = {
  0: 'pending',
  1: 'approved',
  2: 'declined',
  3: 'error',
};

// ============================================================================
// Response Code Mapping
// ============================================================================

export const CARDCOM_RESPONSE_CODE_MAP: Record<number, TransactionStatus> = {
  0: 'created',
  1: 'failed',
  2: 'failed',
  3: 'failed',
  4: 'failed',
  5: 'failed',
  6: 'failed',
  7: 'failed',
  8: 'failed',
  9: 'failed',
  10: 'failed',
};

export function mapCardcomDealResponseToStatus(
  dealResponse: number
): TransactionStatus {
  switch (dealResponse) {
    case 0:
      return 'pending_authorization';
    case 1:
      return 'captured';
    case 2:
      return 'failed';
    case 3:
      return 'failed';
    default:
      return 'failed';
  }
}

export function mapCardcomError(responseCode: number): string {
  const errorMessages: Record<number, string> = {
    0: 'Success',
    1: 'General error',
    2: 'Invalid API credentials',
    3: 'Invalid terminal number',
    4: 'Invalid operation type',
    5: 'Invalid card details',
    6: 'Card declined by issuer',
    7: 'Insufficient funds',
    8: 'Invalid amount',
    9: 'Transaction not found',
    10: 'Duplicate transaction',
    11: 'Terminal not active',
    12: 'CVV validation failed',
    13: 'Card expired',
    14: 'Invalid currency',
    15: 'Operation not supported',
  };

  return errorMessages[responseCode] ?? `Error code ${responseCode}`;
}

export const CARDCOM_CURRENCY_CODES: Record<string, number> = {
  ILS: 1,
  USD: 2,
  EUR: 3,
  GBP: 4,
};

export function getCurrencyCode(currency: string): number {
  return CARDCOM_CURRENCY_CODES[currency.toUpperCase()] ?? 1;
}

export const CARDCOM_LANGUAGE_CODES = {
  en: 'en',
  he: 'he',
} as const;
