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

import type {
  TransactionStatus,
  SubscriptionStatus,
  SubscriptionInterval,
} from '@nehorai/payments/types';

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

  // --------------------------------------------------------------------------
  // Subscriptions surface (Catalog Products v1 + Subscriptions v1)
  // --------------------------------------------------------------------------

  /**
   * Create a catalog product (the "what is billed" behind a plan).
   * POST /v1/catalogs/products → 201.
   * Doc: https://developer.paypal.com/docs/api/catalog-products/v1/#products_create
   */
  CREATE_PRODUCT: '/v1/catalogs/products',
  /**
   * Create a billing plan (price + cadence for a product).
   * POST /v1/billing/plans → 201.
   * Doc: https://developer.paypal.com/docs/api/subscriptions/v1/#plans_create
   */
  CREATE_PLAN: '/v1/billing/plans',
  /**
   * Show plan details. GET /v1/billing/plans/{id}.
   * Doc: https://developer.paypal.com/docs/api/subscriptions/v1/#plans_get
   */
  getPlan: (planId: string) => `/v1/billing/plans/${planId}`,
  /**
   * Create a subscription. POST /v1/billing/subscriptions → 201; returns the
   * subscription id (`I-...`) + a buyer-approval link (rel approve/payer-action).
   * Doc: https://developer.paypal.com/docs/api/subscriptions/v1/#subscriptions_create
   */
  CREATE_SUBSCRIPTION: '/v1/billing/subscriptions',
  /**
   * Show subscription details. GET /v1/billing/subscriptions/{id}.
   * Doc: https://developer.paypal.com/docs/api/subscriptions/v1/#subscriptions_get
   */
  getSubscription: (id: string) => `/v1/billing/subscriptions/${id}`,
  /**
   * Cancel a subscription. POST /v1/billing/subscriptions/{id}/cancel → 204
   * (No Content); body { reason }.
   * Doc: https://developer.paypal.com/docs/api/subscriptions/v1/#subscriptions_cancel
   */
  cancelSubscription: (id: string) => `/v1/billing/subscriptions/${id}/cancel`,
  /**
   * Suspend a subscription. POST /v1/billing/subscriptions/{id}/suspend → 204;
   * body { reason }.
   * Doc: https://developer.paypal.com/docs/api/subscriptions/v1/#subscriptions_suspend
   */
  suspendSubscription: (id: string) =>
    `/v1/billing/subscriptions/${id}/suspend`,
  /**
   * Activate a suspended subscription. POST /v1/billing/subscriptions/{id}/activate
   * → 204; body { reason }.
   * Doc: https://developer.paypal.com/docs/api/subscriptions/v1/#subscriptions_activate
   */
  activateSubscription: (id: string) =>
    `/v1/billing/subscriptions/${id}/activate`,
  /**
   * Revise (change plan / quantity) a subscription.
   * POST /v1/billing/subscriptions/{id}/revise → 200; returns the updated
   * subscription with an `approve` link when buyer re-approval is required.
   * Doc: https://developer.paypal.com/docs/api/subscriptions/v1/#subscriptions_revise
   */
  reviseSubscription: (id: string) => `/v1/billing/subscriptions/${id}/revise`,
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

/**
 * PayPal subscription status values.
 * Doc: https://developer.paypal.com/docs/api/subscriptions/v1/#subscriptions_get
 *  - APPROVAL_PENDING: created; buyer has NOT yet approved (redirect required).
 *  - APPROVED: buyer approved; activation pending (first charge not settled yet).
 *  - ACTIVE: actively billing.
 *  - SUSPENDED: paused; can be re-activated.
 *  - CANCELLED: canceled (terminal).
 *  - EXPIRED: reached total_cycles / lapsed (terminal).
 */
