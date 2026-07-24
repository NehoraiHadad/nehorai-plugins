/**
 * PayPal (Orders v2 + Payments v2) Types, Endpoints, Money & Mappers
 *
 * Single source of truth for the PayPal REST API surface used by this adapter.
 * Every endpoint path, request field and response field below was VERIFIED
 * against the official PayPal developer documentation (developer.paypal.com);
 * the verifying URL is cited in a comment next to each definition.
 *
 * All calls are JSON over HTTPS, authenticated with an OAuth2 bearer token
 * (see PaypalProvider.getAccessToken), except the token call itself which uses
 * HTTP Basic auth. Base URL is selected by config (sandbox vs live).
 */

import type { TransactionStatus } from '@nehorai/payments/types';

// ============================================================================
// Endpoints (verified)
// ============================================================================

/**
 * Endpoint paths. Doc: https://developer.paypal.com/api/rest/authentication/
 * (OAuth), https://developer.paypal.com/docs/api/orders/v2/ (orders),
 * https://developer.paypal.com/docs/api/payments/v2/ (refunds),
 * https://developer.paypal.com/api/rest/webhooks/rest/ (webhook verify).
 */
export const PAYPAL_ENDPOINTS = {
  /** OAuth2 client-credentials token. POST, Basic auth, form-encoded body. */
  OAUTH_TOKEN: '/v1/oauth2/token',
  /** Create an order. POST /v2/checkout/orders (intent CAPTURE). */
  CREATE_ORDER: '/v2/checkout/orders',
  /** Show order details. GET /v2/checkout/orders/{id}. */
  getOrder: (orderId: string) => `/v2/checkout/orders/${orderId}`,
  /** Capture payment for an order. POST /v2/checkout/orders/{id}/capture. */
  captureOrder: (orderId: string) => `/v2/checkout/orders/${orderId}/capture`,
  /** Verify a webhook signature. POST /v1/notifications/verify-webhook-signature. */
  VERIFY_WEBHOOK_SIGNATURE: '/v1/notifications/verify-webhook-signature',
  /** Refund a captured payment. POST /v2/payments/captures/{captureId}/refund. */
  refundCapture: (captureId: string) =>
    `/v2/payments/captures/${captureId}/refund`,
} as const;

// ============================================================================
// Currencies & money (verified)
// ============================================================================

/**
 * Currencies supported by this adapter (subset of PayPal's 28-currency enum).
 * Doc: https://developer.paypal.com/api/rest/reference/currency-codes/
 */
export const PAYPAL_SUPPORTED_CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'ILS',
  'AUD',
  'CAD',
  'JPY',
] as const;

/**
 * Currencies PayPal does NOT allow decimals for: "HUF, JPY, and TWD ... If you
 * pass a decimal amount, an error occurs."
 * Doc: https://developer.paypal.com/api/rest/reference/currency-codes/
 *
 * NOTE: This follows PayPal's rules, NOT ISO 4217 (which lists HUF/TWD as
 * 2-decimal). PayPal treats these three as zero-decimal for API amounts.
 */
export const PAYPAL_ZERO_DECIMAL_CURRENCIES = ['HUF', 'JPY', 'TWD'] as const;

/** The number of fractional digits PayPal expects for a currency (0 or 2). */
export function currencyExponent(currency: string): number {
  return (PAYPAL_ZERO_DECIMAL_CURRENCIES as readonly string[]).includes(
    currency.toUpperCase()
  )
    ? 0
    : 2;
}

/**
 * Convert an integer minor-unit amount to the decimal string PayPal expects in
 * `amount.value` (e.g. USD 4900 -> "49.00", JPY 100 -> "100").
 */
export function minorToDecimalString(
  amountMinor: number,
  currency: string
): string {
  const exp = currencyExponent(currency);
  return (amountMinor / 10 ** exp).toFixed(exp);
}

/**
 * Convert a PayPal decimal string (`amount.value`) back to integer minor units
 * (e.g. USD "49.00" -> 4900, JPY "100" -> 100). Rounds to guard float error.
 */
