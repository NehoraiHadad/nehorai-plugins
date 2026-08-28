/**
 * @nehorai/payments-paypal - PayPal (Orders v2) payment provider adapter
 *
 * Implements the @nehorai/payments IPaymentProvider contract for PayPal:
 * - one-time redirect checkout via Orders v2 (create order → approval link)
 * - verify-on-return confirmation (GET order → capture when approved)
 * - REAL refunds via Payments v2 (a genuine advantage over the SUMIT stub)
 * - async webhook signature verification (postback) + normalized event parsing
 *
 * Credits, plans, users and permissions are NOT handled here — that logic
 * belongs to the application's billing/domain layer.
 *
 * Every PayPal endpoint/field is verified against developer.paypal.com; the
 * verifying URL is cited in code comments next to each API call.
 */

// Provider & webhook handler
export { PaypalProvider } from './paypal-provider.js';
export { PaypalWebhookHandler } from './paypal-webhook-handler.js';

// Factory & verifier
export { addPaypalProvider, verifyPaypalSignature } from './factory.js';

// Config (env-driven, zod-validated)
export {
  PaypalProviderConfigSchema,
  paypalConfigFromEnv,
  resolveBaseUrl,
  PAYPAL_ENVIRONMENTS,
  PAYPAL_API_BASE_URLS,
} from './config.js';
export type { PaypalProviderConfig, PaypalEnvironment } from './config.js';

// Types
export type {
  PaypalMoney,
  PaypalTokenResponse,
  PaypalLink,
  PaypalCapture,
  PaypalPurchaseUnit,
  PaypalOrder,
  PaypalCreateOrderRequest,
  PaypalRefund,
  PaypalErrorResponse,
  PaypalOrderStatus,
  PaypalCaptureStatus,
  PaypalRefundStatus,
  VerifyPaymentParams,
  VerifyPaymentResult,
  PaypalWebhookVerifyParams,
  PaypalVerifyWebhookRequest,
  PaypalVerifyWebhookResponse,
  PaypalWebhookPayload,
  PaypalNormalizedEvent,
  // Subscriptions
  PaypalSubscriptionStatus,
  PaypalProduct,
  PaypalCreateProductRequest,
  PaypalPricingScheme,
  PaypalBillingCycle,
  PaypalPaymentPreferences,
  PaypalPlan,
  PaypalCreatePlanRequest,
  PaypalSubscriber,
  PaypalSubscriberName,
  PaypalLastPayment,
  PaypalSubscriptionBillingInfo,
  PaypalSubscription,
  PaypalSubscriptionApplicationContext,
  PaypalCreateSubscriptionRequest,
  PaypalReviseSubscriptionRequest,
  PaypalCreateSubscriptionExtra,
  PaypalSaleResource,
  PaypalSubscriptionResource,
  CreateProductParams,
  CreateProductResult,
  CreatePlanParams,
  CreatePlanResult,
  GetSubscriptionResult,
  ReviseSubscriptionResult,
  SubscriptionActionResult,
} from './paypal-types.js';

// Constants, money & mappers
export {
  PAYPAL_ENDPOINTS,
  PAYPAL_SUPPORTED_CURRENCIES,
  PAYPAL_ZERO_DECIMAL_CURRENCIES,
  PAYPAL_ORDER_STATUSES,
  PAYPAL_CAPTURE_STATUSES,
  PAYPAL_REFUND_STATUSES,
  PAYPAL_SUBSCRIPTION_STATUSES,
  PAYPAL_NORMALIZED_EVENTS,
  PAYPAL_WEBHOOK_EVENT_MAP,
  currencyExponent,
  minorToDecimalString,
  decimalStringToMinor,
  mapOrderStatusToTransactionStatus,
  mapCaptureStatusToTransactionStatus,
  mapRefundStatus,
  mapSubscriptionStatus,
  mapEventToTransactionStatus,
  mapPaypalError,
} from './paypal-types.js';
