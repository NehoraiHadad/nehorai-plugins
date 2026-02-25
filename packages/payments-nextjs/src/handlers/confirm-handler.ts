/**
 * @nehorai/payments-nextjs - Confirm Route Handler Factory
 *
 * Creates a Next.js App Router POST handler for confirming
 * payment intents after user authorization (e.g., 3D Secure).
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { type PaymentServices, type PaymentProvider } from '@nehorai/payments'
import { type IPaymentsAuthProvider } from '../auth/auth-provider.interface.js'

const ConfirmIntentSchema = z.object({
  internalPaymentId: z.string().min(1),
  provider: z.string().min(1),
})

export interface ConfirmHandlerOptions {
  /** Payment services instance */
  services: PaymentServices
  /** Auth provider for user authentication */
  auth: IPaymentsAuthProvider
}

export function createConfirmRouteHandler(options: ConfirmHandlerOptions) {
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
      const validation = ConfirmIntentSchema.safeParse(body)

      if (!validation.success) {
        return NextResponse.json(
          { success: false, error: validation.error.flatten() },
          { status: 400 }
        )
      }

      // 3. Call orchestrator
      const result = await options.services.orchestrator.confirmPayment({
        transactionId: providerIntentId,
        internalPaymentId: validation.data.internalPaymentId,
        providerIntentId,
        provider: validation.data.provider as PaymentProvider,
      })

      // 4. Return response
      if (!result.success) {
        return NextResponse.json({ success: false, error: result.error }, { status: 400 })
      }

      return NextResponse.json({
        success: true,
        data: {
          transactionId: result.transactionId,
          status: result.status,
          isAuthorized: result.status === 'authorized',
        },
      })
    } catch (error) {
      console.error('[payments-nextjs] Confirm intent error:', error)
      return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
  }
}