export function decimalStringToMinor(value: string, currency: string): number {
  const exp = currencyExponent(currency);
  return Math.round(parseFloat(value) * 10 ** exp);
}

// ============================================================================
// Status enums (verified) + mappers
// ============================================================================

/**
 * PayPal order status values.
 * Doc: https://developer.paypal.com/docs/api/orders/v2/ and
 * https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/standard/
 *  - CREATED: order created, not yet approved (valid ~3h).
 *  - SAVED: order saved/persisted.
 *  - APPROVED: buyer approved via the approve link; ready to capture.
 *  - PAYER_ACTION_REQUIRED: buyer must act (redirect to the payer-action link).
 *  - COMPLETED: payment captured (or authorized) for the order.
 *  - VOIDED: all purchase units voided.
 */
export const PAYPAL_ORDER_STATUSES = [
  'CREATED',
  'SAVED',
  'APPROVED',
  'PAYER_ACTION_REQUIRED',
  'COMPLETED',
  'VOIDED',
] as const;
export type PaypalOrderStatus = (typeof PAYPAL_ORDER_STATUSES)[number];

/**
 * PayPal capture status values.
 * Doc: https://developer.paypal.com/docs/api/orders/v2/#orders_capture and
 * https://developer.paypal.com/docs/api/payments/v2/
 */
export const PAYPAL_CAPTURE_STATUSES = [
  'COMPLETED',
  'DECLINED',
  'PARTIALLY_REFUNDED',
  'PENDING',
  'REFUNDED',
  'FAILED',
] as const;
export type PaypalCaptureStatus = (typeof PAYPAL_CAPTURE_STATUSES)[number];

/**
 * PayPal refund status values.
 * Doc: https://developer.paypal.com/docs/api/payments/v2/ (refund response).
 */
export const PAYPAL_REFUND_STATUSES = [
  'CANCELLED',
  'PENDING',
  'COMPLETED',
  'FAILED',
] as const;
export type PaypalRefundStatus = (typeof PAYPAL_REFUND_STATUSES)[number];

/** Map a PayPal order status to the unified TransactionStatus. */
export function mapOrderStatusToTransactionStatus(
  status: string | undefined
): TransactionStatus {
  switch (status) {
    case 'COMPLETED':
      return 'captured';
    case 'APPROVED':
      // Buyer approved, funds not yet captured — closest to an authorized hold.
      return 'authorized';
    case 'VOIDED':
      return 'voided';
    case 'CREATED':
    case 'SAVED':
    case 'PAYER_ACTION_REQUIRED':
      return 'created';
    default:
      return 'created';
  }
}

/** Map a PayPal capture status to the unified TransactionStatus. */
export function mapCaptureStatusToTransactionStatus(
  status: string | undefined
): TransactionStatus {
  switch (status) {
    case 'COMPLETED':
      return 'captured';
    case 'PARTIALLY_REFUNDED':
      return 'partially_refunded';
    case 'REFUNDED':
      return 'fully_refunded';
    case 'PENDING':
      // Captured but not yet credited (e.g. pending review) — treat as in-flight.
      return 'capturing';
    case 'DECLINED':
    case 'FAILED':
      return 'failed';
    default:
      return 'created';
  }
}

/** Map a PayPal refund status to the RefundResult status union. */
export function mapRefundStatus(
  status: string | undefined
): 'pending' | 'succeeded' | 'failed' {
  switch (status) {
    case 'COMPLETED':
      return 'succeeded';
    case 'PENDING':
      return 'pending';
    case 'CANCELLED':
    case 'FAILED':
    default:
      return 'failed';
  }
}

// ============================================================================
// Request / response payloads (verified field names)
// ============================================================================

/** A monetary value in the PayPal shape: decimal string + ISO currency code. */
export interface PaypalMoney {
  currency_code: string;
  value: string;
}

