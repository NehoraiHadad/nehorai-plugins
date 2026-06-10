/**
 * SUMIT (UPAY) Types, Endpoints & Mappers
 *
 * Single source of truth for the SUMIT REST API surface used by this adapter.
 * SUMIT was formerly "OfficeGuy"; all calls are POST JSON to the API base and
 * are authenticated with a `Credentials: { CompanyID, APIKey }` object in the
 * request body (keys minted at https://app.sumit.co.il/developers/keys/).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ TO VERIFY against the live swagger / a SUMIT test org                     │
 * │   https://app.sumit.co.il/help/developers/swagger/index.html              │
 * │ The help center is high-level and the swagger is JS-rendered, so the      │
 * │ exact request/response field names below (esp. getpayment + recurring +   │
 * │ cancel) are best-effort and MUST be confirmed once test credentials are   │
 * │ available. Everything provider-specific is centralized here so a single   │
 * │ edit propagates everywhere.                                               │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import type { TransactionStatus, SubscriptionStatus } from '@nehorai/payments/types';

// ============================================================================
// Endpoints & constants
// ============================================================================

/** Default SUMIT API base URL (override via SumitProviderConfig.baseUrl). */
export const SUMIT_API_BASE = 'https://api.sumit.co.il';

/**
 * SUMIT endpoints used by this adapter.
 * NOTE: `BEGIN_REDIRECT` is confirmed from the docs; the others are best-effort
 * and flagged TO VERIFY above.
 */
export const SUMIT_ENDPOINTS = {
  /** Hosted/redirect checkout — confirmed. Returns a secure payment-page link. */
  BEGIN_REDIRECT: '/billing/payments/beginredirect/',
  /** Direct (server-to-server) charge with a tokenized card — confirmed family. */
  CHARGE: '/billing/payments/charge/',
  /** Fetch a payment/document by id (supplementary verification). TO VERIFY. */
  GET_PAYMENT: '/billing/payments/get/',
  /** Fetch a recurring standing order. TO VERIFY. */
  GET_RECURRING: '/billing/recurring/get/',
  /** Cancel a recurring standing order. TO VERIFY. */
  CANCEL_RECURRING: '/billing/recurring/cancel/',
} as const;

/** Currencies supported by this adapter. */
export const SUMIT_SUPPORTED_CURRENCIES = ['ILS', 'USD', 'EUR'] as const;

/** SUMIT response envelope `Status` value indicating success (0 = OK). */
export const SUMIT_STATUS_OK = 0;

// ============================================================================
// Auth & envelope
// ============================================================================

export interface SumitCredentials {
  CompanyID: number;
  APIKey: string;
}

/** Standard SUMIT response envelope. */
export interface SumitResponse<T = unknown> {
  /** 0 = success; non-zero = error (see UserErrorMessage). */
  Status: number;
  UserErrorMessage?: string | null;
  TechnicalErrorDetails?: string | null;
  Data?: T;
}

// ============================================================================
// Provider config
// ============================================================================

export interface SumitProviderConfig {
  /** SUMIT organization / company id. */
  companyId: number;
  /** Private API key (server-side only). */
  apiKey: string;
  /**
   * Shared secret embedded in the webhook URL (e.g. `?token=...`).
   * SUMIT provides NO HMAC/signature, so this token is the authenticity check.
   */
  webhookToken?: string;
  /** Override the API base (test/staging). Defaults to {@link SUMIT_API_BASE}. */
  baseUrl?: string;
}

// ============================================================================
// Request / response payloads (best-effort, see TO VERIFY)
// ============================================================================

export interface SumitCustomer {
  Name?: string;
  EmailAddress?: string;
  Phone?: string;
  /** Optional external id for matching back to our user. */
  ExternalIdentifier?: string;
}

export interface SumitLineItem {
  Item?: { Name?: string; Price?: number };
  Quantity?: number;
  Description?: string;
  UnitPrice?: number;
}

export interface SumitBeginRedirectRequest {
  Credentials: SumitCredentials;
  Customer?: SumitCustomer;
  Items?: SumitLineItem[];
  /** URL SUMIT redirects to after payment (we append internal_order_id). */
  RedirectURL?: string;
  /** Max number of installments (1 = single charge). */
  MaximumPayments?: number;
  Language?: string;
  /** Free-text reference echoed back where supported (internal order id). */
  Description?: string;
  /**
   * Recurrence configuration for standing orders / subscriptions. TO VERIFY:
   * SUMIT expresses recurring billing via a duration / recurrence object.
   */
  Recurrence?: {
    DurationMonths?: number;
    /** Number of charges; omit for open-ended. */
    RecurringCount?: number;
  };
  /** Allow any extra provider-specific fields without losing type-safety. */
  [key: string]: unknown;
}

