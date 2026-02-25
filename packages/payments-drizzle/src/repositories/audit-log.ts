/**
 * @nehorai/payments-drizzle - Drizzle Audit Log Repository
 *
 * Implements IAuditLogRepository using Drizzle ORM.
 * Audit logs are immutable - only create and read operations.
 */

import { eq, and, inArray, sql, count, gte, lte } from 'drizzle-orm'
import type { DrizzleDB } from './base.js'
import { applyPagination, normalizeArrayFilter } from './base.js'
import { paymentAuditLog } from '../schema/index.js'
import type {
  IAuditLogRepository,
  AuditLogEntry,
  CreateAuditLogInput,
  AuditLogFilter,
  AuditLogAction,
  AuditLogTrigger,
} from '@nehorai/payments/repository'
import type { PaginationParams, PaginatedResult } from '@nehorai/payments/repository'

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Map database row to AuditLogEntry entity
 */
function mapToAuditLogEntry(row: typeof paymentAuditLog.$inferSelect): AuditLogEntry {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    action: row.action as AuditLogAction,
    previousState: row.previous_state as Record<string, unknown> | null,
    newState: row.new_state as Record<string, unknown>,
    triggeredBy: row.triggered_by as AuditLogTrigger,
    triggeredById: row.triggered_by_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    correlationId: row.correlation_id,
    metadata: row.metadata as Record<string, unknown> | null,
    createdAt: row.created_at,
  }
}

// ============================================================================
// Repository Implementation
// ============================================================================

/**
 * Drizzle implementation of IAuditLogRepository
 */
export class DrizzleAuditLogRepository implements IAuditLogRepository {
  constructor(private db: DrizzleDB) {}

  async findById(id: string): Promise<AuditLogEntry | null> {
    const result = await this.db
      .select()
      .from(paymentAuditLog)
      .where(eq(paymentAuditLog.id, id))
      .limit(1)

    return result[0] ? mapToAuditLogEntry(result[0]) : null
  }

  async create(data: CreateAuditLogInput): Promise<AuditLogEntry> {
    const result = await this.db
      .insert(paymentAuditLog)
      .values({
        transaction_id: data.transactionId,
        action: data.action,
        previous_state: data.previousState,
        new_state: data.newState,
        triggered_by: data.triggeredBy,
        triggered_by_id: data.triggeredById,
        ip_address: data.ipAddress,
        user_agent: data.userAgent,
        correlation_id: data.correlationId,
        metadata: data.metadata,
      })
      .returning()

    return mapToAuditLogEntry(result[0])
  }

  async createMany(entries: CreateAuditLogInput[]): Promise<AuditLogEntry[]> {
    if (entries.length === 0) return []

    const values = entries.map((data) => ({
      transaction_id: data.transactionId,
      action: data.action,
      previous_state: data.previousState,
      new_state: data.newState,
      triggered_by: data.triggeredBy,
      triggered_by_id: data.triggeredById,
      ip_address: data.ipAddress,
      user_agent: data.userAgent,
      correlation_id: data.correlationId,
      metadata: data.metadata,
    }))

    const result = await this.db.insert(paymentAuditLog).values(values).returning()

    return result.map(mapToAuditLogEntry)
  }

  async findByTransactionId(
    transactionId: string,
    pagination: PaginationParams = {}
  ): Promise<PaginatedResult<AuditLogEntry>> {
    const { limit = 100, offset = 0 } = pagination

    const [rows, [countResult]] = await Promise.all([
      this.db
        .select()
        .from(paymentAuditLog)
        .where(eq(paymentAuditLog.transaction_id, transactionId))
        .orderBy(sql`${paymentAuditLog.created_at} ASC`)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(paymentAuditLog)
        .where(eq(paymentAuditLog.transaction_id, transactionId)),
    ])

    const entries = rows.map(mapToAuditLogEntry)
    return applyPagination(entries, countResult?.total ?? 0, limit, offset)
  }

  async findMany(
    filter: AuditLogFilter,
    pagination: PaginationParams = {}
  ): Promise<PaginatedResult<AuditLogEntry>> {
    const { limit = 50, offset = 0 } = pagination
    const conditions = this.buildFilterConditions(filter)

    const [rows, [countResult]] = await Promise.all([
      this.db
        .select()
        .from(paymentAuditLog)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(sql`${paymentAuditLog.created_at} DESC`)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(paymentAuditLog)
        .where(conditions.length > 0 ? and(...conditions) : undefined),
    ])

    const entries = rows.map(mapToAuditLogEntry)
    return applyPagination(entries, countResult?.total ?? 0, limit, offset)
  }

  async findByCorrelationId(correlationId: string): Promise<AuditLogEntry[]> {
    const result = await this.db
      .select()
      .from(paymentAuditLog)
      .where(eq(paymentAuditLog.correlation_id, correlationId))
      .orderBy(sql`${paymentAuditLog.created_at} ASC`)

    return result.map(mapToAuditLogEntry)
  }

  async getTransactionHistory(transactionId: string): Promise<AuditLogEntry[]> {
    const result = await this.db
      .select()
      .from(paymentAuditLog)
      .where(eq(paymentAuditLog.transaction_id, transactionId))
      .orderBy(sql`${paymentAuditLog.created_at} ASC`)

    return result.map(mapToAuditLogEntry)
  }

  async countByAction(filter: AuditLogFilter = {}): Promise<Record<AuditLogAction, number>> {
    const conditions = this.buildFilterConditions(filter)

    const result = await this.db
      .select({
        action: paymentAuditLog.action,
        count: count(),
      })
      .from(paymentAuditLog)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(paymentAuditLog.action)

    const counts: Record<AuditLogAction, number> = {
      created: 0,
      status_changed: 0,
      authorized: 0,
      captured: 0,
      voided: 0,
      refund_initiated: 0,
      refund_completed: 0,
      webhook_received: 0,
      webhook_processed: 0,
      error_occurred: 0,
      retry_attempted: 0,
      manual_intervention: 0,
    }

    for (const row of result) {
      counts[row.action as AuditLogAction] = row.count
    }

    return counts
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private buildFilterConditions(filter: AuditLogFilter) {
    const conditions = []

    if (filter.transactionId) {
      conditions.push(eq(paymentAuditLog.transaction_id, filter.transactionId))
    }

    if (filter.correlationId) {
      conditions.push(eq(paymentAuditLog.correlation_id, filter.correlationId))
    }

    if (filter.triggeredById) {
      conditions.push(eq(paymentAuditLog.triggered_by_id, filter.triggeredById))
    }

    const actions = normalizeArrayFilter(filter.action)
    if (actions && actions.length > 0) {
      conditions.push(inArray(paymentAuditLog.action, actions))
    }

    const triggers = normalizeArrayFilter(filter.triggeredBy)
    if (triggers && triggers.length > 0) {
      conditions.push(inArray(paymentAuditLog.triggered_by, triggers))
    }

    if (filter.dateRange?.from) {
      conditions.push(gte(paymentAuditLog.created_at, filter.dateRange.from))
    }
    if (filter.dateRange?.to) {
      conditions.push(lte(paymentAuditLog.created_at, filter.dateRange.to))
    }

    return conditions
  }
}
