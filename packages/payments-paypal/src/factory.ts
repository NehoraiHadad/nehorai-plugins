/**
 * PayPal Provider Factory
 *
 * Registers the PayPal provider + webhook handler into a PaymentServices
 * instance (same pattern as addSumitProvider / addStripeProvider).
 *
 * NOTE ON SIGNATURE VERIFICATION: PayPal webhook authenticity requires an ASYNC
 * postback to /v1/notifications/verify-webhook-signature using five transmission
 * headers + the webhook id. The synchronous `(payload, signature, secret)`
 * verifier registry cannot express that, so the registered verifier fails CLOSED
 * and the receiving route MUST instead call
 * `PaypalProvider.verifyWebhookSignature(params)` (async) before trusting an event.
 */

import {
  registerSignatureVerifier,
  type SignatureVerificationResult,
} from '@nehorai/payments';
import { PaypalProvider } from './paypal-provider.js';
import { PaypalWebhookHandler } from './paypal-webhook-handler.js';
import { PaypalProviderConfigSchema, type PaypalProviderConfig } from './config.js';

/**
 * Service registry interface for provider registration.
 * Compatible with PaymentServices from @nehorai/payments.
 */
interface ProviderRegistry {
  providers: Map<string, unknown>;
  webhookHandlers: Map<string, unknown>;
}

/**
 * PayPal signature verifier registered in the sync registry. PayPal cannot be
 * verified synchronously, so this ALWAYS fails closed and points callers to the
 * async provider method. It never accepts an unverified webhook.
 */
export function verifyPaypalSignature(
  _payload: string,
  _signature: string,
  _secret: string
): SignatureVerificationResult {
  return {
    valid: false,
    error:
      'PayPal webhooks require async verification: call PaypalProvider.verifyWebhookSignature() instead of the sync verifier.',
  };
}

/**
 * Register the PayPal payment provider into a PaymentServices instance.
 *
 * @example
 * ```typescript
 * import { createPaymentServices } from '@nehorai/payments';
 * import { addPaypalProvider } from '@nehorai/payments-paypal';
 * import { paypalConfigFromEnv } from '@nehorai/payments-paypal';
 *
 * const services = createPaymentServices({ providers: new Map() });
 * addPaypalProvider(services, paypalConfigFromEnv());
 * ```
 */
export function addPaypalProvider<T extends ProviderRegistry>(
  services: T,
  config: PaypalProviderConfig
): T {
  // Validate (+ apply defaults) up front so registration fails closed.
  const validated = PaypalProviderConfigSchema.parse(config);
  const provider = new PaypalProvider(validated);
  services.providers.set('paypal', provider);
  services.webhookHandlers.set('paypal', new PaypalWebhookHandler(provider));
  registerSignatureVerifier('paypal', verifyPaypalSignature);
  return services;
}