export const PAYPAL_SUBSCRIPTION_STATUSES = [
  'APPROVAL_PENDING',
  'APPROVED',
  'ACTIVE',
  'SUSPENDED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type PaypalSubscriptionStatus =
  (typeof PAYPAL_SUBSCRIPTION_STATUSES)[number];

/**
 * Map a PayPal subscription status to the unified {@link SubscriptionStatus}.
 * NOTE: when the create response is still `APPROVAL_PENDING`/`APPROVED`, the
 * caller must send the buyer to the returned `redirectUrl` — a present
 * `redirectUrl` means "buyer approval still required" and the subscription is
 * NOT yet billing. Only `ACTIVE` (confirmed via the ACTIVATED webhook / a GET)
 * is safe to grant on.
 */
export function mapSubscriptionStatus(
  status: string | undefined
): SubscriptionStatus {
  switch (status) {
    case 'ACTIVE':
      return 'active';
    case 'SUSPENDED':
      return 'paused';
    case 'CANCELLED':
    case 'EXPIRED':
      return 'canceled';
    case 'APPROVAL_PENDING':
    case 'APPROVED':
      // Not yet billing — buyer approval / activation still pending. `past_due`
      // is the closest not-yet-active bucket in the unified vocabulary.
      return 'past_due';
    default:
      return 'past_due';
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

// ============================================================================
// Subscriptions: Catalog Product → Billing Plan → Subscription
// ============================================================================

/**
 * A catalog product. Doc: /docs/api/catalog-products/v1/#products_create
 * Only `name` + `type` are required; `id` is server-generated (`PROD-...`)
 * unless supplied.
 */
export interface PaypalProduct {
  id?: string;
  name?: string;
  /** PHYSICAL | DIGITAL | SERVICE (defaults to SERVICE for subscriptions). */
  type?: string;
  description?: string;
  category?: string;
  create_time?: string;
  links?: PaypalLink[];
  [key: string]: unknown;
}

/** Request body for POST /v1/catalogs/products (verified fields). */
export interface PaypalCreateProductRequest {
  name: string;
  type: 'PHYSICAL' | 'DIGITAL' | 'SERVICE';
  description?: string;
  category?: string;
}

/**
 * A plan pricing scheme. Doc: /docs/api/subscriptions/v1/#plans_create
 * `fixed_price` carries the per-cycle amount in the standard money shape.
 */
export interface PaypalPricingScheme {
  fixed_price?: PaypalMoney;
  [key: string]: unknown;
}

/**
 * A billing cycle on a plan. Doc: /docs/api/subscriptions/v1/#plans_create
 *  - `frequency.interval_unit` (DAY|WEEK|MONTH|YEAR) + `interval_count`.
 *  - `tenure_type` REGULAR (paid) or TRIAL.
 *  - `sequence` orders the cycles; `total_cycles` 0 ⇒ infinite (open-ended).
 */
export interface PaypalBillingCycle {
  frequency?: {
    interval_unit?: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
    interval_count?: number;
  };
  tenure_type?: 'REGULAR' | 'TRIAL';
  sequence?: number;
  /** 0 ⇒ bill forever until canceled (open-ended subscription). */
  total_cycles?: number;
  pricing_scheme?: PaypalPricingScheme;
}

/** Plan payment preferences. Doc: /docs/api/subscriptions/v1/#plans_create */
export interface PaypalPaymentPreferences {
  auto_bill_outstanding?: boolean;
  setup_fee?: PaypalMoney;
  setup_fee_failure_action?: 'CONTINUE' | 'CANCEL';
  payment_failure_threshold?: number;
}

/** A billing plan (create/get responses). `id` is `P-...`. */
export interface PaypalPlan {
  id?: string;
  product_id?: string;
  name?: string;
  status?: string;
  description?: string;
  billing_cycles?: PaypalBillingCycle[];
  payment_preferences?: PaypalPaymentPreferences;
  create_time?: string;
  links?: PaypalLink[];
  [key: string]: unknown;
}

/** Request body for POST /v1/billing/plans (verified fields). */
export interface PaypalCreatePlanRequest {
  product_id: string;
  name: string;
  /** Default ACTIVE; pass explicitly for clarity. */
  status?: 'CREATED' | 'ACTIVE' | 'INACTIVE';
  description?: string;
  billing_cycles: PaypalBillingCycle[];
  payment_preferences: PaypalPaymentPreferences;
}

/** Subscriber name (subset). */
export interface PaypalSubscriberName {
  given_name?: string;
  surname?: string;
}

/** Subscriber on a subscription. */
export interface PaypalSubscriber {
  email_address?: string;
  name?: PaypalSubscriberName;
  payer_id?: string;
  [key: string]: unknown;
}

/**
 * The most recent successful payment on a subscription (under billing_info).
 * `amount` uses the standard money shape (currency_code + value).
 */
export interface PaypalLastPayment {
  amount?: PaypalMoney;
  time?: string;
  [key: string]: unknown;
}

/**
 * Subscription billing info. Doc: /docs/api/subscriptions/v1/#subscriptions_get
 *  - `next_billing_time`: next scheduled charge (⇒ currentPeriodEnd).
 *  - `last_payment`: the most recent successful charge.
 */
export interface PaypalSubscriptionBillingInfo {
  next_billing_time?: string;
  last_payment?: PaypalLastPayment;
  final_payment_time?: string;
  failed_payments_count?: number;
  [key: string]: unknown;
}

/**
 * A subscription (create / get / revise responses). `id` is `I-...`.
 * Doc: /docs/api/subscriptions/v1/#subscriptions_get
 */
export interface PaypalSubscription {
  id?: string;
  status?: string;
  status_update_time?: string;
  plan_id?: string;
  /** Our app-side subscription id, echoed back for reconciliation. */
  custom_id?: string;
  start_time?: string;
  subscriber?: PaypalSubscriber;
  billing_info?: PaypalSubscriptionBillingInfo;
  create_time?: string;
  update_time?: string;
  links?: PaypalLink[];
  [key: string]: unknown;
}

/**
 * The subscription `application_context` (redirect + approval UX).
 * Doc: /docs/api/subscriptions/v1/#subscriptions_create
 */
export interface PaypalSubscriptionApplicationContext {
  brand_name?: string;
  locale?: string;
  /** NO_SHIPPING for digital goods (default here). */
  shipping_preference?: 'GET_FROM_FILE' | 'NO_SHIPPING' | 'SET_PROVIDED_ADDRESS';
  /** SUBSCRIBE_NOW makes the approve button finalize the subscription. */
  user_action?: 'CONTINUE' | 'SUBSCRIBE_NOW';
  return_url?: string;
  cancel_url?: string;
}

/** Request body for POST /v1/billing/subscriptions (verified fields). */
export interface PaypalCreateSubscriptionRequest {
  plan_id: string;
  custom_id?: string;
  subscriber?: PaypalSubscriber;
  application_context?: PaypalSubscriptionApplicationContext;
}

/** Request body for POST /v1/billing/subscriptions/{id}/revise. */
export interface PaypalReviseSubscriptionRequest {
  plan_id?: string;
  application_context?: PaypalSubscriptionApplicationContext;
}

/**
 * PayPal-specific extras for {@link PaypalProvider.createSubscription}, merged
 * onto the core {@link CreateSubscriptionParams}. The plan (its `paypalPlanId`)
 * drives the price + cadence — the core `params.amount` is NOT used to price a
 * PayPal subscription (see the method doc).
 */
export interface PaypalCreateSubscriptionExtra {
  /** The PayPal billing plan id (`P-...`) to subscribe to. Required. */
  paypalPlanId: string;
  /** Our app-side subscription id → `custom_id`, echoed back on the resource. */
  customId: string;
  /** Buyer cancel/return-to-app URL (application_context.cancel_url). */
  cancelUrl?: string;
  /** Brand shown on the PayPal approval page (application_context.brand_name). */
  brandName?: string;
  /** Pre-fill the subscriber email on the approval page. */
  subscriberEmail?: string;
}

/** Params for {@link PaypalProvider.createProduct}. */
export interface CreateProductParams {
  name: string;
  /** Defaults to SERVICE (the usual choice for subscriptions). */
  type?: 'PHYSICAL' | 'DIGITAL' | 'SERVICE';
  category?: string;
  description?: string;
}

/** Result of {@link PaypalProvider.createProduct}. */
export interface CreateProductResult {
  success: boolean;
  /** Created product id (`PROD-...`). */
  productId?: string;
  product?: PaypalProduct;
  error?: string;
  errorCode?: string;
}

/** Params for {@link PaypalProvider.createPlan} (monthly regular cycle). */
export interface CreatePlanParams {
  productId: string;
  name: string;
  /** Per-cycle price in minor units. */
  amountMinor: number;
  currency: string;
  /** Billing interval (default: monthly). */
  interval?: SubscriptionInterval;
  /** Number of cycles before the plan ends; 0/omit ⇒ open-ended. */
  totalCycles?: number;
  description?: string;
}

/** Result of {@link PaypalProvider.createPlan}. */
export interface CreatePlanResult {
  success: boolean;
  /** Created plan id (`P-...`). */
  planId?: string;
  plan?: PaypalPlan;
  error?: string;
  errorCode?: string;
}

/** Result of {@link PaypalProvider.getSubscription}. */
export interface GetSubscriptionResult {
  success: boolean;
  subscription?: PaypalSubscription;
  error?: string;
}

/** Result of {@link PaypalProvider.reviseSubscription}. */
export interface ReviseSubscriptionResult {
  success: boolean;
  subscription?: PaypalSubscription;
  /** Present when the plan change needs buyer re-approval (rel approve link). */
  redirectUrl?: string;
  status?: SubscriptionStatus;
  error?: string;
  errorCode?: string;
}

/** Result of the simple suspend/activate subscription actions. */
export interface SubscriptionActionResult {
  success: boolean;
  error?: string;
  errorCode?: string;
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
 * The `resource` object of a PAYMENT.SALE.COMPLETED webhook — the RECURRING
 * subscription charge. This is the DEPRECATED Payments v1 "sale" shape, so its
 * money field is `amount.total` + `amount.currency` (NOT `value`/`currency_code`
 * like the v2 capture shape), and the owning subscription id is carried in
 * `billing_agreement_id`.
 * Doc: https://developer.paypal.com/api/deprecated/payments/v1/sale-get/
 */
export interface PaypalSaleResource {
  id?: string;
  state?: string;
  /** v1 money shape: total + currency (decimal string + ISO code). */
  amount?: { total?: string; currency?: string; [key: string]: unknown };
  /** The subscription (`I-...`) / billing-agreement this recurring sale belongs to. */
  billing_agreement_id?: string;
  custom?: string;
  parent_payment?: string;
  create_time?: string;
  [key: string]: unknown;
}

/**
 * The `resource` object of a BILLING.SUBSCRIPTION.* webhook — its `id` is the
 * subscription id (`I-...`). Shares the {@link PaypalSubscription} shape.
 * Doc: /api/rest/webhooks/event-names/#link-billingplansandsubscriptions
 */
export type PaypalSubscriptionResource = PaypalSubscription;

/**
 * A PayPal webhook envelope. Doc: /api/rest/webhooks/event-names/ — every event
 * carries `id`, `event_type`, `resource_type`, `create_time`, `resource`. The
 * `resource` union spans capture (v2), refund, recurring sale (v1) and
 * subscription payloads; consumers narrow by `event_type`.
 */
export interface PaypalWebhookPayload {
  id?: string;
  event_type?: string;
  resource_type?: string;
  create_time?: string;
  summary?: string;
  resource?: PaypalCapture &
    PaypalRefund &
    Partial<PaypalSaleResource> &
    Partial<PaypalSubscriptionResource> &
    Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Normalized (unified) event set emitted by this adapter — the same vocabulary
 * payments-sumit uses so the app consumes both providers identically. The
 * `subscription.renewed` / `subscription.canceled` / `subscription.payment_failed`
 * names are REUSED verbatim from payments-sumit so the app shares handler logic.
 */
export const PAYPAL_NORMALIZED_EVENTS = [
  'payment.succeeded',
  'payment.failed',
  'payment.refunded',
  'subscription.activated',
  'subscription.renewed',
  'subscription.canceled',
  'subscription.suspended',
  'subscription.expired',
  'subscription.payment_failed',
] as const;
export type PaypalNormalizedEvent = (typeof PAYPAL_NORMALIZED_EVENTS)[number];

/**
 * Raw PayPal webhook event types this adapter maps.
 * Doc: https://developer.paypal.com/api/rest/webhooks/event-names/
 *
 * The recurring CHARGE arrives as `PAYMENT.SALE.COMPLETED` (the v1 sale event),
 * which carries the subscription id in `resource.billing_agreement_id` — the
 * BILLING.SUBSCRIPTION.* lifecycle events do NOT represent a money movement.
 */
export const PAYPAL_WEBHOOK_EVENT_MAP: Record<string, PaypalNormalizedEvent> = {
  'PAYMENT.CAPTURE.COMPLETED': 'payment.succeeded',
  'PAYMENT.CAPTURE.DENIED': 'payment.failed',
  'PAYMENT.CAPTURE.REFUNDED': 'payment.refunded',
  'PAYMENT.CAPTURE.REVERSED': 'payment.refunded',
  // Subscription lifecycle (resource.id = subscription id `I-...`).
  'BILLING.SUBSCRIPTION.ACTIVATED': 'subscription.activated',
  'BILLING.SUBSCRIPTION.CANCELLED': 'subscription.canceled',
  'BILLING.SUBSCRIPTION.SUSPENDED': 'subscription.suspended',
  'BILLING.SUBSCRIPTION.EXPIRED': 'subscription.expired',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED': 'subscription.payment_failed',
  // The recurring charge itself (resource.billing_agreement_id = subscription id).
  'PAYMENT.SALE.COMPLETED': 'subscription.renewed',
};

/** Map a normalized event to a unified TransactionStatus (best-effort). */
export function mapEventToTransactionStatus(
  event: PaypalNormalizedEvent
): TransactionStatus | null {
  switch (event) {
    case 'payment.succeeded':
    case 'subscription.renewed':
      return 'captured';
    case 'payment.failed':
    case 'subscription.payment_failed':
      return 'failed';
    case 'payment.refunded':
      return 'fully_refunded';
    case 'subscription.canceled':
    case 'subscription.expired':
      return 'voided';
    // Lifecycle-only signals with no money movement / no transaction status.
    case 'subscription.activated':
    case 'subscription.suspended':
      return null;
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
