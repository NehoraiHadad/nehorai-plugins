/**
 * @nehorai/payments-nextjs - Webhook Route Handler Factory
 *
 * Creates a Next.js App Router POST handler for processing
 * payment provider webhooks with signature verification.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  verifyWebhookSignature,
  getSignatureHeaderName,
  type PaymentServices,
  type PaymentProvider,
} from '@nehorai/payments'

export interface WebhookHandlerOptions {
  /** Payment services instance */
  services: PaymentServices
  /** Get webhook secret for a given provider */
  getWebhookSecret: (provider: string) => string | undefined
  /** Valid provider names (defaults to keys from services.providers) */
  validProviders?: string[]
}

export function createWebhookRouteHandler(options: WebhookHandlerOptions) {
  return async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ provider: string }> }
  ): Promise<NextResponse> {
    const { provider: providerParam } = await params
    const provider = providerParam as PaymentProvider
    const logPrefix = `[PAYMENT_WEBHOOK:${provider}]`

    try {
      // 1. Validate provider
      const validProviders = options.validProviders ?? [...options.services.providers.keys()]
      if (!validProviders.includes(provider)) {
        console.warn(`${logPrefix} Invalid provider`)
        return NextResponse.json({ error: 'Invalid provider' }, { status: 400 })
      }

      // 2. Get raw body for signature verification
      const rawBody = await request.text()
      if (!rawBody) {
        console.warn(`${logPrefix} Empty request body`)
        return NextResponse.json({ error: 'Empty request body' }, { status: 400 })
      }

      // 3. Get signature from headers
      const signatureHeader = getSignatureHeaderName(provider)
      const signature = request.headers.get(signatureHeader) ?? ''

      if (!signature) {
        console.warn(`${logPrefix} Missing signature header`)
        return NextResponse.json({ error: 'Missing signature' }, { status: 401 })
      }

      // 4. Get webhook secret
      const secret = options.getWebhookSecret(provider)
      if (!secret) {
        console.error(`${logPrefix} No webhook secret configured`)
        return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 })
      }

      // 5. Verify signature
      const verification = verifyWebhookSignature({
        provider,
        payload: rawBody,
        signature,
        secret,
      })

      if (!verification.valid) {
        console.warn(`${logPrefix} Invalid signature: ${verification.error}`)
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
      }

      // 6. Parse payload
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(rawBody)
      } catch {
        console.warn(`${logPrefix} Invalid JSON payload`)
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
      }

      // 7. Get webhook handler
      const handler = options.services.webhookHandlers.get(provider)

      if (!handler) {
        console.warn(`${logPrefix} No handler for provider`)
        return NextResponse.json({ received: true })
      }

      // 8. Parse and process event
      const parseResult = handler.parseEvent(payload)
      if (!parseResult.success || !parseResult.event) {
        console.warn(`${logPrefix} Parse failed: ${parseResult.error}`)
        return NextResponse.json({ received: true })
      }

      const processResult = await handler.processEvent(parseResult.event)

      console.log(
        `${logPrefix} Processed event ${parseResult.event.eventType}:`,
        processResult.action
      )

      return NextResponse.json({
        received: true,
        action: processResult.action,
      })
    } catch (error) {
      console.error(`${logPrefix} Error:`, error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}
