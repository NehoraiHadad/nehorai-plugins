/**
 * @nehorai/payments - Payment Orchestrator Service
 *
 * Main entry point for payment operations. Coordinates between:
 * - Routing Engine (provider selection)
 * - Payment Providers (actual processing)
 * - Circuit Breaker (resilience)
 *
 * Supports full dependency injection for:
 * - Provider instances
 * - Routing engine
 * - Circuit breaker
 */

import { randomUUID } from 'crypto'
import type { PaymentProvider, PaymentAmount, TransactionStatus, PaymentMetadata } from '../types/index.js'
import type { IPaymentProvider, RoutingDecision } from '../providers/interfaces/index.js'
import { RoutingEngine, getRoutingEngine } from './routing-engine.js'
import { CircuitBreaker, getCircuitBreaker } from './circuit-breaker.js'

// ============================================================================
// Types
// ============================================================================

export interface InitiatePaymentParams {
  userId: string
  amount: PaymentAmount
  transactionType: 'one_time_purchase' | 'subscription_initial' | 'subscription_renewal'
  description?: string
  metadata?: PaymentMetadata
  preferredProvider?: PaymentProvider
  cardBin?: string
  returnUrl: string
  /** If true, auto-capture immediately (no J5 hold) */
  autoCapture?: boolean
}

export interface PaymentInitiationResult {
  success: boolean
  transactionId: string
  internalPaymentId: string
  provider: PaymentProvider
  clientSecret?: string
  redirectUrl?: string
  error?: string
}

export interface ConfirmPaymentParams {
  transactionId: string
  internalPaymentId: string
  providerIntentId: string
  provider: PaymentProvider
}

export interface PaymentConfirmationResult {
  success: boolean
  transactionId: string
  status: TransactionStatus
  error?: string
}

export interface CapturePaymentParams {
  transactionId: string
  providerIntentId: string
  provider: PaymentProvider
  amount?: PaymentAmount
}

export interface PaymentCaptureResult {
  success: boolean
  status: TransactionStatus
  capturedAmount?: PaymentAmount
  error?: string
}

/**
 * Payment orchestrator dependencies (for dependency injection)
 */
export interface PaymentOrchestratorDeps {
  /** Provider instances - required */
  providers: Map<PaymentProvider, IPaymentProvider>
  /** Routing engine (optional, defaults to singleton) */
  routingEngine?: RoutingEngine
  /** Circuit breaker (optional, defaults to singleton) */
  circuitBreaker?: CircuitBreaker
}

// ============================================================================
// Orchestrator Service
// ============================================================================

/**
 * Payment Orchestrator
 *
 * Standalone service for payment orchestration.
 * Supports full dependency injection for testing and customization.
 */
export class PaymentOrchestrator {
  private providers: Map<PaymentProvider, IPaymentProvider>
  private routingEngine: RoutingEngine
  private circuitBreaker: CircuitBreaker

  constructor(deps: PaymentOrchestratorDeps) {
    this.providers = deps.providers
    this.routingEngine = deps.routingEngine ?? getRoutingEngine()
    this.circuitBreaker = deps.circuitBreaker ?? getCircuitBreaker()
  }

