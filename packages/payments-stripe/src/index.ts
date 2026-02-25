/**
 * @nehorai/payments-stripe - Stripe Provider for PaymentOS
 *
 * Provides StripeProvider and StripeWebhookHandler implementations
 * for the @nehorai/payments payment orchestration system.
 *
 * @example
 * ```ts
 * import { addStripeProvider } from '@nehorai/payments-stripe';
 *
 * // Register into existing PaymentServices
 * addStripeProvider(services, {
 *   secretKey: process.env.STRIPE_SECRET_KEY!,
 *   webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
 * });
 * ```
 */

export { StripeProvider } from './stripe-provider.js';
export { StripeWebhookHandler } from './stripe-webhook-handler.js';

export {
  STRIPE_STATUS_MAP,
  STRIPE_WEBHOOK_EVENTS,
  STRIPE_EVENT_ACTIONS,
  STRIPE_ERROR_MAP,
  STRIPE_SUPPORTED_CURRENCIES,
  DEFAULT_STRIPE_API_VERSION,
  mapStripeStatus,
  mapStripeError,
  isStripeSupportedCurrency,
  type StripePaymentIntentStatus,
  type StripeWebhookEventType,
  type StripeDeclineCode,
  type StripeConfig,
} from './stripe-types.js';

import { StripeProvider } from './stripe-provider.js';
import { StripeWebhookHandler } from './stripe-webhook-handler.js';
import type { StripeConfig } from './stripe-types.js';

/**
 * Service registry interface for provider registration.
 * Compatible with PaymentServices from @nehorai/payments.
 */
interface ProviderRegistry {
  providers: Map<string, unknown>;
  webhookHandlers: Map<string, unknown>;
}

/**
 * Register Stripe provider and webhook handler into a PaymentServices instance.
 *
 * @param services - PaymentServices instance to register into
 * @param config - Stripe configuration
 * @returns The same services object for chaining
 */
export function addStripeProvider<T extends ProviderRegistry>(
  services: T,
  config: StripeConfig
): T {
  services.providers.set('stripe', new StripeProvider(config));
  services.webhookHandlers.set('stripe', new StripeWebhookHandler(config));
  return services;
}
