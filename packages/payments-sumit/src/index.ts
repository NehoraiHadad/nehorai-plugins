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

// Types
export type {
  SumitProviderConfig,
  SumitCredentials,
  SumitResponse,
  SumitCustomer,
  SumitLineItem,
  SumitBeginRedirectRequest,
  SumitBeginRedirectData,
  SumitPaymentData,
  SumitRecurringData,
  SumitWebhookPayload,
  SumitNormalizedEvent,
} from './sumit-types.js';

// Constants & mappers
export {
  SUMIT_API_BASE,
  SUMIT_ENDPOINTS,
  SUMIT_SUPPORTED_CURRENCIES,
  SUMIT_STATUS_OK,
  SUMIT_WEBHOOK_EVENTS,
  buildCredentials,
  toBool,
  pick,
  mapSumitStatusToTransactionStatus,
  mapEventToTransactionStatus,
  mapEventToSubscriptionStatus,
  mapSumitError,
} from './sumit-types.js';
