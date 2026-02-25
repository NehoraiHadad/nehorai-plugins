/**
 * @nehorai/payments-drizzle - Repository Exports
 *
 * All Drizzle ORM repository implementations and factory function.
 */

// Base utilities
export {
  type DrizzleDB,
  toCamelCase,
  toSnakeCase,
  applyPagination,
  parseNumeric,
  normalizeArrayFilter,
} from './base-drizzle.repository.js'

// Repository implementations
export { DrizzleTransactionRepository } from './transaction.drizzle-repository.js'
export { DrizzlePaymentMethodRepository } from './payment-method.drizzle-repository.js'
export { DrizzleWebhookEventRepository } from './webhook-event.drizzle-repository.js'
export { DrizzleAuditLogRepository } from './audit-log.drizzle-repository.js'
export { DrizzleProviderHealthRepository } from './provider-health.drizzle-repository.js'

// Factory function for creating all repositories
import type { DrizzleDB } from './base-drizzle.repository.js'
import type { IPaymentRepositories } from '@nehorai/payments/repository'
import { DrizzleTransactionRepository } from './transaction.drizzle-repository.js'
import { DrizzlePaymentMethodRepository } from './payment-method.drizzle-repository.js'
import { DrizzleWebhookEventRepository } from './webhook-event.drizzle-repository.js'
import { DrizzleAuditLogRepository } from './audit-log.drizzle-repository.js'
import { DrizzleProviderHealthRepository } from './provider-health.drizzle-repository.js'

/**
 * Create all Drizzle repositories with a single database instance
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
