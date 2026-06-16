/**
 * SUMIT (UPAY) Types, Endpoints & Mappers
 *
 * Single source of truth for the SUMIT REST API surface used by this adapter.
 * SUMIT was formerly "OfficeGuy"; all calls are POST JSON to the API base and
 * are authenticated with a `Credentials: { CompanyID, APIKey }` object in the
 * request body (keys minted at https://app.sumit.co.il/developers/keys/).
 *
 * Endpoints, field names and enums below were VERIFIED against the live
 * OpenAPI 3.1 spec:  https://api.sumit.co.il/swagger/v1/swagger.json
 * (swagger UI: https://app.sumit.co.il/help/developers/swagger/index.html).
 */

import type { TransactionStatus } from '@nehorai/payments/types';

// ============================================================================
// Endpoints & constants (verified against swagger)
// ============================================================================

/** Default SUMIT API base URL (override via SumitProviderConfig.baseUrl). */
export const SUMIT_API_BASE = 'https://api.sumit.co.il';

export const SUMIT_ENDPOINTS = {
  /** Hosted/redirect checkout. Returns Data.RedirectURL (a secure payment page). */
  BEGIN_REDIRECT: '/billing/payments/beginredirect/',
  /** Direct server-to-server charge (with a token / saved method). */
  CHARGE: '/billing/payments/charge/',
  /** Fetch a payment by id → Data.Payment (supplementary verification). */
  GET_PAYMENT: '/billing/payments/get/',
  /** Create a recurring standing order (server-to-server; requires a token). */
  RECURRING_CHARGE: '/billing/recurring/charge/',
  /** Cancel a recurring standing order by RecurringCustomerItemID. */
  RECURRING_CANCEL: '/billing/recurring/cancel/',
  /** Update a recurring standing order. */
  RECURRING_UPDATE: '/billing/recurring/update/',
  /** List a customer's recurring standing orders. */
  RECURRING_LIST: '/billing/recurring/listforcustomer/',
} as const;

/** Currencies supported by this adapter (subset of SUMIT's currency enum). */
export const SUMIT_SUPPORTED_CURRENCIES = ['ILS', 'USD', 'EUR'] as const;

/**
 * SUMIT currency enum (`Accounting_Typed_DocumentCurrency`) numeric values.
 * The API accepts the enum NAME ("ILS"/"USD"/"EUR") in JSON, which matches the
 * ISO code for these three — so we pass the ISO string directly.
 */
export const SUMIT_CURRENCY_CODES: Record<string, number> = {
  ILS: 0,
  USD: 1,
  EUR: 2,
};

// ============================================================================
// Auth & envelope
// ============================================================================

export interface SumitCredentials {
  CompanyID: number;
  APIKey: string;
}

/**
 * Standard SUMIT response envelope. `Status` is the `Teva.Common.ResponseStatus`
 * enum: Success=0, BusinessError=1, TechnicalError=2 — serialized by .NET either
 * as the number (0) or the name ("Success"); {@link isSumitSuccess} handles both.
 */
export interface SumitResponse<T = unknown> {
  Status: number | string;
  UserErrorMessage?: string | null;
  TechnicalErrorDetails?: string | null;
  Data?: T;
}

