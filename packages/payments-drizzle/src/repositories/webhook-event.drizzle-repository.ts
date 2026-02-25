/**
 * @nehorai/payments-drizzle - Drizzle Webhook Event Repository
 *
 * Implements IWebhookEventRepository using Drizzle ORM.
 */

import { eq, and, gte, lte, inArray, sql, count, lt } from 'drizzle-orm'
import type { DrizzleDB } from './base-drizzle.repository.js'
import { applyPagination, normalizeArrayFilter } from './base-drizzle.repository.js'
import { paymentWebhookEvents } from '../schema/index.js'
import type {
  IWebhookEventRepository,
  WebhookEvent,
  CreateWebhookEventInput,
  UpdateWebhookEventInput,
  WebhookEventFilter,
  WebhookEventStatus,
  ProviderName,
  PaginationParams,
  PaginatedResult,
} from '@nehorai/payments/repository'

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Map database row to WebhookEvent entity
 */
function mapToWebhookEvent(row: typeof paymentWebhookEvents.$inferSelect): WebhookEvent {
  return {
    id: row.id,
    provider: row.provider as ProviderName,
    providerEventId: row.provider_event_id,
    eventType: row.event_type,
    status: row.status,
    attempts: parseInt(row.attempts ?? '0', 10),
    lastAttemptAt: row.last_attempt_at,
    transactionId: row.transaction_id,
    payload: row.payload,
    signature: row.signature,
    errorMessage: row.error_message,
    errorDetails: row.error_details as Record<string, unknown> | null,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    createdAt: row.created_at,
  }
}

// ============================================================================
// Repository Implementation
// ============================================================================

/**
 * Drizzle implementation of IWebhookEventRepository
 */
export class DrizzleWebhookEventRepository implements IWebhookEventRepository {
  constructor(private db: DrizzleDB) {}

