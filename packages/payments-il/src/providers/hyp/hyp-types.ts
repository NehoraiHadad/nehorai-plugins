/**
 * Hyp (CreditGuard) Types
 *
 * Type definitions for Hyp/CreditGuard API interactions.
 * CreditGuard uses XML-based requests over HTTPS.
 *
 * @see https://cgpay3.creditguard.co.il/docs
 */

import type { TransactionStatus } from '@nehorai/payments/types';

// ============================================================================
// Hyp Configuration
// ============================================================================

/**
 * Hyp API configuration
 *
 * Provide either `environment` (auto-selects baseUrl) or `baseUrl` directly.
 * If both are provided, `baseUrl` takes precedence.
 */
export interface HypConfig {
  /** Terminal number assigned by CreditGuard */
  terminalNumber: string;
  /** API username */
  user: string;
  /** API password */
  password: string;
  /** Webhook secret for callback validation */
  webhookSecret?: string;
  /** Environment shortcut - auto-selects the correct baseUrl */
  environment?: 'sandbox' | 'production';
  /** Base URL override (takes precedence over environment) */
  baseUrl?: string;
}

/**
 * Hyp API endpoints
 */
export const DEFAULT_HYP_ENDPOINTS = {
  test: 'https://cguat2.creditguard.co.il',
  production: 'https://cgpay3.creditguard.co.il',
} as const;

/**
 * Hyp supported currencies (subset)
 */
export const HYP_SUPPORTED_CURRENCIES = [
  'ILS', // Israeli Shekel (primary)
  'USD', // US Dollar
  'EUR', // Euro
  'GBP', // British Pound
] as const;

// ============================================================================
// XML Request/Response Types
// ============================================================================

/**
 * Hyp doDeal request parameters
 */
export interface HypDoDealRequest {
  /** Terminal number */
  terminalNumber: string;
  /** API username */
  user: string;
  /** API password */
  password: string;
  /** Card number (for direct charge) */
  cardNo?: string;
  /** Card expiration (MMYY) */
  cardExpiration?: string;
  /** CVV code */
  cvv?: string;
  /** Card token (for saved card transactions) */
  cardToken?: string;
  /** Authorization code (for force/capture transactions) */
  authorizationCode?: string;
  /** Amount in minor units (agorot for ILS) */
  total?: number;
  /** Currency code (ILS, USD, EUR, GBP) */
  currency: string;
  /** Transaction type (Debit, Credit, etc.) */
  transactionType: string;
  /** Transaction code for J5: Regular, Verify, etc. */
  transactionCode?: string;
  /** Credit type: 1=Regular, 8=Credit/Token */
  creditType?: string;
  /** Validation mode: AutoComm, TxOnly */
  validation?: string;
  /** Customer ID for tokenization */
  customerData?: string;
  /** Unique transaction identifier */
  uniqueid?: string;
  /** Success URL for hosted page */
  successUrl?: string;
  /** Error URL for hosted page */
  errorUrl?: string;
  /** Cancel URL for hosted page */
  cancelUrl?: string;
  /** Language code (he, en) */
  language?: string;
}

/**
 * Hyp doDeal response
 */
export interface HypDoDealResponse {
  /** Result code (000 = success) */
  resultCode: string;
  /** Result description */
  resultDescription?: string;
  /** Transaction ID from CreditGuard */
  transactionId?: string;
  /** Authorization number */
  authorizationCode?: string;
  /** Voucher number */
  voucherNumber?: string;
  /** Card token (if tokenization requested) */
  cardToken?: string;
  /** Card mask (last 4 digits) */
  cardMask?: string;
  /** Card brand (Visa, MasterCard, etc.) */
  cardBrand?: string;
  /** Card expiration */
  cardExpiration?: string;
  /** Redirect URL for hosted page */
  redirectUrl?: string;
  /** Unique ID echo */
  uniqueid?: string;
  /** Raw XML response for debugging */
  rawXml?: string;
}

/**
 * Hyp refundDeal request parameters
 */
export interface HypRefundDealRequest {
  /** Terminal number */
  terminalNumber: string;
  /** API username */
  user: string;
  /** API password */
  password: string;
  /** Original transaction ID */
  transactionId: string;
  /** Amount to refund in minor units (optional for full refund) */
  total?: number;
  /** Currency code */
  currency: string;
  /** Unique identifier */
  uniqueid?: string;
}

/**
 * Hyp refundDeal response
 */