  /**
   * Initiate a new payment
   */
  async initiatePayment(params: InitiatePaymentParams): Promise<PaymentInitiationResult> {
    const internalPaymentId = `pay_${randomUUID()}`
    const idempotencyKey = `idem_${randomUUID()}`

    try {
      const routing = await this.routingEngine.route({
        userId: params.userId,
        amount: params.amount,
        cardBin: params.cardBin,
        preferredProvider: params.preferredProvider,
        isRecurring: params.transactionType !== 'one_time_purchase',
      })

      const provider = this.getProvider(routing.provider)
      if (!provider) {
        return this.tryFailover(params, routing, internalPaymentId)
      }

      if (!(await this.circuitBreaker.canExecute(routing.provider))) {
        return this.tryFailover(params, routing, internalPaymentId)
      }

      const result = await provider.createPaymentIntent({
        amount: params.amount,
        userId: params.userId,
        idempotencyKey,
        description: params.description,
        metadata: params.metadata,
        returnUrl: params.returnUrl,
        captureMethod: params.autoCapture ? 'automatic' : 'manual',
      })

      if (!result.success) {
        await this.circuitBreaker.recordFailure(routing.provider)
        return this.tryFailover(params, routing, internalPaymentId)
      }

      await this.circuitBreaker.recordSuccess(routing.provider)

      return {
        success: true,
        transactionId: result.providerIntentId!,
        internalPaymentId,
        provider: routing.provider,
        clientSecret: result.clientSecret,
        redirectUrl: result.redirectUrl,
      }
    } catch (error) {
      return {
        success: false,
        transactionId: '',
        internalPaymentId,
        provider: 'unknown',
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Confirm a payment after user authorization
   */
  async confirmPayment(params: ConfirmPaymentParams): Promise<PaymentConfirmationResult> {
    const provider = this.getProvider(params.provider)
    if (!provider) {
      return {
        success: false,
        transactionId: params.transactionId,
        status: 'failed',
        error: `Provider ${params.provider} not available`,
      }
    }

    const result = await provider.authorize({
      providerIntentId: params.providerIntentId,
      idempotencyKey: `auth_${params.internalPaymentId}`,
    })

    if (!result.success) {
      return {
        success: false,
        transactionId: params.transactionId,
        status: 'failed',
        error: result.error,
      }
    }

    return {
      success: true,
      transactionId: params.transactionId,
      status: (result.status as TransactionStatus) ?? 'authorized',
    }
  }

  /**
   * Capture an authorized payment (J5 completion)
   */
  async capturePayment(params: CapturePaymentParams): Promise<PaymentCaptureResult> {
    const provider = this.getProvider(params.provider)
    if (!provider) {
      return {
        success: false,
        status: 'failed',
        error: `Provider ${params.provider} not available`,
      }
    }

    const result = await provider.capture({
      providerIntentId: params.providerIntentId,
      authorizationCode: params.providerIntentId,
      amount: params.amount,
      idempotencyKey: `cap_${params.transactionId}`,
    })

    if (!result.success) {
      return {
        success: false,
        status: 'failed',
        error: result.error,
      }
    }

    return {
      success: true,
      status: 'captured',
      capturedAmount: result.capturedAmount,
    }
  }

  /**
   * Get the routing engine (for testing/debugging)
   */
  getRoutingEngine(): RoutingEngine {
    return this.routingEngine
  }

  /**
   * Get the circuit breaker (for testing/debugging)
   */
  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker
  }

  /**
   * Get available providers (for testing/debugging)
   */
  getProviders(): Map<PaymentProvider, IPaymentProvider> {
    return new Map(this.providers)
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private getProvider(name: PaymentProvider): IPaymentProvider | undefined {
    return this.providers.get(name)
  }

  private async tryFailover(
    params: InitiatePaymentParams,
    routing: RoutingDecision,
    internalPaymentId: string
  ): Promise<PaymentInitiationResult> {
    for (const fallback of routing.fallbackProviders) {
      const provider = this.getProvider(fallback)
      if (!provider) continue

      if (!(await this.circuitBreaker.canExecute(fallback))) continue

      const result = await provider.createPaymentIntent({
        amount: params.amount,
        userId: params.userId,
        idempotencyKey: `idem_${randomUUID()}`,
        description: params.description,
        metadata: params.metadata,
        returnUrl: params.returnUrl,
        captureMethod: params.autoCapture ? 'automatic' : 'manual',
      })

      if (result.success) {
        await this.circuitBreaker.recordSuccess(fallback)
        return {
          success: true,
          transactionId: result.providerIntentId!,
          internalPaymentId,
          provider: fallback,
          clientSecret: result.clientSecret,
        }
      }

      await this.circuitBreaker.recordFailure(fallback)
    }

    return {
      success: false,
      transactionId: '',
      internalPaymentId,
      provider: routing.provider,
      error: 'All payment providers failed',
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a payment orchestrator with custom dependencies
 */
export function createPaymentOrchestrator(deps: PaymentOrchestratorDeps): PaymentOrchestrator {
  return new PaymentOrchestrator(deps)
}
