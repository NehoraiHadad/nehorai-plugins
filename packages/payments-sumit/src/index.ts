/**
 * @nehorai/payments-sumit - SUMIT (UPAY) payment provider adapter
 *
 * Implements the @nehorai/payments provider contracts for SUMIT:
 * - one-time hosted-redirect checkout (IPaymentProvider)
 * - recurring standing orders / subscriptions (ISubscriptionProvider)
 * - normalized webhook events with stable, idempotent event ids (IWebhookHandler)
 *
 * Credits, plans, users and permissions are NOT handled here — that logic
 * belongs to the application's billing/domain layer. See docs/billing-sumit.md.
 *
 * @example
 * ```typescript
 * import { createPaymentServices } from '@nehorai/payments';
 * import { addSumitProvider } from '@nehorai/payments-sumit';
 *
 * const services = createPaymentServices({ providers: new Map() });
 * addSumitProvider(services, {
 *   companyId: 12345,
 *   apiKey: process.env.SUMIT_API_KEY_TEST!,
 *   webhookToken: process.env.SUMIT_WEBHOOK_TOKEN_TEST,
 * });
 * ```
 */

// Provider & webhook handler
export { SumitProvider } from './sumit-provider.js';
export { SumitWebhookHandler } from './sumit-webhook-handler.js';

// Factory & verifier
export { addSumitProvider, verifySumitToken } from './factory.js';

// Hosted Payment Pages — subscription page URL helpers (pure, no network)
export {
  buildSubscriptionPageUrl,
  parseSubscriptionReturn,
} from './subscription-page-url.js';
export type {
  BuildSubscriptionPageUrlParams,
  ParsedSubscriptionReturn,
  SubscriptionReturnQuery,
} from './subscription-page-url.js';

// Types
export type {
  SumitProviderConfig,
  SumitCredentials,
  SumitResponse,
  SumitCustomer,
  SumitItem,
  SumitChargeItem,
  SumitRecurringItem,
  SumitBeginRedirectItem,
  SumitBeginRedirectRequest,
  SumitBeginRedirectData,
  SumitPayment,
  SumitGetPaymentData,
  SumitRecurringChargeRequest,
  SumitRecurringChargeData,
  SumitCreateSubscriptionExtra,
  SumitCancelSubscriptionExtra,
  SumitSubscriptionResultExtra,
  SumitWebhookPayload,
  SumitNormalizedEvent,
  VerifyPaymentParams,
  VerifyPaymentResult,
} from './sumit-types.js';

// Constants & mappers
export {
  SUMIT_API_BASE,
  SUMIT_ENDPOINTS,
  SUMIT_SUPPORTED_CURRENCIES,
  SUMIT_CURRENCY_CODES,
  SUMIT_WEBHOOK_EVENTS,
  buildCredentials,
  isSumitSuccess,
  toBool,
  pick,
  mapSumitStatusToTransactionStatus,
  mapEventToTransactionStatus,
  mapSumitError,
} from './sumit-types.js';
