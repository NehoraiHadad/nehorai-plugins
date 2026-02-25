/**
 * Israeli Payment Providers Factory
 *
 * Convenience function to register Hyp and Cardcom providers
 * into an existing PaymentServices instance.
 *
 * Follows the same pattern as @nehorai/payments-stripe's addStripeProvider.
 */

import type { HypConfig } from './providers/hyp/hyp-types.js';
import type { CardcomProviderConfig } from './providers/cardcom/cardcom-provider.js';
import { HypProvider } from './providers/hyp/hyp-provider.js';
import { CardcomProvider } from './providers/cardcom/cardcom-provider.js';
import { HypWebhookHandler } from './providers/hyp/hyp-webhook-handler.js';
import { CardcomWebhookHandler } from './providers/cardcom/cardcom-webhook-handler.js';

/**
 * Service registry interface for provider registration.
 * Compatible with PaymentServices from @nehorai/payments.
 */
interface ProviderRegistry {
  providers: Map<string, unknown>;
  webhookHandlers: Map<string, unknown>;
}

/**
 * Configuration for adding Israeli providers
 */
export interface IsraeliProvidersConfig {
  hyp?: HypConfig;
  cardcom?: CardcomProviderConfig;
}

/**
 * Register Israeli payment providers into a PaymentServices instance.
 *
 * Mutates the services Maps in-place (same pattern as addStripeProvider).
 * Only registers providers for which configuration is provided.
 *
 * @param services - PaymentServices instance to register into
 * @param config - Israeli providers configuration
 * @returns The same services object for chaining
 *
 * @example
 * ```typescript
 * import { createPaymentServices } from '@nehorai/payments';
 * import { addIsraeliProviders, ISRAELI_ROUTING_RULES } from '@nehorai/payments-il';
 *
 * const services = createPaymentServices({
 *   providers: new Map(),
 *   routingRules: ISRAELI_ROUTING_RULES,
 * });
 *
 * addIsraeliProviders(services, {
 *   hyp: {
 *     terminalNumber: '123',
 *     user: 'user',
 *     password: 'pass',
 *     environment: 'sandbox',
 *   },
 *   cardcom: {
 *     terminalNumber: '456',
 *     apiName: 'api',
 *     apiPassword: 'pass',
 *   },
 * });
 * ```
 */
export function addIsraeliProviders<T extends ProviderRegistry>(
  services: T,
  config: IsraeliProvidersConfig
): T {
  if (config.hyp) {
    services.providers.set('hyp', new HypProvider(config.hyp));
    services.webhookHandlers.set('hyp', new HypWebhookHandler());
  }

  if (config.cardcom) {
    services.providers.set('cardcom', new CardcomProvider(config.cardcom));
    services.webhookHandlers.set('cardcom', new CardcomWebhookHandler());
  }

  return services;
}
