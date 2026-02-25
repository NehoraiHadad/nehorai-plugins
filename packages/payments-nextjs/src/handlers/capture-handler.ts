/**
 * @nehorai/payments-nextjs - Capture Route Handler Factory
 *
 * Creates a Next.js App Router POST handler for capturing
 * authorized payments (J5 completion).
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { type PaymentServices, type PaymentProvider } from '@nehorai/payments'
import { type IPaymentsAuthProvider } from '../auth/auth-provider.interface.js'

const CaptureIntentSchema = z.object({
  provider: z.string().min(1),
  amount: z
    .object({
      amountMinor: z.number().int().positive(),
      currency: z.string().min(1),
    })
    .optional(),
})

export interface CaptureHandlerOptions {
  /** Payment services instance */
  services: PaymentServices
  /** Auth provider for user authentication */
  auth: IPaymentsAuthProvider
}

export function createCaptureRouteHandler(options: CaptureHandlerOptions) {
  return async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ): Promise<NextResponse> {
    try {
      // 1. Authenticate
      const user = await options.auth.getUser()
      if (!user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
      }

      const { id: providerIntentId } = await params

      // 2. Parse and validate request body
      const body = await request.json()
      const validation = CaptureIntentSchema.safeParse(body)

      if (!validation.success) {
        return NextResponse.json(
          { success: false, error: validation.error.flatten() },
          { status: 400 }
        )
      }

      // 3. Call orchestrator
      const result = await options.services.orchestrator.capturePayment({
        transactionId: providerIntentId,
        providerIntentId,
        provider: validation.data.provider as PaymentProvider,
        amount: validation.data.amount,
      })

      // 4. Return response
      if (!result.success) {
        return NextResponse.json({ success: false, error: result.error }, { status: 400 })
      }

      return NextResponse.json({
        success: true,
        data: {
          status: result.status,
          capturedAmount: result.capturedAmount,
        },
      })
    } catch (error) {
      console.error('[payments-nextjs] Capture intent error:', error)
      return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
  }
}
