/**
 * @nehorai/payments-nextjs - Main Entry Point
 *
 * Next.js App Router integration for @nehorai/payments.
 * Provides route handler factories and server action factories.
 *
 * Quick Start:
 * ```typescript
 * // src/app/api/payments/webhooks/[provider]/route.ts
 * import { createWebhookRouteHandler } from '@nehorai/payments-nextjs/handlers'
 * import { getServices, getWebhookSecret } from '@/lib/payments'
 *
 * const handler = createWebhookRouteHandler({
 *   services: getServices(),
 *   getWebhookSecret,
 * })
 *
 * export const POST = handler
 * ```
 */

// Auth
export type { IPaymentsAuthProvider, PaymentsUser } from './auth/index.js'

// Handlers
export {
  createWebhookRouteHandler,
  createIntentsRouteHandler,
  createConfirmRouteHandler,
  createCaptureRouteHandler,
  createVoidRouteHandler,
  createMethodsRouteHandler,
  createTransactionsRouteHandler,
  createProvidersRouteHandler,
  createHealthRouteHandler,
  type WebhookHandlerOptions,
  type IntentsHandlerOptions,
  type ConfirmHandlerOptions,
  type CaptureHandlerOptions,
  type VoidHandlerOptions,
  type MethodsHandlerOptions,
  type TransactionsHandlerOptions,
  type ProvidersHandlerOptions,
  type ProviderDisplayInfo,
  type HealthHandlerOptions,
} from './handlers/index.js'

// Actions
export {
  createInitiatePaymentAction,
  createCapturePaymentAction,
  type InitiatePaymentInput,
  type InitiatePaymentResult,
  type InitiateActionOptions,
  type CapturePaymentInput,
  type CapturePaymentResult,
  type CaptureActionOptions,
} from './actions/index.js'
