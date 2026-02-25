/**
 * @nehorai/payments Repository - Payment Method Interface
 *
 * Defines operations for saved payment method persistence.
 * Implement this interface to integrate with your database.
 */

import type { IBaseRepository, PaginationParams, PaginatedResult } from './base.interface.js'
import type { ProviderName } from './transaction.repository.js'

// ============================================================================
// Payment Method Types (Database-agnostic)
// ============================================================================

/**
 * Payment method type
 */
export type PaymentMethodType = 'card' | 'bank_account' | 'paypal'

/**
 * Card brand
 */
export type CardBrand =
  | 'visa'
  | 'mastercard'
  | 'amex'
  | 'discover'
  | 'isracard'
  | 'diners'
  | 'unknown'

/**
 * Payment method entity
 */
export interface PaymentMethod {
  id: string
  userId: string
  type: PaymentMethodType
  provider: ProviderName
  providerPaymentMethodId: string
  cardBrand: CardBrand | null
  cardLast4: string | null
  cardExpMonth: string | null
  cardExpYear: string | null
  cardBin: string | null
  isDefault: boolean
  isActive: boolean
  providerMetadata: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
  lastUsedAt: Date | null
}

/**
 * Create payment method input
 */
export interface CreatePaymentMethodInput {
  userId: string
  type: PaymentMethodType
  provider: ProviderName
  providerPaymentMethodId: string
  cardBrand?: CardBrand
  cardLast4?: string
  cardExpMonth?: string
  cardExpYear?: string
  cardBin?: string
  isDefault?: boolean
  providerMetadata?: Record<string, unknown>
}

/**
 * Update payment method input
 */
export interface UpdatePaymentMethodInput {
  isDefault?: boolean
  isActive?: boolean
  cardExpMonth?: string
  cardExpYear?: string
  lastUsedAt?: Date
  providerMetadata?: Record<string, unknown>
}

/**
 * Payment method filter options
 */
export interface PaymentMethodFilter {
  userId?: string
  provider?: ProviderName | ProviderName[]
  type?: PaymentMethodType | PaymentMethodType[]
  isDefault?: boolean
  isActive?: boolean
  cardBin?: string
}

// ============================================================================
// Payment Method Repository Interface
// ============================================================================

/**
 * Payment method repository interface
 */
export interface IPaymentMethodRepository extends IBaseRepository<
  PaymentMethod,
  CreatePaymentMethodInput,
  UpdatePaymentMethodInput
> {
  findByProviderPaymentMethodId(
    provider: ProviderName,
    providerPaymentMethodId: string
  ): Promise<PaymentMethod | null>

  findByUserId(userId: string, filter?: Partial<PaymentMethodFilter>): Promise<PaymentMethod[]>

  findDefaultForUser(userId: string): Promise<PaymentMethod | null>

  findMany(
    filter: PaymentMethodFilter,
    pagination?: PaginationParams
  ): Promise<PaginatedResult<PaymentMethod>>

  setAsDefault(id: string, userId: string): Promise<PaymentMethod | null>

  deactivate(id: string): Promise<boolean>

  markAsUsed(id: string): Promise<PaymentMethod | null>

  findByCardBin(userId: string, cardBin: string): Promise<PaymentMethod[]>

  countActiveForUser(userId: string): Promise<number>
}
