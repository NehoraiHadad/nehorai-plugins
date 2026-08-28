/**
 * PayPal Provider Config (env-driven, zod-validated)
 *
 * Mirrors payments-sumit's config pattern (a plain provider-config object passed
 * to the constructor / factory) but adds a zod schema so an env-driven boot path
 * fails CLOSED when a secret is missing rather than silently constructing a
 * half-configured provider.
 *
 * SECURITY: Secrets have NO defaults. `clientId`/`clientSecret` are required and
 * `webhookId` (needed to verify webhook signatures) is optional only so a
 * checkout-only deployment can boot; the webhook verifier itself fails closed
 * when it is absent (see PaypalProvider.verifyWebhookSignature).
 */

import { z } from 'zod';

/** Which PayPal environment to target — selects the REST API base URL. */
export const PAYPAL_ENVIRONMENTS = ['sandbox', 'live'] as const;
export type PaypalEnvironment = (typeof PAYPAL_ENVIRONMENTS)[number];

/**
 * REST API base URLs.
 * Verified: https://developer.paypal.com/api/rest/production/ ("Change the base
 * URL ... from https://api-m.sandbox.paypal.com to https://api-m.paypal.com").
 */
export const PAYPAL_API_BASE_URLS: Record<PaypalEnvironment, string> = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

/**
 * Zod schema for the PayPal provider config. `environment` defaults to
 * `sandbox` (safe default); secrets are required with no default.
 */
export const PaypalProviderConfigSchema = z.object({
  /** PayPal REST app client id (server-side only). */
  clientId: z.string().min(1, 'PayPal clientId is required'),
  /** PayPal REST app client secret (server-side only). */
  clientSecret: z.string().min(1, 'PayPal clientSecret is required'),
  /** Target environment; selects the API base URL. Defaults to `sandbox`. */
  environment: z.enum(PAYPAL_ENVIRONMENTS).default('sandbox'),
  /**
   * Webhook id from the PayPal dashboard, required to verify webhook signatures
   * via the postback endpoint. Optional so a checkout-only app can boot; the
   * verifier fails closed if it is missing.
   */
  webhookId: z.string().min(1).optional(),
  /** Override the API base URL (test/staging). Defaults per `environment`. */
  baseUrl: z.string().url().optional(),
});

export type PaypalProviderConfig = z.infer<typeof PaypalProviderConfigSchema>;

/**
 * Build + validate a PayPal config from an environment map (defaults to
 * `process.env`). Throws a ZodError (fail closed) when a required secret is
 * missing or `PAYPAL_ENV` is not `sandbox`/`live`.
 *
 * Expected env vars:
 *  - `PAYPAL_CLIENT_ID`     (required)
 *  - `PAYPAL_CLIENT_SECRET` (required)
 *  - `PAYPAL_ENV`           (`sandbox` | `live`, default `sandbox`)
 *  - `PAYPAL_WEBHOOK_ID`    (required to verify webhooks)
 */
export function paypalConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): PaypalProviderConfig {
  return PaypalProviderConfigSchema.parse({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    // Leave undefined (not '') so the schema default applies when unset.
    environment: env.PAYPAL_ENV || undefined,
    webhookId: env.PAYPAL_WEBHOOK_ID || undefined,
  });
}

/** Resolve the effective API base URL for a validated config. */
export function resolveBaseUrl(config: PaypalProviderConfig): string {
  return config.baseUrl ?? PAYPAL_API_BASE_URLS[config.environment];
}
