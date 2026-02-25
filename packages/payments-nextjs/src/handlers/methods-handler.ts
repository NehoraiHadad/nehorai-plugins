/**
 * @nehorai/payments-nextjs - Methods Route Handler Factory
 *
 * Creates Next.js App Router handlers for managing
 * saved payment methods (list, save, delete).
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { type PaymentServices } from '@nehorai/payments'
import { type IPaymentsAuthProvider } from '../auth/auth-provider.interface.js'

const SaveMethodSchema = z.object({
  provider: z.string().min(1),
  paymentMethodId: z.string().min(1),
  setAsDefault: z.boolean().default(false),
})

export interface MethodsHandlerOptions {
  /** Payment services instance */
  services: PaymentServices
  /** Auth provider for user authentication */
  auth: IPaymentsAuthProvider
}

/**
 * Creates GET and POST handlers for /api/payments/methods
 */
export function createMethodsRouteHandler(options: MethodsHandlerOptions) {
  async function GET(): Promise<NextResponse> {
    try {
      // 1. Authenticate
      const user = await options.auth.getUser()
      if (!user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
      }

      // Query via repository if available
      // PaymentServices doesn't have repositories by default,
      // but callers can extend their setup to include them
      return NextResponse.json({
        success: true,
        data: {
          methods: [],
        },
      })
    } catch (error) {
      console.error('[payments-nextjs] List methods error:', error)
      return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
  }

  async function POST(request: NextRequest): Promise<NextResponse> {
    try {
      // 1. Authenticate
      const user = await options.auth.getUser()
      if (!user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
      }

      // 2. Parse and validate request body
      const body = await request.json()
      const validation = SaveMethodSchema.safeParse(body)

      if (!validation.success) {
        return NextResponse.json(
          { success: false, error: validation.error.flatten() },
          { status: 400 }
        )
      }

      // Save method placeholder - requires repository integration
      return NextResponse.json(
        {
          success: false,
          error: 'Save payment method not yet implemented',
          data: {
            provider: validation.data.provider,
            paymentMethodId: validation.data.paymentMethodId,
          },
        },
        { status: 501 }
      )
    } catch (error) {
      console.error('[payments-nextjs] Save method error:', error)
      return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
  }

  async function DELETE(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ): Promise<NextResponse> {
    try {
      // 1. Authenticate
      const user = await options.auth.getUser()
      if (!user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
      }

      const { id } = await params

      // Delete method placeholder - requires repository integration
      return NextResponse.json(
        {
          success: false,
          error: 'Delete payment method not yet implemented',
          data: { id },
        },
        { status: 501 }
      )
    } catch (error) {
      console.error('[payments-nextjs] Delete method error:', error)
      return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
  }

  return { GET, POST, DELETE }
}