export interface HypRefundDealResponse {
  /** Result code (000 = success) */
  resultCode: string;
  /** Result description */
  resultDescription?: string;
  /** Refund transaction ID */
  transactionId?: string;
  /** Authorization code for refund */
  authorizationCode?: string;
  /** Unique ID echo */
  uniqueid?: string;
}

// ============================================================================
// Status Mapping
// ============================================================================

/**
 * Hyp result codes
 */
export type HypResultCode = '000' | '001' | '002' | '003' | '004' | '005' | '006' | string;

/**
 * Map Hyp result codes to our TransactionStatus
 */
export const HYP_RESULT_CODE_MAP: Record<string, TransactionStatus> = {
  '000': 'captured', // Success
  '001': 'failed', // Declined
  '002': 'failed', // Invalid card
  '003': 'failed', // Expired card
  '004': 'failed', // Insufficient funds
  '005': 'failed', // Invalid CVV
  '006': 'failed', // Card not permitted
  '033': 'failed', // Lost/Stolen card
  '034': 'failed', // Suspected fraud
  '051': 'failed', // Insufficient funds
  '054': 'failed', // Expired card
  '057': 'failed', // Transaction not permitted
  '100': 'failed', // System error
  '200': 'pending_authorization', // Pending
};

/**
 * Hyp transaction types
 */
export const HYP_TRANSACTION_TYPES = {
  /** Regular charge (immediate capture) */
  DEBIT: 'Debit',
  /** Refund */
  CREDIT: 'Credit',
  /** Authorization only (J5) */
  DEBIT_J5: 'Debit',
} as const;

/**
 * Hyp transaction codes for J5
 */
export const HYP_TRANSACTION_CODES = {
  /** Regular transaction */
  REGULAR: 'Regular',
  /** Verify only (authorization) */
  VERIFY: 'Verify',
  /** Force transaction */
  FORCE: 'Force',
} as const;

/**
 * Hyp validation modes
 */
export const HYP_VALIDATION_MODES = {
  /** Auto commit (immediate capture) */
  AUTO_COMM: 'AutoComm',
  /** Transaction only (authorization, requires manual capture) */
  TX_ONLY: 'TxOnly',
} as const;

/**
 * Hyp credit types
 */
export const HYP_CREDIT_TYPES = {
  /** Regular credit card */
  REGULAR: '1',
  /** Token/Saved card */
  TOKEN: '8',
} as const;

// ============================================================================
// Error Mapping
// ============================================================================

/**
 * Map Hyp result codes to our error codes
 */
export const HYP_ERROR_MAP: Record<string, string> = {
  '001': 'card_declined',
  '002': 'invalid_card',
  '003': 'expired_card',
  '004': 'insufficient_funds',
  '005': 'invalid_cvc',
  '006': 'card_declined',
  '033': 'card_declined',
  '034': 'card_declined',
  '051': 'insufficient_funds',
  '054': 'expired_card',
  '057': 'card_declined',
  '100': 'processing_error',
  '200': 'authentication_required',
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Map Hyp result code to our transaction status
 */
export function mapHypStatus(resultCode: string): TransactionStatus | null {
  return HYP_RESULT_CODE_MAP[resultCode] ?? null;
}

/**
 * Map Hyp error code to our error code
 */
export function mapHypError(resultCode: string): string {
  return HYP_ERROR_MAP[resultCode] ?? 'unknown';
}

/**
 * Check if currency is supported by Hyp
 */
export function isHypSupportedCurrency(currency: string): boolean {
  return HYP_SUPPORTED_CURRENCIES.includes(
    currency as (typeof HYP_SUPPORTED_CURRENCIES)[number]
  );
}

/**
 * Check if result code indicates success
 */
export function isHypSuccess(resultCode: string): boolean {
  return resultCode === '000';
}

/**
 * Format amount for Hyp (already in minor units, no conversion needed)
 */
export function formatHypAmount(amountMinor: number): number {
  return amountMinor;
}

/**
 * Format card expiration for Hyp (MMYY format)
 */
export function formatCardExpiration(month: string, year: string): string {
  const mm = month.padStart(2, '0');
  const yy = year.slice(-2);
  return `${mm}${yy}`;
}

/**
 * Parse card expiration from Hyp format (MMYY)
 */
export function parseCardExpiration(expiration: string): {
  month: string;
  year: string;
} {
  const mm = expiration.substring(0, 2);
  const yy = expiration.substring(2, 4);
  return {
    month: mm,
    year: `20${yy}`,
  };
}
