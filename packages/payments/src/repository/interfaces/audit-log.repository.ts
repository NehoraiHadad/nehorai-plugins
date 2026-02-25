/**
 * @nehorai/payments Repository - Audit Log Interface
 *
 * Defines operations for payment audit log persistence.
 * Audit logs are immutable - only create and read operations.
 */

import type { PaginationParams, PaginatedResult, DateRangeFilter } from './base.interface.js'

// ============================================================================
// Audit Log Types (Database-agnostic)
// ============================================================================

/**
 * Audit log action types
 */
export type AuditLogAction =
  | 'created'
  | 'status_changed'
  | 'authorized'
  | 'captured'
  | 'voided'
  | 'refund_initiated'
  | 'refund_completed'
  | 'webhook_received'
  | 'webhook_processed'
  | 'error_occurred'
  | 'retry_attempted'
  | 'manual_intervention'

/**
 * Who/what triggered the action
 */
export type AuditLogTrigger = 'user' | 'webhook' | 'system' | 'admin' | 'cron' | 'api'

/**
 * Audit log entity
 */
export interface AuditLogEntry {
  id: string
  transactionId: string
  action: AuditLogAction
  previousState: Record<string, unknown> | null
  newState: Record<string, unknown>
  triggeredBy: AuditLogTrigger
  triggeredById: string | null
  ipAddress: string | null
  userAgent: string | null
  correlationId: string | null
  metadata: Record<string, unknown> | null
  createdAt: Date
}

/**
 * Create audit log entry input
 */
export interface CreateAuditLogInput {
  transactionId: string
  action: AuditLogAction
  previousState?: Record<string, unknown>
  newState: Record<string, unknown>
  triggeredBy: AuditLogTrigger
  triggeredById?: string
  ipAddress?: string
  userAgent?: string
  correlationId?: string
  metadata?: Record<string, unknown>
}

/**
 * Audit log filter options
 */
export interface AuditLogFilter {
  transactionId?: string
  action?: AuditLogAction | AuditLogAction[]
  triggeredBy?: AuditLogTrigger | AuditLogTrigger[]
  triggeredById?: string
  correlationId?: string
  dateRange?: DateRangeFilter
}

// ============================================================================
// Audit Log Repository Interface
// ============================================================================

/**
 * Audit log repository interface
 * Note: Audit logs are immutable - no update or delete operations
 */
export interface IAuditLogRepository {
  findById(id: string): Promise<AuditLogEntry | null>

  create(data: CreateAuditLogInput): Promise<AuditLogEntry>

  createMany(entries: CreateAuditLogInput[]): Promise<AuditLogEntry[]>

  findByTransactionId(
    transactionId: string,
    pagination?: PaginationParams
  ): Promise<PaginatedResult<AuditLogEntry>>

  findMany(
    filter: AuditLogFilter,
    pagination?: PaginationParams
  ): Promise<PaginatedResult<AuditLogEntry>>

  findByCorrelationId(correlationId: string): Promise<AuditLogEntry[]>

  getTransactionHistory(transactionId: string): Promise<AuditLogEntry[]>

  countByAction(filter?: AuditLogFilter): Promise<Record<AuditLogAction, number>>
}
