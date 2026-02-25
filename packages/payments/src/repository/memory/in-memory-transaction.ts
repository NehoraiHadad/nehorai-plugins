/**
 * @nehorai/payments - In-Memory Transaction Repository
 *
 * A simple reference in-memory implementation of ITransactionRepository.
 * Useful for testing and development.
 */

import { randomUUID } from 'crypto'
import type {
  ITransactionRepository,
  Transaction,
  CreateTransactionInput,
  UpdateTransactionInput,
  TransactionFilter,
  TransactionStatus,
} from '../interfaces/index.js'
import type { PaginationParams, PaginatedResult } from '../interfaces/base.interface.js'

export class InMemoryTransactionRepository implements ITransactionRepository {
  private transactions: Map<string, Transaction> = new Map()

  async findById(id: string): Promise<Transaction | null> {
    return this.transactions.get(id) ?? null
  }

  async create(data: CreateTransactionInput): Promise<Transaction> {
    const now = new Date()
    const transaction: Transaction = {
      id: randomUUID(),
      internalPaymentId: data.internalPaymentId,
      idempotencyKey: data.idempotencyKey ?? null,
      userId: data.userId,
      transactionType: data.transactionType,
      status: data.status ?? 'created',
      amountMinor: data.amountMinor,
      currency: data.currency,
      originalAmountMinor: null,
      originalCurrency: null,
      currencyConversionRate: null,
      provider: data.provider,
      providerTransactionId: null,
      providerAuthorizationCode: null,
      providerMetadata: null,
      authorizedAt: null,
      capturedAt: null,
      voidedAt: null,
      captureDeadline: null,
      refundedAmountMinor: 0,
      lastRefundAt: null,
      taxInvoiceStatus: 'pending',
      taxInvoiceNumber: null,
      taxInvoiceUrl: null,
      failureCode: null,
      failureMessage: null,
      failureDetails: null,
      description: data.description ?? null,
      metadata: data.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    }
    this.transactions.set(transaction.id, transaction)
    return transaction
  }

  async update(id: string, data: UpdateTransactionInput): Promise<Transaction | null> {
    const existing = this.transactions.get(id)
    if (!existing) return null

    const updated: Transaction = {
      ...existing,
      ...data,
      updatedAt: new Date(),
    }
    this.transactions.set(id, updated)
    return updated
  }

  async delete(id: string): Promise<boolean> {
    return this.transactions.delete(id)
  }

  async findByInternalPaymentId(internalPaymentId: string): Promise<Transaction | null> {
    for (const tx of this.transactions.values()) {
      if (tx.internalPaymentId === internalPaymentId) return tx
    }
    return null
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<Transaction | null> {
    for (const tx of this.transactions.values()) {
      if (tx.idempotencyKey === idempotencyKey) return tx
    }
    return null
  }

  async findByProviderTransactionId(
    provider: string,
    providerTransactionId: string
  ): Promise<Transaction | null> {
    for (const tx of this.transactions.values()) {
      if (tx.provider === provider && tx.providerTransactionId === providerTransactionId) return tx
    }
    return null
  }

  async findMany(
    filter: TransactionFilter,
    pagination?: PaginationParams
  ): Promise<PaginatedResult<Transaction>> {
    let results = Array.from(this.transactions.values())

    if (filter.userId) results = results.filter(t => t.userId === filter.userId)
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
      results = results.filter(t => statuses.includes(t.status))
    }
    if (filter.provider) {
      const providers = Array.isArray(filter.provider) ? filter.provider : [filter.provider]
      results = results.filter(t => providers.includes(t.provider))
    }

    const total = results.length
    const limit = pagination?.limit ?? 50
    const offset = pagination?.offset ?? 0
    const data = results.slice(offset, offset + limit)

    return { data, total, limit, offset, hasMore: offset + limit < total }
  }

  async findByUserId(
    userId: string,
    pagination?: PaginationParams
  ): Promise<PaginatedResult<Transaction>> {
    return this.findMany({ userId }, pagination)
  }

  async updateStatus(
    id: string,
    status: TransactionStatus,
    additionalData?: Partial<UpdateTransactionInput>
  ): Promise<Transaction | null> {
    return this.update(id, { ...additionalData, status })
  }

  async incrementRefundedAmount(id: string, amountMinor: number): Promise<Transaction | null> {
    const existing = this.transactions.get(id)
    if (!existing) return null
    return this.update(id, {
      refundedAmountMinor: existing.refundedAmountMinor + amountMinor,
      lastRefundAt: new Date(),
    })
  }

  async findExpiredAuthorizations(beforeDate: Date): Promise<Transaction[]> {
    return Array.from(this.transactions.values()).filter(
      t => t.status === 'authorized' && t.captureDeadline && t.captureDeadline < beforeDate
    )
  }

  async countByStatus(_filter?: TransactionFilter): Promise<Record<TransactionStatus, number>> {
    const counts = {} as Record<TransactionStatus, number>
    for (const tx of this.transactions.values()) {
      counts[tx.status] = (counts[tx.status] ?? 0) + 1
    }
    return counts
  }

  /** Clear all stored transactions (useful for testing) */
  clear(): void {
    this.transactions.clear()
  }
}