/** OAuth2 token response. Doc: /api/rest/authentication/ */
export interface PaypalTokenResponse {
  access_token: string;
  token_type: string;
  /** Seconds until the token expires. */
  expires_in: number;
  scope?: string;
  app_id?: string;
  nonce?: string;
}

/** HATEOAS link on an order/capture response. */
export interface PaypalLink {
  href: string;
  rel: string;
  method?: string;
}

/** A single capture inside purchase_units[].payments.captures[]. */
export interface PaypalCapture {
  id?: string;
  status?: string;
  amount?: PaypalMoney;
  custom_id?: string;
  invoice_id?: string;
  final_capture?: boolean;
  create_time?: string;
  update_time?: string;
  [key: string]: unknown;
}

/** A purchase unit on an order (subset used here). */
export interface PaypalPurchaseUnit {
  reference_id?: string;
  custom_id?: string;
  invoice_id?: string;
  description?: string;
  amount?: PaypalMoney;
  payments?: {
    captures?: PaypalCapture[];
  };
  [key: string]: unknown;
}

/** An order (create / get / capture responses share this shape). */
export interface PaypalOrder {
  id?: string;
  status?: string;
  intent?: string;
  purchase_units?: PaypalPurchaseUnit[];
  links?: PaypalLink[];
  create_time?: string;
  update_time?: string;
  [key: string]: unknown;
}

/** Request body for POST /v2/checkout/orders (verified fields). */
export interface PaypalCreateOrderRequest {
  intent: 'CAPTURE' | 'AUTHORIZE';
  purchase_units: PaypalPurchaseUnit[];
  /**
   * Redirect handoff URLs. Doc:
   * https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/standard/
   * (application_context.return_url / cancel_url).
   */
  application_context?: {
    return_url?: string;
    cancel_url?: string;
    brand_name?: string;
    locale?: string;
    user_action?: 'CONTINUE' | 'PAY_NOW';
  };
}

/** Refund response. Doc: /docs/api/payments/v2/ */
export interface PaypalRefund {
  id?: string;
  status?: string;
  amount?: PaypalMoney;
  create_time?: string;
  update_time?: string;
  [key: string]: unknown;
}

/**
 * PayPal error envelope. Doc: /api/rest/responses/ — errors carry
 * { name, message, debug_id, details: [{ field, issue, description }] }.
 */
export interface PaypalErrorResponse {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: Array<{
    field?: string;
    issue?: string;
    description?: string;
  }>;
  [key: string]: unknown;
}

// ============================================================================
// verify-on-return (primary confirmation path)
// ============================================================================

/** Params for {@link PaypalProvider.verifyPayment}. */
export interface VerifyPaymentParams {
  /** The PayPal order id returned to the redirect leg (`token` query param). */
  orderId: string;
  /** When provided, the captured amount (minor units) must equal this. */
  expectedAmountMinor?: number;
}

/**
 * Result of {@link PaypalProvider.verifyPayment}. `verified` is the only field
 * needed to gate a grant — true ONLY when the capture is COMPLETED AND
 * (no expected amount was given OR the amount matches). Field names mirror
 * payments-sumit's VerifyPaymentResult, extended with PayPal specifics.
 */
export interface VerifyPaymentResult {
  /** Single source of truth for granting: valid AND amount matches (if given). */
  verified: boolean;
  /** The order+capture reached COMPLETED. */
  valid: boolean;
  /** Whether the captured amount matched `expectedAmountMinor` (undefined when not given). */
  amountMatches?: boolean;
  /** Captured amount in minor units. */
  amountMinor?: number;
  /** ISO currency code of the capture. */
  currency?: string;
  /** External ref for our records: the PayPal order id. */
  externalRef?: string;
  /** The PayPal capture id (analogous to SUMIT's document number). */
  documentNumber?: string;
  /** Raw capture status (COMPLETED/PENDING/DECLINED/...). */
  captureStatus?: string;
  /** The raw PayPal order (post-capture) for the app to inspect. */
  order?: PaypalOrder;
  error?: string;
}

