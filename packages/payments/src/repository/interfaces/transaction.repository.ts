/**
 * @nehorai/payments Repository - Transaction Interface
 *
 * Defines operations for payment transaction persistence.
 * Implement this interface to integrate with your database.
 */

import type {
  IBaseRepository,
  PaginationParams,
  PaginatedResult,
  DateRangeFilter,
} from './base.interface.js'

// ============================================================================
// Transaction Types (Database-agnostic)
// ============================================================================

/**
 * Transaction status (maps to state machine)
 */
export type TransactionStatus =
  | 'created'
  | 'pending_authorization'
  | 'authorized'
  | 'capturing'
  | 'captured'
  | 'voided'
  | 'failed'
  | 'expired'
  | 'partially_refunded'
  | 'fully_refunded'

/**
 * Transaction type
 */
export type TransactionType =
  | 'one_time_purchase'
  | 'subscription_initial'
  | 'subscription_renewal'
  | 'refund'

/**
 * Tax invoice status
 */
export type TaxInvoiceStatus = 'pending' | 'generated' | 'sent' | 'failed'

/**
 * Provider name - generic string identifier
 */
export type ProviderName = string

/**
 * Transaction entity
 */
export interface Transaction {
  id: string
  internalPaymentId: string
  idempotencyKey: string | null
  userId: string
  transactionType: TransactionType
  status: TransactionStatus
  amountMinor: number
  currency: string
  originalAmountMinor: number | null
  originalCurrency: string | null
  currencyConversionRate: number | null
  provider: ProviderName
  providerTransactionId: string | null
  providerAuthorizationCode: string | null
  providerMetadata: Record<string, unknown> | null
  authorizedAt: Date | null
  capturedAt: Date | null
  voidedAt: Date | null
  captureDeadline: Date | null
  refundedAmountMinor: number
  lastRefundAt: Date | null
  taxInvoiceStatus: TaxInvoiceStatus
  taxInvoiceNumber: string | null
  taxInvoiceUrl: string | null
  failureCode: string | null
  failureMessage: string | null
  failureDetails: Record<string, unknown> | null
  description: string | null
  metadata: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Create transaction input
 */
export interface CreateTransactionInput {
  internalPaymentId: string
  idempotencyKey?: string
  userId: string
  transactionType: TransactionType
  status?: TransactionStatus
  amountMinor: number
  currency: string
  provider: ProviderName
  description?: string
  metadata?: Record<string, unknown>
}

/**
 * Update transaction input
 */
export interface UpdateTransactionInput {
  status?: TransactionStatus
  providerTransactionId?: string
  providerAuthorizationCode?: string
  providerMetadata?: Record<string, unknown>
  authorizedAt?: Date
  capturedAt?: Date
  voidedAt?: Date
  captureDeadline?: Date
  refundedAmountMinor?: number
  lastRefundAt?: Date
  taxInvoiceStatus?: TaxInvoiceStatus
  taxInvoiceNumber?: string
  taxInvoiceUrl?: string
  failureCode?: string
  failureMessage?: string
  failureDetails?: Record<string, unknown>
}

/**
 * Transaction filter options
 */
export interface TransactionFilter {
  userId?: string
  status?: TransactionStatus | TransactionStatus[]
  provider?: ProviderName | ProviderName[]
  transactionType?: TransactionType | TransactionType[]
  dateRange?: DateRangeFilter
}

// ============================================================================
// Transaction Repository Interface
// ============================================================================

/**
 * Transaction repository interface
 */
export interface ITransactionRepository extends IBaseRepository<
  Transaction,
  CreateTransactionInput,
  UpdateTransactionInput
> {
  /**
   * Find transaction by internal payment ID
   */
  findByInternalPaymentId(internalPaymentId: string): Promise<Transaction | null>

  /**
   * Find transaction by idempotency key
   */
  findByIdempotencyKey(idempotencyKey: string): Promise<Transaction | null>

  /**
   * Find transaction by provider transaction ID
   */
  findByProviderTransactionId(
    provider: ProviderName,
    providerTransactionId: string
  ): Promise<Transaction | null>

  /**
   * Find transactions with filters and pagination
   */
  findMany(
    filter: TransactionFilter,
    pagination?: PaginationParams
  ): Promise<PaginatedResult<Transaction>>

  /**
   * Find transactions by user ID
   */
  findByUserId(userId: string, pagination?: PaginationParams): Promise<PaginatedResult<Transaction>>

  /**
   * Update transaction status (with validation)
   */
  updateStatus(
    id: string,
    status: TransactionStatus,
    additionalData?: Partial<UpdateTransactionInput>
  ): Promise<Transaction | null>

  /**
   * Increment refunded amount
   */
  incrementRefundedAmount(id: string, amountMinor: number): Promise<Transaction | null>

  /**
   * Find expired authorizations (for cleanup)
   */
  findExpiredAuthorizations(beforeDate: Date): Promise<Transaction[]>

  /**
   * Count transactions by status
   */
  countByStatus(filter?: TransactionFilter): Promise<Record<TransactionStatus, number>>
}
