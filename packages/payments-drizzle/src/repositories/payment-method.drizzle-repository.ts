/**
 * @nehorai/payments-drizzle - Drizzle Payment Method Repository
 *
 * Implements IPaymentMethodRepository using Drizzle ORM.
 */

import { eq, and, inArray, sql, count } from 'drizzle-orm'
import type { DrizzleDB } from './base-drizzle.repository.js'
import { applyPagination, normalizeArrayFilter } from './base-drizzle.repository.js'
import { paymentMethods } from '../schema/index.js'
import type {
  IPaymentMethodRepository,
  PaymentMethod,
  CreatePaymentMethodInput,
  UpdatePaymentMethodInput,
  PaymentMethodFilter,
  ProviderName,
  CardBrand,
  PaginationParams,
  PaginatedResult,
} from '@nehorai/payments/repository'

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Map database row to PaymentMethod entity
 */
function mapToPaymentMethod(row: typeof paymentMethods.$inferSelect): PaymentMethod {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    provider: row.provider as ProviderName,
    providerPaymentMethodId: row.provider_payment_method_id,
    cardBrand: row.card_brand as CardBrand | null,
    cardLast4: row.card_last4,
    cardExpMonth: row.card_exp_month,
    cardExpYear: row.card_exp_year,
    cardBin: row.card_bin,
    isDefault: row.is_default ?? false,
    isActive: row.is_active ?? true,
    providerMetadata: row.provider_metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  }
}

// ============================================================================
// Repository Implementation
// ============================================================================

/**
 * Drizzle implementation of IPaymentMethodRepository
 */
export class DrizzlePaymentMethodRepository implements IPaymentMethodRepository {
  constructor(private db: DrizzleDB) {}