export interface SumitBeginRedirectData {
  /** The secure hosted payment-page link to redirect the customer to. */
  RedirectURL?: string;
  /** Some responses use PaymentLink — handled defensively in the provider. */
  PaymentLink?: string;
  /** Identifier SUMIT assigns to the pending payment, if returned. */
  PaymentID?: string;
  Payment?: { ID?: string | number };
}

export interface SumitPaymentData {
  ID?: string | number;
  /** Whether the payment completed successfully. */
  ValidPayment?: boolean;
  Status?: string;
  Amount?: number;
  Currency?: string;
  CustomerID?: string | number;
  /** Present when the payment belongs to a recurring standing order. */
  RecurringID?: string | number;
  [key: string]: unknown;
}

export interface SumitRecurringData {
  ID?: string | number;
  Status?: string;
  /** Whether the standing order is currently active. */
  Active?: boolean;
  NextChargeDate?: string;
  [key: string]: unknown;
}

// ============================================================================
// Webhook payload (configurable "View" — see docs/billing-sumit.md)
// ============================================================================

/**
 * SUMIT webhooks are driven by the generic "Triggers + Views" automation and
 * post the fields of the selected View (JSON or FORM). The field names depend
 * on the View we configure, so the parser reads a set of candidate keys
 * defensively. docs/billing-sumit.md lists the recommended View fields.
 */
export type SumitWebhookPayload = Record<string, unknown>;

// ============================================================================
// Normalized (unified) event types emitted by this adapter
// ============================================================================

export const SUMIT_WEBHOOK_EVENTS = [
  'payment.succeeded',
  'payment.failed',
  'subscription.renewed',
  'subscription.payment_failed',
  'subscription.canceled',
  'card.updated',
] as const;

export type SumitNormalizedEvent = (typeof SUMIT_WEBHOOK_EVENTS)[number];

// ============================================================================
// Mappers / helpers
// ============================================================================

/** Build the SUMIT auth object from adapter config. */
export function buildCredentials(config: SumitProviderConfig): SumitCredentials {
  return { CompanyID: config.companyId, APIKey: config.apiKey };
}

/** Coerce a loosely-typed value to a boolean (handles "true"/"1"/1). */
export function toBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'valid', 'success'].includes(s)) return true;
  if (['false', '0', 'no', 'invalid', 'failed'].includes(s)) return false;
  return undefined;
}

/** First defined value among candidate keys. */
export function pick(
  payload: Record<string, unknown>,
  keys: string[]
): unknown {
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') {
      return payload[key];
    }
  }
  return undefined;
}

/**
 * Map a SUMIT payment's validity to a unified TransactionStatus.
 * SUMIT is single-phase: a valid payment is treated as `captured`.
 */
export function mapSumitStatusToTransactionStatus(
  valid: boolean | undefined
): TransactionStatus {
  if (valid === true) return 'captured';
  if (valid === false) return 'failed';
  return 'created';
}

/** Map a normalized event to a unified TransactionStatus (best-effort). */
export function mapEventToTransactionStatus(
  event: SumitNormalizedEvent
): TransactionStatus | null {
  switch (event) {
    case 'payment.succeeded':
    case 'subscription.renewed':
      return 'captured';
    case 'payment.failed':
    case 'subscription.payment_failed':
      return 'failed';
    case 'subscription.canceled':
      return 'voided';
    case 'card.updated':
      return null;
    default:
      return null;
  }
}

/** Map a normalized event to a SubscriptionStatus, when subscription-related. */
export function mapEventToSubscriptionStatus(
  event: SumitNormalizedEvent
): SubscriptionStatus | null {
  switch (event) {
    case 'subscription.renewed':
      return 'active';
    case 'subscription.payment_failed':
      return 'past_due';
    case 'subscription.canceled':
      return 'canceled';
    default:
      return null;
  }
}

/** Human-readable error from a SUMIT response envelope. */
export function mapSumitError(response: SumitResponse): string {
  return (
    response.UserErrorMessage ??
    response.TechnicalErrorDetails ??
    `SUMIT request failed with Status ${response.Status}`
  );
}
