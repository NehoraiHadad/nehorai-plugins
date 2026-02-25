/**
 * @nehorai/payments-drizzle - Factory
 *
 * Convenience factory functions for creating Drizzle-backed payment repositories
 * and full payment services.
 */

import type { DrizzleDB } from './repositories/base-drizzle.repository.js'
import type { IPaymentRepositories } from '@nehorai/payments/repository'
import type { RoutingRules, CircuitBreakerConfig } from '@nehorai/payments/services'
import type { PaymentConfig } from '@nehorai/payments/config'
import type { PaymentServices, PaymentServicesConfig } from '@nehorai/payments/factory'
import { createPaymentServices } from '@nehorai/payments/factory'
import { DrizzleTransactionRepository } from './repositories/transaction.drizzle-repository.js'
import { DrizzlePaymentMethodRepository } from './repositories/payment-method.drizzle-repository.js'
import { DrizzleWebhookEventRepository } from './repositories/webhook-event.drizzle-repository.js'
import { DrizzleAuditLogRepository } from './repositories/audit-log.drizzle-repository.js'
import { DrizzleProviderHealthRepository } from './repositories/provider-health.drizzle-repository.js'
import { DrizzleCircuitBreakerStorage } from './storage/drizzle-circuit-breaker-storage.js'

// ============================================================================
// Types
// ============================================================================

export interface DrizzlePaymentServicesOptions {
  config?: PaymentConfig
  routingRules?: RoutingRules
  circuitBreaker?: Partial<CircuitBreakerConfig>
  /** Provider instances - required to create full payment services */
  providers: PaymentServicesConfig['providers']
  /** Webhook handler instances (optional) */
  webhookHandlers?: PaymentServicesConfig['webhookHandlers']
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create all Drizzle-backed repository implementations
 *
 * @param db - A Drizzle database instance
 * @returns IPaymentRepositories with all repositories implemented
 */
export function createDrizzleRepositories(db: DrizzleDB): IPaymentRepositories {
  return {
    transactions: new DrizzleTransactionRepository(db),
    paymentMethods: new DrizzlePaymentMethodRepository(db),
    webhookEvents: new DrizzleWebhookEventRepository(db),
    auditLog: new DrizzleAuditLogRepository(db),
    providerHealth: new DrizzleProviderHealthRepository(db),
  }
}

/**
 * Create full payment services with Drizzle-backed storage
 *
 * Sets up repositories, circuit breaker storage, and the complete
 * payment orchestration layer in one call.
 *
 * @param db - A Drizzle database instance
 * @param options - Configuration including providers and optional overrides
 * @returns Fully configured PaymentServices
 */
export function createDrizzlePaymentServices(
  db: DrizzleDB,
  options: DrizzlePaymentServicesOptions
): PaymentServices {
  const repositories = createDrizzleRepositories(db)
  const circuitBreakerStorage = new DrizzleCircuitBreakerStorage(repositories.providerHealth)

  return createPaymentServices({
    config: options.config,
    providers: options.providers,
    webhookHandlers: options.webhookHandlers,
    repositories,
    circuitBreakerStorage,
    circuitBreaker: options.circuitBreaker,
    routingRules: options.routingRules,
  })
}
