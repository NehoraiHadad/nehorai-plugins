/**
 * @nehorai/payments-nextjs - Intents Route Handler Factory
 *
 * Creates a Next.js App Router POST handler for creating payment intents.
 * Validates input, authenticates user, and delegates to the orchestrator.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { type PaymentServices } from '@nehorai/payments'
import { type IPaymentsAuthProvider } from '../auth/auth-provider.interface.js'

const CreateIntentSchema = z.object({
  amount: z.number().int().positive(),
  currency: z.string().min(1),
  returnUrl: z.string().url(),
  cardBin: z.string().min(6).max(8).optional(),
  autoCapture: z.boolean().default(true),
  transactionType: z
    .enum(['one_time_purchase', 'subscription_initial', 'subscription_renewal'])
    .default('one_time_purchase'),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
})

export interface IntentsHandlerOptions {
  /** Payment services instance */
  services: PaymentServices
  /** Auth provider for user authentication */
  auth: IPaymentsAuthProvider
}

export function createIntentsRouteHandler(options: IntentsHandlerOptions) {
  return async function POST(request: NextRequest): Promise<NextResponse> {
    try {
      // 1. Authenticate
      const user = await options.auth.getUser()
      if (!user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
      }

      // 2. Parse and validate request body
      const body = await request.json()
      const validation = CreateIntentSchema.safeParse(body)

      if (!validation.success) {
        return NextResponse.json(
          { success: false, error: validation.error.flatten() },
          { status: 400 }
        )
      }

      // 3. Call orchestrator
      const result = await options.services.orchestrator.initiatePayment({
        userId: user.id,
        amount: {
          amountMinor: validation.data.amount,
          currency: validation.data.currency,
        },
        transactionType: validation.data.transactionType,
        description: validation.data.description,
        metadata: validation.data.metadata,
        cardBin: validation.data.cardBin,
        returnUrl: validation.data.returnUrl,
        autoCapture: validation.data.autoCapture,
      })

      // 4. Return response
      if (!result.success) {
        return NextResponse.json({ success: false, error: result.error }, { status: 400 })
      }

      return NextResponse.json(
        {
          success: true,
          data: {
            transactionId: result.transactionId,
            internalPaymentId: result.internalPaymentId,
            clientSecret: result.clientSecret,
            redirectUrl: result.redirectUrl,
            provider: result.provider,
          },
        },
        { status: 201 }
      )
    } catch (error) {
      console.error('[payments-nextjs] Create intent error:', error)
      return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
  }
}