  async findById(id: string): Promise<PaymentMethod | null> {
    const result = await this.db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.id, id))
      .limit(1)

    return result[0] ? mapToPaymentMethod(result[0]) : null
  }

  async create(data: CreatePaymentMethodInput): Promise<PaymentMethod> {
    const result = await this.db
      .insert(paymentMethods)
      .values({
        user_id: data.userId,
        type: data.type,
        provider: data.provider,
        provider_payment_method_id: data.providerPaymentMethodId,
        card_brand: data.cardBrand,
        card_last4: data.cardLast4,
        card_exp_month: data.cardExpMonth,
        card_exp_year: data.cardExpYear,
        card_bin: data.cardBin,
        is_default: data.isDefault ?? false,
        provider_metadata: data.providerMetadata,
      })
      .returning()

    return mapToPaymentMethod(result[0])
  }

  async update(id: string, data: UpdatePaymentMethodInput): Promise<PaymentMethod | null> {
    const updateData: Partial<typeof paymentMethods.$inferInsert> = {
      updated_at: new Date(),
    }

    if (data.isDefault !== undefined) updateData.is_default = data.isDefault
    if (data.isActive !== undefined) updateData.is_active = data.isActive
    if (data.cardExpMonth !== undefined) updateData.card_exp_month = data.cardExpMonth
    if (data.cardExpYear !== undefined) updateData.card_exp_year = data.cardExpYear
    if (data.lastUsedAt !== undefined) updateData.last_used_at = data.lastUsedAt
    if (data.providerMetadata !== undefined) updateData.provider_metadata = data.providerMetadata

    const result = await this.db
      .update(paymentMethods)
      .set(updateData)
      .where(eq(paymentMethods.id, id))
      .returning()

    return result[0] ? mapToPaymentMethod(result[0]) : null
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .delete(paymentMethods)
      .where(eq(paymentMethods.id, id))
      .returning({ id: paymentMethods.id })

    return result.length > 0
  }

  async findByProviderPaymentMethodId(
    provider: ProviderName,
    providerPaymentMethodId: string
  ): Promise<PaymentMethod | null> {
    const result = await this.db
      .select()
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.provider, provider),
          eq(paymentMethods.provider_payment_method_id, providerPaymentMethodId)
        )
      )
      .limit(1)

    return result[0] ? mapToPaymentMethod(result[0]) : null
  }

  async findByUserId(
    userId: string,
    filter: Partial<PaymentMethodFilter> = {}
  ): Promise<PaymentMethod[]> {
    const conditions = [eq(paymentMethods.user_id, userId)]

    if (filter.isActive !== undefined) {
      conditions.push(eq(paymentMethods.is_active, filter.isActive))
    }
    if (filter.isDefault !== undefined) {
      conditions.push(eq(paymentMethods.is_default, filter.isDefault))
    }

    const providers = normalizeArrayFilter(filter.provider)
    if (providers && providers.length > 0) {
      conditions.push(inArray(paymentMethods.provider, providers))
    }

    const result = await this.db
      .select()
      .from(paymentMethods)
      .where(and(...conditions))
      .orderBy(sql`${paymentMethods.created_at} DESC`)

    return result.map(mapToPaymentMethod)
  }

  async findDefaultForUser(userId: string): Promise<PaymentMethod | null> {
    const result = await this.db
      .select()
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.user_id, userId),
          eq(paymentMethods.is_default, true),
          eq(paymentMethods.is_active, true)
        )
      )
      .limit(1)

    return result[0] ? mapToPaymentMethod(result[0]) : null
  }

  async findMany(
    filter: PaymentMethodFilter,
    pagination: PaginationParams = {}
  ): Promise<PaginatedResult<PaymentMethod>> {
    const { limit = 20, offset = 0 } = pagination
    const conditions = this.buildFilterConditions(filter)

    const [rows, [countResult]] = await Promise.all([
      this.db
        .select()
        .from(paymentMethods)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(sql`${paymentMethods.created_at} DESC`)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(paymentMethods)
        .where(conditions.length > 0 ? and(...conditions) : undefined),
    ])

    const methods = rows.map(mapToPaymentMethod)
    return applyPagination(methods, countResult?.total ?? 0, limit, offset)
  }

  async setAsDefault(id: string, userId: string): Promise<PaymentMethod | null> {
    // First, unset all other defaults for user
    await this.db
      .update(paymentMethods)
      .set({ is_default: false, updated_at: new Date() })
      .where(and(eq(paymentMethods.user_id, userId), eq(paymentMethods.is_default, true)))

    // Then set this one as default
    return this.update(id, { isDefault: true })
  }

  async deactivate(id: string): Promise<boolean> {
    const result = await this.update(id, { isActive: false })
    return result !== null
  }

  async markAsUsed(id: string): Promise<PaymentMethod | null> {
    return this.update(id, { lastUsedAt: new Date() })
  }

  async findByCardBin(userId: string, cardBin: string): Promise<PaymentMethod[]> {
    const result = await this.db
      .select()
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.user_id, userId),
          eq(paymentMethods.card_bin, cardBin),
          eq(paymentMethods.is_active, true)
        )
      )

    return result.map(mapToPaymentMethod)
  }

  async countActiveForUser(userId: string): Promise<number> {
    const result = await this.db
      .select({ count: count() })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.user_id, userId), eq(paymentMethods.is_active, true)))

    return result[0]?.count ?? 0
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private buildFilterConditions(filter: PaymentMethodFilter) {
    const conditions = []

    if (filter.userId) {
      conditions.push(eq(paymentMethods.user_id, filter.userId))
    }
    if (filter.isDefault !== undefined) {
      conditions.push(eq(paymentMethods.is_default, filter.isDefault))
    }
    if (filter.isActive !== undefined) {
      conditions.push(eq(paymentMethods.is_active, filter.isActive))
    }
    if (filter.cardBin) {
      conditions.push(eq(paymentMethods.card_bin, filter.cardBin))
    }

    const providers = normalizeArrayFilter(filter.provider)
    if (providers && providers.length > 0) {
      conditions.push(inArray(paymentMethods.provider, providers))
    }

    const types = normalizeArrayFilter(filter.type)
    if (types && types.length > 0) {
      conditions.push(inArray(paymentMethods.type, types))
    }

    return conditions
  }
}
