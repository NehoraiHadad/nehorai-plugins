/**
 * @nehorai/payments-drizzle - Drizzle Transaction Repository
 *
 * Implements ITransactionRepository using Drizzle ORM.
 */

import { eq, and, gte, lte, inArray, sql, count } from 'drizzle-orm'
import type { DrizzleDB } from './base.js'
import { parseNumeric, applyPagination, normalizeArrayFilter } from './base.js'
import { paymentTransactions } from '../schema/index.js'
import type {
  ITransactionRepository,
  Transaction,
  CreateTransactionInput,
  UpdateTransactionInput,
  TransactionFilter,
  TransactionStatus,
  ProviderName,
} from '@nehorai/payments/repository'
import type { PaginationParams, PaginatedResult } from '@nehorai/payments/repository'

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Map database row to Transaction entity
 */
function mapToTransaction(row: typeof paymentTransactions.$inferSelect): Transaction {
  return {
    id: row.id,
    internalPaymentId: row.internal_payment_id,
    idempotencyKey: row.idempotency_key,
    userId: row.user_id,
    transactionType: row.transaction_type,
    status: row.status,
    amountMinor: parseNumeric(row.amount_minor),
    currency: row.currency,
    originalAmountMinor: row.original_amount_minor ? parseNumeric(row.original_amount_minor) : null,
    originalCurrency: row.original_currency,
    currencyConversionRate: row.currency_conversion_rate
      ? parseNumeric(row.currency_conversion_rate)
      : null,
    provider: row.provider as ProviderName,
    providerTransactionId: row.provider_transaction_id,
    providerAuthorizationCode: row.provider_authorization_code,
    providerMetadata: row.provider_metadata,
    authorizedAt: row.authorized_at,
    capturedAt: row.captured_at,
    voidedAt: row.voided_at,
    captureDeadline: row.capture_deadline,
    refundedAmountMinor: parseNumeric(row.refunded_amount_minor),
    lastRefundAt: row.last_refund_at,
    taxInvoiceStatus: row.tax_invoice_status ?? 'pending',
    taxInvoiceNumber: row.tax_invoice_number,
    taxInvoiceUrl: row.tax_invoice_url,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    failureDetails: row.failure_details as Record<string, unknown> | null,
    description: row.description,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ============================================================================
// Repository Implementation
// ============================================================================

/**
 * Drizzle implementation of ITransactionRepository
 */
export class DrizzleTransactionRepository implements ITransactionRepository {
  constructor(private db: DrizzleDB) {}

  async findById(id: string): Promise<Transaction | null> {
    const result = await this.db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.id, id))
      .limit(1)

    return result[0] ? mapToTransaction(result[0]) : null
  }

  async create(data: CreateTransactionInput): Promise<Transaction> {
    const result = await this.db
      .insert(paymentTransactions)
      .values({
        internal_payment_id: data.internalPaymentId,
        idempotency_key: data.idempotencyKey,
        user_id: data.userId,
        transaction_type: data.transactionType,
        status: data.status ?? 'created',
        amount_minor: String(data.amountMinor),
        currency: data.currency,
        provider: data.provider,
        description: data.description,
        metadata: data.metadata,
      })
      .returning()

    return mapToTransaction(result[0])
  }

  async update(id: string, data: UpdateTransactionInput): Promise<Transaction | null> {
    const updateData: Partial<typeof paymentTransactions.$inferInsert> = {
      updated_at: new Date(),
    }

    if (data.status !== undefined) updateData.status = data.status
    if (data.providerTransactionId !== undefined)
      updateData.provider_transaction_id = data.providerTransactionId
    if (data.providerAuthorizationCode !== undefined)
      updateData.provider_authorization_code = data.providerAuthorizationCode
    if (data.providerMetadata !== undefined) updateData.provider_metadata = data.providerMetadata
    if (data.authorizedAt !== undefined) updateData.authorized_at = data.authorizedAt
    if (data.capturedAt !== undefined) updateData.captured_at = data.capturedAt
    if (data.voidedAt !== undefined) updateData.voided_at = data.voidedAt
    if (data.captureDeadline !== undefined) updateData.capture_deadline = data.captureDeadline
    if (data.refundedAmountMinor !== undefined)
      updateData.refunded_amount_minor = String(data.refundedAmountMinor)
    if (data.lastRefundAt !== undefined) updateData.last_refund_at = data.lastRefundAt
    if (data.taxInvoiceStatus !== undefined) updateData.tax_invoice_status = data.taxInvoiceStatus
    if (data.taxInvoiceNumber !== undefined) updateData.tax_invoice_number = data.taxInvoiceNumber
    if (data.taxInvoiceUrl !== undefined) updateData.tax_invoice_url = data.taxInvoiceUrl
    if (data.failureCode !== undefined) updateData.failure_code = data.failureCode
    if (data.failureMessage !== undefined) updateData.failure_message = data.failureMessage
    if (data.failureDetails !== undefined) updateData.failure_details = data.failureDetails

    const result = await this.db
      .update(paymentTransactions)
      .set(updateData)
      .where(eq(paymentTransactions.id, id))
      .returning()

    return result[0] ? mapToTransaction(result[0]) : null
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .delete(paymentTransactions)
      .where(eq(paymentTransactions.id, id))
      .returning({ id: paymentTransactions.id })

    return result.length > 0
  }

  async findByInternalPaymentId(internalPaymentId: string): Promise<Transaction | null> {
    const result = await this.db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.internal_payment_id, internalPaymentId))
      .limit(1)

    return result[0] ? mapToTransaction(result[0]) : null
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<Transaction | null> {
    const result = await this.db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.idempotency_key, idempotencyKey))
      .limit(1)

    return result[0] ? mapToTransaction(result[0]) : null
  }

  async findByProviderTransactionId(
    provider: ProviderName,
    providerTransactionId: string
  ): Promise<Transaction | null> {
    const result = await this.db
      .select()
      .from(paymentTransactions)
      .where(
        and(
          eq(paymentTransactions.provider, provider),
          eq(paymentTransactions.provider_transaction_id, providerTransactionId)
        )
      )
      .limit(1)

    return result[0] ? mapToTransaction(result[0]) : null
  }

  async findMany(
    filter: TransactionFilter,
    pagination: PaginationParams = {}
  ): Promise<PaginatedResult<Transaction>> {
    const { limit = 20, offset = 0 } = pagination
    const conditions = this.buildFilterConditions(filter)

    const [rows, [countResult]] = await Promise.all([
      this.db
        .select()
        .from(paymentTransactions)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(sql`${paymentTransactions.created_at} DESC`)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(paymentTransactions)
        .where(conditions.length > 0 ? and(...conditions) : undefined),
    ])

    const transactions = rows.map(mapToTransaction)
    return applyPagination(transactions, countResult?.total ?? 0, limit, offset)
  }

  async findByUserId(
    userId: string,
    pagination: PaginationParams = {}
  ): Promise<PaginatedResult<Transaction>> {
    return this.findMany({ userId }, pagination)
  }

  async updateStatus(
    id: string,
    status: TransactionStatus,
    additionalData: Partial<UpdateTransactionInput> = {}
  ): Promise<Transaction | null> {
    return this.update(id, { ...additionalData, status })
  }

  async incrementRefundedAmount(id: string, amountMinor: number): Promise<Transaction | null> {
    const result = await this.db
      .update(paymentTransactions)
      .set({
        refunded_amount_minor: sql`COALESCE(${paymentTransactions.refunded_amount_minor}, '0')::numeric + ${amountMinor}`,
        last_refund_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(paymentTransactions.id, id))
      .returning()

    return result[0] ? mapToTransaction(result[0]) : null
  }

  async findExpiredAuthorizations(beforeDate: Date): Promise<Transaction[]> {
    const result = await this.db
      .select()
      .from(paymentTransactions)
      .where(
        and(
          eq(paymentTransactions.status, 'authorized'),
          lte(paymentTransactions.capture_deadline, beforeDate)
        )
      )

    return result.map(mapToTransaction)
  }

  async countByStatus(filter: TransactionFilter = {}): Promise<Record<TransactionStatus, number>> {
    const conditions = this.buildFilterConditions(filter)

    const result = await this.db
      .select({
        status: paymentTransactions.status,
        count: count(),
      })
      .from(paymentTransactions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(paymentTransactions.status)

    const counts: Record<TransactionStatus, number> = {
      created: 0,
      pending_authorization: 0,
      authorized: 0,
      capturing: 0,
      captured: 0,
      voided: 0,
      failed: 0,
      expired: 0,
      partially_refunded: 0,
      fully_refunded: 0,
    }

    for (const row of result) {
      counts[row.status as TransactionStatus] = row.count
    }

    return counts
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private buildFilterConditions(filter: TransactionFilter) {
    const conditions = []

    if (filter.userId) {
      conditions.push(eq(paymentTransactions.user_id, filter.userId))
    }

    const statuses = normalizeArrayFilter(filter.status)
    if (statuses && statuses.length > 0) {
      if (statuses.length === 1) {
        conditions.push(eq(paymentTransactions.status, statuses[0]))
      } else {
        conditions.push(inArray(paymentTransactions.status, statuses))
      }
    }

    const providers = normalizeArrayFilter(filter.provider)
    if (providers && providers.length > 0) {
      if (providers.length === 1) {
        conditions.push(eq(paymentTransactions.provider, providers[0]))
      } else {
        conditions.push(inArray(paymentTransactions.provider, providers))
      }
    }

    const transactionTypes = normalizeArrayFilter(filter.transactionType)
    if (transactionTypes && transactionTypes.length > 0) {
      if (transactionTypes.length === 1) {
        conditions.push(eq(paymentTransactions.transaction_type, transactionTypes[0]))
      } else {
        conditions.push(inArray(paymentTransactions.transaction_type, transactionTypes))
      }
    }

    if (filter.dateRange?.from) {
      conditions.push(gte(paymentTransactions.created_at, filter.dateRange.from))
    }
    if (filter.dateRange?.to) {
      conditions.push(lte(paymentTransactions.created_at, filter.dateRange.to))
    }

    return conditions
  }
}
