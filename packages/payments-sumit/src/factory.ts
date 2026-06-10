/**
 * SUMIT Provider Factory
 *
 * Registers the SUMIT provider + webhook handler into a PaymentServices
 * instance (same pattern as addStripeProvider / addIsraeliProviders) and
 * installs the SUMIT signature verifier.
 *
 * SUMIT has no HMAC, so the "signature" is a shared token carried in the
 * webhook URL; the verifier simply compares it (constant-time) to the secret.
 */

import { timingSafeEqual } from 'crypto';
import {
  registerSignatureVerifier,
  type SignatureVerificationResult,
} from '@nehorai/payments';
import { SumitProvider } from './sumit-provider.js';
import { SumitWebhookHandler } from './sumit-webhook-handler.js';
import type { SumitProviderConfig } from './sumit-types.js';

/**
 * Service registry interface for provider registration.
 * Compatible with PaymentServices from @nehorai/payments.
 */
interface ProviderRegistry {
  providers: Map<string, unknown>;
  webhookHandlers: Map<string, unknown>;
}

/**
 * SUMIT "signature" verifier: constant-time equality of the URL token against
 * the configured webhook token. There is no cryptographic signature to verify.
 */
export function verifySumitToken(
  _payload: string,
  signature: string,
  secret: string
): SignatureVerificationResult {
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(secret);
    const valid = a.length === b.length && timingSafeEqual(a, b);
    return valid ? { valid: true } : { valid: false, error: 'Invalid webhook token' };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Verification failed',
    };
  }
}

/**
 * Register the SUMIT payment provider into a PaymentServices instance.
 *
 * @example
 * ```typescript
 * import { createPaymentServices } from '@nehorai/payments';
 * import { addSumitProvider } from '@nehorai/payments-sumit';
 *
 * const services = createPaymentServices({ providers: new Map() });
 *
 * addSumitProvider(services, {
 *   companyId: Number(process.env.SUMIT_COMPANY_ID_TEST),
 *   apiKey: process.env.SUMIT_API_KEY_TEST!,
 *   webhookToken: process.env.SUMIT_WEBHOOK_TOKEN_TEST,
 * });
 * ```
 */
export function addSumitProvider<T extends ProviderRegistry>(
  services: T,
  config: SumitProviderConfig
): T {
  const provider = new SumitProvider(config);
  services.providers.set('sumit', provider);
  services.webhookHandlers.set('sumit', new SumitWebhookHandler(provider));
  registerSignatureVerifier('sumit', verifySumitToken);
  return services;
}
