/**
 * @nehorai/payments-nextjs - Transactions Route Handler Factory
 *
 * Creates Next.js App Router handlers for listing, viewing,
 * and refunding payment transactions.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { type PaymentServices, type ITransactionRepository } from '@nehorai/payments'
import { type IPaymentsAuthProvider } from '../auth/auth-provider.interface.js'

const RefundSchema = z.object({
  amount: z
    .object({
      amountMinor: z.number().int().positive(),
      currency: z.string().min(1),
    })
    .optional(),
  reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer', 'other']).optional(),
  notes: z.string().max(500).optional(),
})

export interface TransactionsHandlerOptions {
  /** Payment services instance */
  services: PaymentServices
  /** Auth provider for user authentication */
  auth: IPaymentsAuthProvider
  /** Optional transaction repository for data access */
  transactionRepository?: ITransactionRepository
}

/**
 * Creates handlers for /api/payments/transactions routes
 */
export function createTransactionsRouteHandler(options: TransactionsHandlerOptions) {
  /** GET /api/payments/transactions - List user's transactions */
  async function GET(request: NextRequest): Promise<NextResponse> {
    try {
      // 1. Authenticate
      const user = await options.auth.getUser()
      if (!user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
      }

      // 2. Parse query parameters
      const searchParams = request.nextUrl.searchParams
      const status = searchParams.get('status')
      const provider = searchParams.get('provider')
      const from = searchParams.get('from')
      const to = searchParams.get('to')
      const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100)
      const offset = parseInt(searchParams.get('offset') || '0')

      // 3. Query via repository if available
      if (options.transactionRepository) {
        const result = await options.transactionRepository.findByUserId(user.id, { limit, offset })
        return NextResponse.json({
          success: true,
          data: {
            transactions: result.data,
            total: result.total,
            limit,
            offset,
            hasMore: result.hasMore,
          },
        })
      }

      // No repository configured
      return NextResponse.json({
        success: true,
        data: {
          transactions: [],
          total: 0,
          limit,
          offset,
          hasMore: false,
          filters: { status, provider, from, to },
        },
      })
    } catch (error) {
      console.error('[payments-nextjs] List transactions error:', error)
      return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
  }

  /** GET /api/payments/transactions/:id - Get transaction details */
  async function GET_BY_ID(
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

      // 2. Query via repository if available
      if (options.transactionRepository) {
        const transaction = await options.transactionRepository.findById(id)
        if (!transaction) {
          return NextResponse.json(
            { success: false, error: 'Transaction not found' },
            { status: 404 }
          )
        }
        return NextResponse.json({ success: true, data: transaction })
      }

      return NextResponse.json({
        success: true,
        data: { id, message: 'Transaction details not yet implemented' },
      })
    } catch (error) {
      console.error('[payments-nextjs] Get transaction error:', error)
      return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
  }

  /** POST /api/payments/transactions/:id/refund - Refund a transaction */
  async function REFUND(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ): Promise<NextResponse> {
    try {
      // 1. Authenticate
      const user = await options.auth.getUser()
      if (!user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
      }

      const { id } = await params

      // 2. Parse and validate request body
      const body = await request.json().catch(() => ({}))
      const validation = RefundSchema.safeParse(body)

      if (!validation.success) {
        return NextResponse.json(
          { success: false, error: validation.error.flatten() },
          { status: 400 }
        )
      }

      // Refund placeholder - requires orchestrator.refund()
      return NextResponse.json(
        {
          success: false,
          error: 'Refund not yet implemented',
          data: {
            transactionId: id,
            requestedAmount: validation.data.amount,
            reason: validation.data.reason,
          },
        },
        { status: 501 }
      )
    } catch (error) {
      console.error('[payments-nextjs] Refund transaction error:', error)
      return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
    }
  }

  return { GET, GET_BY_ID, REFUND }
}