  async findById(id: string): Promise<WebhookEvent | null> {
    const result = await this.db
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.id, id))
      .limit(1)

    return result[0] ? mapToWebhookEvent(result[0]) : null
  }

  async create(data: CreateWebhookEventInput): Promise<WebhookEvent> {
    const result = await this.db
      .insert(paymentWebhookEvents)
      .values({
        provider: data.provider,
        provider_event_id: data.providerEventId,
        event_type: data.eventType,
        payload: data.payload,
        signature: data.signature,
        status: 'pending',
      })
      .returning()

    return mapToWebhookEvent(result[0])
  }

  async update(id: string, data: UpdateWebhookEventInput): Promise<WebhookEvent | null> {
    const updateData: Partial<typeof paymentWebhookEvents.$inferInsert> = {}

    if (data.status !== undefined) updateData.status = data.status
    if (data.attempts !== undefined) updateData.attempts = String(data.attempts)
    if (data.lastAttemptAt !== undefined) updateData.last_attempt_at = data.lastAttemptAt
    if (data.transactionId !== undefined) updateData.transaction_id = data.transactionId
    if (data.processedAt !== undefined) updateData.processed_at = data.processedAt
    if (data.errorMessage !== undefined) updateData.error_message = data.errorMessage
    if (data.errorDetails !== undefined) updateData.error_details = data.errorDetails

    const result = await this.db
      .update(paymentWebhookEvents)
      .set(updateData)
      .where(eq(paymentWebhookEvents.id, id))
      .returning()

    return result[0] ? mapToWebhookEvent(result[0]) : null
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .delete(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.id, id))
      .returning({ id: paymentWebhookEvents.id })

    return result.length > 0
  }

  async findByProviderEventId(
    provider: ProviderName,
    providerEventId: string
  ): Promise<WebhookEvent | null> {
    const result = await this.db
      .select()
      .from(paymentWebhookEvents)
      .where(
        and(
          eq(paymentWebhookEvents.provider, provider),
          eq(paymentWebhookEvents.provider_event_id, providerEventId)
        )
      )
      .limit(1)

    return result[0] ? mapToWebhookEvent(result[0]) : null
  }

  async findByTransactionId(transactionId: string): Promise<WebhookEvent[]> {
    const result = await this.db
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.transaction_id, transactionId))
      .orderBy(sql`${paymentWebhookEvents.received_at} DESC`)

    return result.map(mapToWebhookEvent)
  }

  async findMany(
    filter: WebhookEventFilter,
    pagination: PaginationParams = {}
  ): Promise<PaginatedResult<WebhookEvent>> {
    const { limit = 20, offset = 0 } = pagination
    const conditions = this.buildFilterConditions(filter)

    const [rows, [countResult]] = await Promise.all([
      this.db
        .select()
        .from(paymentWebhookEvents)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(sql`${paymentWebhookEvents.received_at} DESC`)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(paymentWebhookEvents)
        .where(conditions.length > 0 ? and(...conditions) : undefined),
    ])

    const events = rows.map(mapToWebhookEvent)
    return applyPagination(events, countResult?.total ?? 0, limit, offset)
  }

  async findFailedForRetry(maxAttempts: number, olderThan?: Date): Promise<WebhookEvent[]> {
    const conditions = [
      eq(paymentWebhookEvents.status, 'failed'),
      lt(sql`CAST(${paymentWebhookEvents.attempts} AS INTEGER)`, maxAttempts),
    ]

    if (olderThan) {
      conditions.push(lt(paymentWebhookEvents.last_attempt_at, olderThan))
    }

    const result = await this.db
      .select()
      .from(paymentWebhookEvents)
      .where(and(...conditions))
      .orderBy(sql`${paymentWebhookEvents.last_attempt_at} ASC`)
      .limit(100)

    return result.map(mapToWebhookEvent)
  }

  async findPending(limit: number = 100): Promise<WebhookEvent[]> {
    const result = await this.db
      .select()
      .from(paymentWebhookEvents)
      .where(eq(paymentWebhookEvents.status, 'pending'))
      .orderBy(sql`${paymentWebhookEvents.received_at} ASC`)
      .limit(limit)

    return result.map(mapToWebhookEvent)
  }

  async markAsProcessing(id: string): Promise<boolean> {
    // Optimistic locking - only update if still pending
    const result = await this.db
      .update(paymentWebhookEvents)
      .set({
        status: 'processing',
        last_attempt_at: new Date(),
        attempts: sql`CAST(${paymentWebhookEvents.attempts} AS INTEGER) + 1`,
      })
      .where(and(eq(paymentWebhookEvents.id, id), eq(paymentWebhookEvents.status, 'pending')))
      .returning({ id: paymentWebhookEvents.id })

    return result.length > 0
  }

  async markAsProcessed(id: string, transactionId?: string): Promise<WebhookEvent | null> {
    return this.update(id, {
      status: 'processed',
      processedAt: new Date(),
      transactionId,
    })
  }

  async markAsFailed(
    id: string,
    errorMessage: string,
    errorDetails?: Record<string, unknown>
  ): Promise<WebhookEvent | null> {
    return this.update(id, {
      status: 'failed',
      errorMessage,
      errorDetails,
    })
  }

  async incrementAttempts(id: string): Promise<WebhookEvent | null> {
    const result = await this.db
      .update(paymentWebhookEvents)
      .set({
        attempts: sql`CAST(${paymentWebhookEvents.attempts} AS INTEGER) + 1`,
        last_attempt_at: new Date(),
      })
      .where(eq(paymentWebhookEvents.id, id))
      .returning()

    return result[0] ? mapToWebhookEvent(result[0]) : null
  }

  async isAlreadyProcessed(provider: ProviderName, providerEventId: string): Promise<boolean> {
    const result = await this.db
      .select({ status: paymentWebhookEvents.status })
      .from(paymentWebhookEvents)
      .where(
        and(
          eq(paymentWebhookEvents.provider, provider),
          eq(paymentWebhookEvents.provider_event_id, providerEventId),
          eq(paymentWebhookEvents.status, 'processed')
        )
      )
      .limit(1)

    return result.length > 0
  }

  async countByStatus(
    filter: WebhookEventFilter = {}
  ): Promise<Record<WebhookEventStatus, number>> {
    const conditions = this.buildFilterConditions(filter)

    const result = await this.db
      .select({
        status: paymentWebhookEvents.status,
        count: count(),
      })
      .from(paymentWebhookEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(paymentWebhookEvents.status)

    const counts: Record<WebhookEventStatus, number> = {
      pending: 0,
      processing: 0,
      processed: 0,
      failed: 0,
      ignored: 0,
    }

    for (const row of result) {
      counts[row.status as WebhookEventStatus] = row.count
    }

    return counts
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private buildFilterConditions(filter: WebhookEventFilter) {
    const conditions = []

    const providers = normalizeArrayFilter(filter.provider)
    if (providers && providers.length > 0) {
      conditions.push(inArray(paymentWebhookEvents.provider, providers))
    }

    const eventTypes = normalizeArrayFilter(filter.eventType)
    if (eventTypes && eventTypes.length > 0) {
      conditions.push(inArray(paymentWebhookEvents.event_type, eventTypes))
    }

    const statuses = normalizeArrayFilter(filter.status)
    if (statuses && statuses.length > 0) {
      conditions.push(inArray(paymentWebhookEvents.status, statuses))
    }

    if (filter.transactionId) {
      conditions.push(eq(paymentWebhookEvents.transaction_id, filter.transactionId))
    }

    if (filter.dateRange?.from) {
      conditions.push(gte(paymentWebhookEvents.received_at, filter.dateRange.from))
    }
    if (filter.dateRange?.to) {
      conditions.push(lte(paymentWebhookEvents.received_at, filter.dateRange.to))
    }

    return conditions
  }
}
