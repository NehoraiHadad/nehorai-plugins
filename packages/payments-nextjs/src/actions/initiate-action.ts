/**
 * @nehorai/payments-nextjs - Initiate Payment Action Factory
 *
 * Creates a server action function for initiating payments.
 *
 * NOTE: The consuming Next.js app must mark the file that calls
 * this factory (or its wrapper) with 'use server' at the module level.
 * An npm package cannot use the 'use server' directive directly.
 */

import { type PaymentServices, type PaymentProvider } from '@nehorai/payments'
import { type IPaymentsAuthProvider } from '../auth/auth-provider.interface.js'

export interface InitiatePaymentInput {
  amount: number
  currency: string
  returnUrl: string
  cardBin?: string
  autoCapture?: boolean
  transactionType?: 'one_time_purchase' | 'subscription_initial' | 'subscription_renewal'
  description?: string
  metadata?: Record<string, unknown>
}

export interface InitiatePaymentResult {
  success: boolean
  transactionId?: string
  internalPaymentId?: string
  clientSecret?: string
  redirectUrl?: string
  provider?: PaymentProvider
  error?: string
}

export interface InitiateActionOptions {
  /** Payment services instance */
  services: PaymentServices
  /** Auth provider for user authentication */
  auth: IPaymentsAuthProvider
}

/**
 * Creates a function for initiating payments.
 *
 * Usage in your Next.js app:
 * ```ts
 * // src/lib/actions/payment-actions.ts
 * 'use server'
 * import { createInitiatePaymentAction } from '@nehorai/payments-nextjs/actions'
 *
 * const _initiatePayment = createInitiatePaymentAction({ services, auth })
 * export async function initiatePayment(input) { return _initiatePayment(input) }
 * ```
 */
export function createInitiatePaymentAction(options: InitiateActionOptions) {
  return async function initiatePayment(
    input: InitiatePaymentInput
  ): Promise<InitiatePaymentResult> {
    try {
      // 1. Authenticate
      const user = await options.auth.getUser()
      if (!user) {
        return { success: false, error: 'Unauthorized' }
      }

      // 2. Call orchestrator
      const result = await options.services.orchestrator.initiatePayment({
        userId: user.id,
        amount: {
          amountMinor: input.amount,
          currency: input.currency,
        },
        transactionType: input.transactionType ?? 'one_time_purchase',
        description: input.description,
        metadata: input.metadata,
        cardBin: input.cardBin,
        returnUrl: input.returnUrl,
        autoCapture: input.autoCapture ?? true,
      })

      // 3. Return result
      if (!result.success) {
        return { success: false, error: result.error }
      }

      return {
        success: true,
        transactionId: result.transactionId,
        internalPaymentId: result.internalPaymentId,
        clientSecret: result.clientSecret,
        redirectUrl: result.redirectUrl,
        provider: result.provider,
      }
    } catch (error) {
      console.error('[payments-nextjs] initiatePayment action error:', error)
      return { success: false, error: 'Internal server error' }
    }
  }
}
