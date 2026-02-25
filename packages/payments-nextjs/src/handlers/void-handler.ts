/**
 * @nehorai/payments-nextjs - Void Route Handler Factory
 *
 * Creates a Next.js App Router POST handler for voiding
 * authorized payments before capture.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { type PaymentServices } from '@nehorai/payments'
import { type IPaymentsAuthProvider } from '../auth/auth-provider.interface.js'

const VoidIntentSchema = z.object({
  provider: z.string().min(1),
  reason: z.string().optional(),
})

export interface VoidHandlerOptions {
  /** Payment services instance */
  services: PaymentServices
  /** Auth provider for user authentication */
  auth: IPaymentsAuthProvider
}

export function createVoidRouteHandler(options: VoidHandlerOptions) {
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
      const validation = VoidIntentSchema.safeParse(body)

      if (!validation.success) {
        return NextResponse.json(
          { success: false, error: validation.error.flatten() },
          { status: 400 }
        )
      }

      // Void operation placeholder - orchestrator.voidPayment not yet on core
      return NextResponse.json(
        {
          success: false,
          error: 'Void operation not yet implemented',
          data: {
            providerIntentId,
            provider: validation.data.provider,
          },
        },
        { status: 501 }
      )
    } catch (error) {
      console.error('[payments-nextjs] Void intent error:', error)
      return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
  }
}
