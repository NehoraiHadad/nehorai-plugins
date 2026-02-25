/**
 * @nehorai/payments Repository - Interface Exports
 *
 * All repository interfaces for database-agnostic payment operations.
 * Implement these interfaces to integrate with your database.
 */

// ============================================================================
// Imports for Aggregate Interface
// ============================================================================

import type { ITransactionRepository } from './transaction.repository.js'
import type { IPaymentMethodRepository } from './payment-method.repository.js'
import type { IWebhookEventRepository } from './webhook-event.repository.js'
import type { IAuditLogRepository } from './audit-log.repository.js'
import type { IProviderHealthRepository } from './provider-health.repository.js'

// ============================================================================
// Base Types
// ============================================================================

export type {
  PaginationParams,
  PaginatedResult,
  DateRangeFilter,
  SortDirection,
  SortParam,
  IBaseRepository,
} from './base.interface.js'

// ============================================================================
// Transaction Repository
// ============================================================================

export type {
  TransactionStatus,
  TransactionType,
  TaxInvoiceStatus,
  ProviderName,
  Transaction,
  CreateTransactionInput,
  UpdateTransactionInput,
  TransactionFilter,
  ITransactionRepository,
} from './transaction.repository.js'

// ============================================================================
// Payment Method Repository
// ============================================================================

export type {
  PaymentMethodType,
  CardBrand,
  PaymentMethod,
  CreatePaymentMethodInput,
  UpdatePaymentMethodInput,
  PaymentMethodFilter,
  IPaymentMethodRepository,
} from './payment-method.repository.js'

// ============================================================================
// Webhook Event Repository
// ============================================================================

export type {
  WebhookEventStatus,
  WebhookEvent,
  CreateWebhookEventInput,
  UpdateWebhookEventInput,
  WebhookEventFilter,
  IWebhookEventRepository,
} from './webhook-event.repository.js'

// ============================================================================
// Audit Log Repository
// ============================================================================

export type {
  AuditLogAction,
  AuditLogTrigger,
  AuditLogEntry,
  CreateAuditLogInput,
  AuditLogFilter,
  IAuditLogRepository,
} from './audit-log.repository.js'

// ============================================================================
// Provider Health Repository
// ============================================================================

export type {
  CircuitBreakerState,
  HealthCheckResult,
  ProviderHealth,
  CreateProviderHealthInput,
  UpdateProviderHealthInput,
  IProviderHealthRepository,
} from './provider-health.repository.js'

// ============================================================================
// Aggregate Repository Interface
// ============================================================================

/**
 * Combined repository interface for all payment operations.
 * Implement this interface to provide a complete database adapter.
 */
export interface IPaymentRepositories {
  transactions: ITransactionRepository
  paymentMethods: IPaymentMethodRepository
  webhookEvents: IWebhookEventRepository
  auditLog: IAuditLogRepository
  providerHealth: IProviderHealthRepository
}