// ============================================================================
// Webhook signature verification (postback)
// ============================================================================

/**
 * Fields required by POST /v1/notifications/verify-webhook-signature.
 * Doc: https://developer.paypal.com/api/rest/webhooks/rest/ — each transmission
 * field is read from the matching incoming webhook header.
 */
export interface PaypalWebhookVerifyParams {
  /** `paypal-auth-algo` header (e.g. "SHA256withRSA"). */
  authAlgo: string;
  /** `paypal-cert-url` header. */
  certUrl: string;
  /** `paypal-transmission-id` header. */
  transmissionId: string;
  /** `paypal-transmission-sig` header. */
  transmissionSig: string;
  /** `paypal-transmission-time` header. */
  transmissionTime: string;
  /** The RAW parsed webhook event body, posted back EXACTLY as received. */
  webhookEvent: Record<string, unknown>;
}

/** Request body sent to the verify-webhook-signature endpoint. */
export interface PaypalVerifyWebhookRequest {
  auth_algo: string;
  cert_url: string;
  transmission_id: string;
  transmission_sig: string;
  transmission_time: string;
  webhook_id: string;
  webhook_event: Record<string, unknown>;
}

/** Response of the verify-webhook-signature endpoint. */
export interface PaypalVerifyWebhookResponse {
  /** "SUCCESS" when the signature is authentic, else "FAILURE". */
  verification_status?: 'SUCCESS' | 'FAILURE';
}

// ============================================================================
// Webhook event payload + normalized event set
// ============================================================================

/**
 * A PayPal webhook envelope. Doc: /api/rest/webhooks/event-names/ — every event
 * carries `id`, `event_type`, `resource_type`, `create_time`, `resource`.
 */
export interface PaypalWebhookPayload {
  id?: string;
  event_type?: string;
  resource_type?: string;
  create_time?: string;
  summary?: string;
  resource?: PaypalCapture & PaypalRefund & Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Normalized (unified) event set emitted by this adapter — the same vocabulary
 * payments-sumit uses so the app consumes both providers identically.
 */
export const PAYPAL_NORMALIZED_EVENTS = [
  'payment.succeeded',
  'payment.failed',
  'payment.refunded',
] as const;
export type PaypalNormalizedEvent = (typeof PAYPAL_NORMALIZED_EVENTS)[number];

/**
 * Raw PayPal webhook event types this adapter maps.
 * Doc: https://developer.paypal.com/api/rest/webhooks/event-names/
 */
export const PAYPAL_WEBHOOK_EVENT_MAP: Record<string, PaypalNormalizedEvent> = {
  'PAYMENT.CAPTURE.COMPLETED': 'payment.succeeded',
  'PAYMENT.CAPTURE.DENIED': 'payment.failed',
  'PAYMENT.CAPTURE.REFUNDED': 'payment.refunded',
  'PAYMENT.CAPTURE.REVERSED': 'payment.refunded',
};

/** Map a normalized event to a unified TransactionStatus (best-effort). */
export function mapEventToTransactionStatus(
  event: PaypalNormalizedEvent
): TransactionStatus | null {
  switch (event) {
    case 'payment.succeeded':
      return 'captured';
    case 'payment.failed':
      return 'failed';
    case 'payment.refunded':
      return 'fully_refunded';
    default:
      return null;
  }
}

// ============================================================================
// Error helper
// ============================================================================

/** Human-readable error from a PayPal error envelope + HTTP status. */
export function mapPaypalError(
  body: PaypalErrorResponse | undefined,
  httpStatus: number
): string {
  if (!body) return `PayPal request failed (HTTP ${httpStatus})`;
  const detail = body.details?.[0];
  const detailMsg = detail
    ? `${detail.issue ?? ''}${detail.description ? `: ${detail.description}` : ''}`.trim()
    : '';
  return (
    body.message ??
    (detailMsg || body.name) ??
    `PayPal request failed (HTTP ${httpStatus})`
  );
}