/** True when a SUMIT response indicates success (handles 0 and "Success"). */
export function isSumitSuccess(response: SumitResponse): boolean {
  return response.Status === 0 || response.Status === 'Success';
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
// Request / response payloads (verified field names)
// ============================================================================

/** SUMIT customer (subset of ChargeCustomer). */
export interface SumitCustomer {
  ID?: number;
  Name?: string;
  Phone?: string;
  EmailAddress?: string;
  /** Our external id (e.g. userId) for matching back. */
  ExternalIdentifier?: string;
}

/** A catalog/ad-hoc product reference inside a line item. */
export interface SumitItem {
  ID?: number;
  Name?: string;
  Description?: string;
  Price?: number;
  /** Currency enum name (ISO for ILS/USD/EUR). */
  Currency?: string;
  ExternalIdentifier?: string;
  SKU?: string;
}

/** A one-time charge line item (ChargeItem). */
export interface SumitChargeItem {
  Item?: SumitItem;
  Quantity?: number;
  UnitPrice?: number;
  Total?: number;
  Currency?: string;
  Description?: string;
}

/** A recurring charge line item (ChargeRecurringItem). */
export interface SumitRecurringItem {
  Item?: SumitItem;
  Quantity?: number;
  UnitPrice?: number;
  Currency?: string;
  Description?: string;
  Date_Start?: string;
  Duration_Days?: number;
  Duration_Months?: number;
  /** Number of occurrences; omit for open-ended. */
  Recurrence?: number;
}

/**
 * A beginredirect line item. beginredirect performs a one-time charge only
 * (it cannot create a standing order — that is done via SUMIT Payment Pages),
 * so the item is a plain {@link SumitChargeItem} (UnitPrice).
 */
export type SumitBeginRedirectItem = SumitChargeItem;

export interface SumitBeginRedirectRequest {
  Credentials: SumitCredentials;
  Customer?: SumitCustomer;
  Items?: SumitBeginRedirectItem[];
  VATIncluded?: boolean;
  /** Success return URL (we append internal_order_id). */
  RedirectURL?: string;
  /** Cancel/failure return URL. */
  CancelRedirectURL?: string;
  /** Our internal order id, echoed back on the created payment/document. */
  ExternalIdentifier?: string;
  /** Max installments (1 = single charge). */
  MaximumPayments?: number;
  DocumentDescription?: string;
  /**
   * Prevents saving the card as the customer's default payment method.
   * Defaults to false (card IS saved) — Flow B relies on the saved card for the
   * subsequent recurring charge, so leave unset for subscriptions and set true
   * only for one-time purchases that should not vault the card.
   */
  PreventSavingPaymentMethod?: boolean;
  [key: string]: unknown;
}

/** Response Data for beginredirect — only the hosted payment-page URL. */
export interface SumitBeginRedirectData {
  RedirectURL?: string;
}

/** SUMIT payment object (returned under Data.Payment by /billing/payments/get/). */
export interface SumitPayment {
  ID?: number;
  CustomerID?: number;
  Date?: string;
  ValidPayment?: boolean;
  Status?: string;
  StatusDescription?: string;
  Amount?: number;
  Currency?: string;
  AuthNumber?: string;
  /** Standing-order ids this payment belongs to (recurring). */
  RecurringCustomerItemIDs?: number[];
  [key: string]: unknown;
}

export interface SumitGetPaymentData {
  Payment?: SumitPayment;
}

/** Params for {@link SumitProvider.verifyPayment}. */
export interface VerifyPaymentParams {
  paymentId: string | number;
  /** When provided, the payment's Amount (major units ×100) must equal this. */
  expectedAmountMinor?: number;
}

/** Result of {@link SumitProvider.verifyPayment}. `verified` is the only field
 *  you need to gate a grant — it is true ONLY when the payment is valid AND
 *  (no expected amount was given OR the amount matches). */
export interface VerifyPaymentResult {
  verified: boolean;
  /** SUMIT `ValidPayment === true`. */
  valid: boolean;
  /** Whether the reported amount matched `expectedAmountMinor` (undefined when not provided). */
  amountMatches?: boolean;
  /** Reported amount in minor units (Math.round(Amount × 100)). */
  amountMinor?: number;
  payment?: SumitPayment;
  error?: string;
}

export interface SumitRecurringChargeRequest {
  Credentials: SumitCredentials;
  Customer?: SumitCustomer;
  /** Single-use card token from the SUMIT Payments JS API / vault. */
  SingleUseToken?: string;
  Items?: SumitRecurringItem[];
  VATIncluded?: boolean;
  /**
   * Our id stamped on the standing order so renewal payments echo it back
   * (`OG-ExternalIdentifier`), letting the webhook resolve the subscription.
   */
  ExternalIdentifier?: string;
  [key: string]: unknown;
}

/**
 * SUMIT-specific extras for {@link SumitProvider.createSubscription}.
 *
 * Flow B (fully app-driven) charges a card saved by a prior hosted
 * `beginredirect` checkout, referenced by the SUMIT customer id — no
 * SingleUseToken. Supplying `providerCustomerId` selects this no-token path.
 */
export interface SumitCreateSubscriptionExtra {
  /**
   * SUMIT customer id (the `OG-CustomerID` returned by the one-time hosted
   * checkout) whose saved default card to charge. The no-token path: provide
   * this INSTEAD of `paymentMethodToken`.
   */
  providerCustomerId?: string;
  /**
   * First recurring-charge date (`YYYY-MM-DD`) → `Date_Start`. A future date
   * defers the first recurring bill, so signup is charged exactly once (by the
   * preceding one-time `beginredirect`). Omit to start the recurrence now.
   */
  startDate?: string;
  /**
   * Our id (e.g. the subscription doc id) to stamp on the standing order as
   * `ExternalIdentifier`, so each renewal payment echoes it back and the renewal
   * webhook can resolve the owning subscription. Defaults to `idempotencyKey`.
   * The consuming app should ALSO match renewals by `RecurringCustomerItemID`
   * (the standing-order id) as the authoritative fallback, since SUMIT's
   * propagation of this field onto renewal payments is provider-dependent.
   */
  externalIdentifier?: string;
}

/**
 * SUMIT-specific extras for {@link SumitProvider.cancelSubscription}.
 * SUMIT's `recurring/cancel` requires the owning customer in addition to the
 * `RecurringCustomerItemID`.
 */
export interface SumitCancelSubscriptionExtra {
  /** SUMIT customer id owning the standing order (required by recurring/cancel). */
  providerCustomerId?: string;
}

/**
 * SUMIT-specific extras on the {@link SumitProvider.createSubscription} result.
 *
 * Surfaces whether `recurring/charge` captured a payment NOW. For a Flow B
 * standing order created with a FUTURE `startDate`/`Date_Start`, this must be
 * `0`/undefined — the cycle-1 charge already happened on the one-time hosted
 * checkout. A non-zero value means SUMIT charged immediately despite the future
 * start (a double charge), which the caller should detect and alert on.
 */
export interface SumitSubscriptionResultExtra {
  /**
   * Amount (minor units) SUMIT captured on the `recurring/charge` call itself.
   * `undefined`/`0` when the first bill was deferred to `Date_Start` (expected
   * for Flow B); `> 0` means an immediate charge fired now.
   */
  immediateChargeAmountMinor?: number;
}

/** Recurring charge response surfaces a Payment whose RecurringCustomerItemIDs
 *  identify the created standing order(s). */
export interface SumitRecurringChargeData {
  Payment?: SumitPayment;
}

// ============================================================================
// Webhook payload (configurable "View" — see docs/billing-sumit.md)
// ============================================================================

/**
 * SUMIT webhooks are driven by the generic "Triggers + Views" automation and
 * post the fields of the selected View (JSON or FORM). The field names depend
 * on the View we configure, so the parser reads a set of candidate keys
 * defensively. docs/billing-sumit.md lists the recommended View fields, aligned
 * with the verified Payment object (ID, ValidPayment, RecurringCustomerItemIDs…).
 */
export type SumitWebhookPayload = Record<string, unknown>;

// ============================================================================
// Normalized (unified) event types emitted by this adapter
// ============================================================================

export const SUMIT_WEBHOOK_EVENTS = [
  'payment.succeeded',
  'payment.failed',
  'payment.refunded',
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
    case 'payment.refunded':
      return 'fully_refunded';
    case 'card.updated':
      return null;
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
