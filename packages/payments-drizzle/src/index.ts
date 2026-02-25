/**
 * @nehorai/payments-drizzle
 *
 * Drizzle ORM adapter for @nehorai/payments.
 * Provides PostgreSQL schema definitions, repository implementations,
 * and database-backed circuit breaker storage.
 *
 * Subpath exports:
 * - @nehorai/payments-drizzle/schema       - Drizzle pgTable definitions
 * - @nehorai/payments-drizzle/repositories - Repository implementations + factory
 * - @nehorai/payments-drizzle/storage      - DrizzleCircuitBreakerStorage
 */

// Schema
export {
  paymentTransactions,
  paymentMethods,
  paymentWebhookEvents,
  paymentAuditLog,
  providerHealth,
  type PaymentTransactionStatus,
  type PaymentTransactionType,
  type PaymentTaxInvoiceStatus,
  type PaymentMethodType,
  type CardBrandType,
  type WebhookEventStatus,
  type AuditLogAction,
  type AuditLogTrigger,
  type CircuitBreakerState,
} from './schema/index.js'

// Repositories
export {
  type DrizzleDB,
  toCamelCase,
  toSnakeCase,
  applyPagination,
  parseNumeric,
  normalizeArrayFilter,
  DrizzleTransactionRepository,
  DrizzlePaymentMethodRepository,
  DrizzleWebhookEventRepository,
  DrizzleAuditLogRepository,
  DrizzleProviderHealthRepository,
} from './repositories/index.js'

// Storage
export {
  DrizzleCircuitBreakerStorage,
  createDrizzleCircuitBreakerStorage,
} from './storage/index.js'

// Factory
export {
  createDrizzleRepositories,
  createDrizzlePaymentServices,
  type DrizzlePaymentServicesOptions,
} from './factory.js'
