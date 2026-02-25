/**
 * @nehorai/payments-nextjs - Capture Payment Action Factory
 *
 * Creates a server action function for capturing authorized payments.
 */

import { type PaymentServices, type PaymentProvider, type PaymentAmount } from '@nehorai/payments'
import { type IPaymentsAuthProvider } from '../auth/auth-provider.interface.js'

export interface CapturePaymentInput {
  transactionId: string
  providerIntentId: string
  provider: string
  amount?: PaymentAmount
}

export interface CapturePaymentResult {
  success: boolean
  status?: string
  capturedAmount?: PaymentAmount
  error?: string
}

export interface CaptureActionOptions {
  /** Payment services instance */
  services: PaymentServices
  /** Auth provider for user authentication */
  auth: IPaymentsAuthProvider
}

export function createCapturePaymentAction(options: CaptureActionOptions) {
  return async function capturePayment(
    input: CapturePaymentInput
  ): Promise<CapturePaymentResult> {
    try {
      // 1. Authenticate
      const user = await options.auth.getUser()
      if (!user) {
        return { success: false, error: 'Unauthorized' }
      }

      // 2. Call orchestrator
      const result = await options.services.orchestrator.capturePayment({
        transactionId: input.transactionId,
        providerIntentId: input.providerIntentId,
        provider: input.provider as PaymentProvider,
        amount: input.amount,
      })

      // 3. Return result
      if (!result.success) {
        return { success: false, error: result.error }
      }

      return {
        success: true,
        status: result.status,
        capturedAmount: result.capturedAmount,
      }
    } catch (error) {
      console.error('[payments-nextjs] capturePayment action error:', error)
      return { success: false, error: 'Internal server error' }
    }
  }
}
