/**
 * @nehorai/payments-nextjs - Token Webhook Route Handler Factory
 *
 * Creates a Next.js App Router POST handler for payment providers whose
 * webhooks are authenticated by a shared token in the URL query string
 * (e.g. SUMIT) rather than an HMAC signature header.
 *
 * Unlike createWebhookRouteHandler (whose processEvent is intentionally thin
 * and grants nothing), this factory hands the normalized event to an
 * application-supplied onEvent callback for idempotency + fulfilment.
 *
 * Usage:
 * ```typescript
 * // app/api/payments/webhooks/sumit/route.ts
 * export const POST = createTokenWebhookRouteHandler({
 *   services: getServices(),
 *   provider: 'sumit',
 *   getWebhookSecret,
 *   onEvent: fulfillFromEvent,
 * })
 * ```
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyWebhookSignature, type PaymentServices } from '@nehorai/payments'
import type { ParsedWebhookEvent } from '@nehorai/payments/providers'

export interface TokenWebhookHandlerOptions {
  services: PaymentServices
  /** Provider key whose webhook handler parses the payload (e.g. 'sumit'). */
  provider: string
  /** Returns the expected shared token for the provider (from server env). */
  getWebhookSecret: (provider: string) => string | undefined
  /**
   * Application grant callback — receives the normalized event. Do your
   * idempotency + fulfilment here. THROW to signal a retryable failure (→ 500);
   * return normally to acknowledge (→ 200).
   */
  onEvent: (event: ParsedWebhookEvent) => Promise<void>
  /** Query-string param holding the token. Default 'token'. */
  tokenQueryParam?: string
}

export function createTokenWebhookRouteHandler(options: TokenWebhookHandlerOptions) {
  return async function POST(request: NextRequest): Promise<NextResponse> {
    const { provider } = options
    const logPrefix = `[PAYMENT_WEBHOOK:token:${provider}]`

    try {
      // 1. Extract token from query string
      const token =
        new URL(request.url).searchParams.get(options.tokenQueryParam ?? 'token') ?? ''

      // 2. Get webhook secret
      const secret = options.getWebhookSecret(provider)
      if (!secret) {
        console.error(`${logPrefix} No webhook secret configured`)
        return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 })
      }

      // 3. Read raw body ONCE (the request stream is single-use)
      const rawBody = await request.text()

      // 4. Verify token (the SUMIT verifier constant-time-compares token vs secret)
      const verification = verifyWebhookSignature({
        provider,
        payload: rawBody,
        signature: token,
        secret,
      })

      if (!verification.valid) {
        console.warn(`${logPrefix} Invalid token: ${verification.error}`)
        return NextResponse.json({ error: 'Invalid webhook token' }, { status: 401 })
      }

      // 5. Parse body into an object (JSON first, then form-encoded fallback)
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(rawBody)
      } catch {
        payload = Object.fromEntries(new URLSearchParams(rawBody))
      }

      if (typeof payload !== 'object' || payload === null || Object.keys(payload).length === 0) {
        console.warn(`${logPrefix} Unparseable payload`)
        return NextResponse.json({ received: true, ignored: 'unparseable' }, { status: 200 })
      }

      // 6. Get webhook handler
      const handler = options.services.webhookHandlers.get(provider)
      if (!handler) {
        console.warn(`${logPrefix} No handler for provider`)
        return NextResponse.json({ received: true, ignored: 'no_handler' }, { status: 200 })
      }

      // 7. Parse event
      const parseResult = handler.parseEvent(payload)
      if (!parseResult.success || !parseResult.event) {
        console.warn(`${logPrefix} Parse failed: ${parseResult.error}`)
        return NextResponse.json({ received: true, ignored: 'parse' }, { status: 200 })
      }

      // 8. Hand the normalized event to the application
      try {
        await options.onEvent(parseResult.event)
      } catch (err) {
        console.error(`[PAYMENT_WEBHOOK:token:${provider}]`, err)
        return NextResponse.json({ error: 'internal' }, { status: 500 })
      }

      // 9. Acknowledge
      return NextResponse.json({ received: true }, { status: 200 })
    } catch (error) {
      console.error(`${logPrefix} Error:`, error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}
