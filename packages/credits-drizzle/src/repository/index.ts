import { and, count, desc, eq, gte, lte, lt, sql } from 'drizzle-orm'
import type {
  AddCreditsAtomicOptions,
  AIProviderType,
  CreateJournalEntryInput,
  CreateReservationInput,
  CreateTransactionInput,
  CreateUsageLogInput,
  CreditBalanceUpdate,
  CreditOperationType,
  ICreditRepository,
  JournalEntryQuery,
  JournalReferenceType,
  MonthlyResetResult,
  PortableJournalEntry,
  PortableReservation,
  PortableTransaction,
  PortableUsageLog,
  PortableUserCredits,
  ReservationStatus,
  SubscriptionExpiryResult,
  SubscriptionTier,
  TierUpdateInput,
  UsageLogQuery,
} from '@nehorai/credits'
import {
  getConfigMonthlyLimit,
  getConfigTierConfig,
} from '@nehorai/credits'
import { getNextMonthlyReset } from '@nehorai/credits'
import {
  creditBalances,
  creditJournalEntries,
  creditPluginTransactions,
  creditReservations,
  creditUsageLogs,
  type CreditBalanceRow,
  type CreditJournalEntryRow,
  type CreditPluginTransactionRow,
  type CreditReservationRow,
  type CreditUsageLogRow,
} from '../schema/index.js'

export interface DrizzleLikeDB {
  select: (...args: any[]) => any
  insert: (...args: any[]) => any
  update: (...args: any[]) => any
  transaction?: <T>(callback: (tx: DrizzleLikeDB) => Promise<T>) => Promise<T>
}

function numberValue(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function dateValue(value: Date | string | null | undefined): Date | null {
  if (!value) return null
  return value instanceof Date ? value : new Date(value)
}

function iso(value: Date | string | null | undefined): string {
  if (!value) return new Date().toISOString()
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toUserCredits(row: CreditBalanceRow): PortableUserCredits {
  return {
    userId: row.userId,
    balance: numberValue(row.balance),
    bonusCredits: numberValue(row.bonusCredits),
    reserved: numberValue(row.reserved),
    tier: row.tier as SubscriptionTier,
    monthlyLimit: numberValue(row.monthlyLimit),
    monthlyUsed: numberValue(row.monthlyUsed),
    monthlyResetAt: iso(row.monthlyResetAt),
    subscriptionExpiresAt: row.subscriptionExpiresAt ? iso(row.subscriptionExpiresAt) : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }
}

function toReservation(row: CreditReservationRow): PortableReservation {
  return {
    id: row.id,
    userId: row.userId,
    amount: numberValue(row.amount),
    operationType: row.operationType as CreditOperationType,
    status: row.status as ReservationStatus,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    completedAt: row.completedAt ? iso(row.completedAt) : undefined,
  }
}

function toTransaction(row: CreditPluginTransactionRow): PortableTransaction {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type as PortableTransaction['type'],
    amount: numberValue(row.amount),
    description: row.description,
    paymentRef: row.paymentRef ?? undefined,
    previousBalance: numberValue(row.previousBalance),
    newBalance: numberValue(row.newBalance),
    createdAt: iso(row.createdAt),
  }
}

function toUsageLog(row: CreditUsageLogRow): PortableUsageLog {
  return {
    id: row.id,
    userId: row.userId,
    operationType: row.operationType as CreditOperationType,
    provider: row.provider as AIProviderType,
    creditsUsed: numberValue(row.creditsUsed),
    success: row.success,
    errorMessage: row.errorMessage ?? undefined,
    resourceId: row.resourceId ?? undefined,
    resourceType: row.resourceType ?? undefined,
    requestId: row.requestId ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: iso(row.createdAt),
  }
}

function toJournalEntry(row: CreditJournalEntryRow): PortableJournalEntry {
  return {
    id: row.id,
    userId: row.userId,
    entryType: row.entryType as 'debit' | 'credit',
    amount: numberValue(row.amount),
    balanceAfter: numberValue(row.balanceAfter),
    source: row.source as PortableJournalEntry['source'],
    referenceId: row.referenceId,
    referenceType: row.referenceType as JournalReferenceType,
    description: row.description,
    metadata: row.metadata ?? undefined,
    createdAt: iso(row.createdAt),
  }
}

export class DrizzleCreditRepository implements ICreditRepository {
  constructor(private readonly db: DrizzleLikeDB) {}

  private async withTx<T>(callback: (tx: DrizzleLikeDB) => Promise<T>): Promise<T> {
    if (this.db.transaction) {
      return this.db.transaction(callback)
    }
    return callback(this.db)
  }

  private async ensureUserCredits(
    db: DrizzleLikeDB,
    userId: string,
    tier: SubscriptionTier = 'free'
  ): Promise<PortableUserCredits> {
    const existing = await db.select().from(creditBalances).where(eq(creditBalances.userId, userId)).limit(1)
    if (existing[0]) return toUserCredits(existing[0])

    const monthlyLimit = getConfigMonthlyLimit(tier)
    const initialBalance = Number.isFinite(monthlyLimit) ? monthlyLimit : 0
    const inserted = await db
      .insert(creditBalances)
      .values({
        userId,
        tier,
        balance: String(initialBalance),
        monthlyLimit: String(initialBalance),
        monthlyResetAt: getNextMonthlyReset(),
      })
      .onConflictDoNothing()
      .returning()

    if (inserted[0]) return toUserCredits(inserted[0])

    const afterConflict = await db.select().from(creditBalances).where(eq(creditBalances.userId, userId)).limit(1)
    if (!afterConflict[0]) {
      throw new Error(`Failed to initialize credits for user ${userId}`)
    }
    return toUserCredits(afterConflict[0])
  }

  async getUserCredits(userId: string): Promise<PortableUserCredits | null> {
    const rows = await this.db.select().from(creditBalances).where(eq(creditBalances.userId, userId)).limit(1)
    return rows[0] ? toUserCredits(rows[0]) : null
  }

  async initializeUserCredits(
    userId: string,
    tier: SubscriptionTier,
    initialBalance: number
  ): Promise<PortableUserCredits> {
    const monthlyLimit = getConfigMonthlyLimit(tier)
    const rows = await this.db
      .insert(creditBalances)
      .values({
        userId,
        tier,
        balance: String(initialBalance),
        monthlyLimit: String(Number.isFinite(monthlyLimit) ? monthlyLimit : 0),
        monthlyResetAt: getNextMonthlyReset(),
      })
      .onConflictDoUpdate({
        target: creditBalances.userId,
        set: { updatedAt: new Date() },
      })
      .returning()

    return toUserCredits(rows[0])
  }

  async updateUserCredits(userId: string, updates: CreditBalanceUpdate): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (updates.balance !== undefined) set.balance = String(updates.balance)
    if (updates.bonusCredits !== undefined) set.bonusCredits = String(updates.bonusCredits)
    if (updates.reserved !== undefined) set.reserved = String(updates.reserved)
    if (updates.tier !== undefined) set.tier = updates.tier
    if (updates.monthlyLimit !== undefined) set.monthlyLimit = String(updates.monthlyLimit)
    if (updates.monthlyUsed !== undefined) set.monthlyUsed = String(updates.monthlyUsed)
    if (updates.monthlyResetAt !== undefined) set.monthlyResetAt = dateValue(updates.monthlyResetAt)
    if (updates.subscriptionExpiresAt !== undefined) set.subscriptionExpiresAt = dateValue(updates.subscriptionExpiresAt)

    await this.db
      .update(creditBalances)
      .set({
        ...set,
        balance:
          updates.balanceIncrement !== undefined
            ? sql`${creditBalances.balance} + ${updates.balanceIncrement}`
            : set.balance,
        bonusCredits:
          updates.bonusCreditsIncrement !== undefined
            ? sql`${creditBalances.bonusCredits} + ${updates.bonusCreditsIncrement}`
            : set.bonusCredits,
        reserved:
          updates.reservedIncrement !== undefined
            ? sql`${creditBalances.reserved} + ${updates.reservedIncrement}`
            : set.reserved,
        monthlyUsed:
          updates.monthlyUsedIncrement !== undefined
            ? sql`${creditBalances.monthlyUsed} + ${updates.monthlyUsedIncrement}`
            : set.monthlyUsed,
      } as any)
      .where(eq(creditBalances.userId, userId))
  }

  async updateUserTier(userId: string, input: TierUpdateInput): Promise<void> {
    await this.db
      .update(creditBalances)
      .set({
        tier: input.tier,
        monthlyLimit: String(input.monthlyLimit),
        balance: input.balance !== undefined ? String(input.balance) : undefined,
        monthlyUsed: input.monthlyUsed !== undefined ? String(input.monthlyUsed) : undefined,
        subscriptionExpiresAt:
          input.subscriptionExpiresAt !== undefined ? dateValue(input.subscriptionExpiresAt) : undefined,
        updatedAt: new Date(),
      } as any)
      .where(eq(creditBalances.userId, userId))
  }

  async createReservation(input: CreateReservationInput): Promise<PortableReservation> {
    const rows = await this.db
      .insert(creditReservations)
      .values({
        userId: input.userId,
        amount: String(input.amount),
        operationType: input.operationType,
        expiresAt: input.expiresAt,
      })
      .returning()
    return toReservation(rows[0])
  }

  async getReservation(userId: string, reservationId: string): Promise<PortableReservation | null> {
    const rows = await this.db
      .select()
      .from(creditReservations)
      .where(and(eq(creditReservations.userId, userId), eq(creditReservations.id, reservationId)))
      .limit(1)
    return rows[0] ? toReservation(rows[0]) : null
  }

  async updateReservationStatus(
    userId: string,
    reservationId: string,
    status: ReservationStatus,
    completedAt?: Date
  ): Promise<void> {
    await this.db
      .update(creditReservations)
      .set({ status, completedAt: completedAt ?? new Date() })
      .where(and(eq(creditReservations.userId, userId), eq(creditReservations.id, reservationId)))
  }

  async reserveCreditsAtomic(
    userId: string,
    amount: number,
    operationType: CreditOperationType,
    expiresAt: Date
  ): Promise<PortableReservation> {
    return this.withTx(async (tx) => {
      await this.ensureUserCredits(tx, userId)
      const updated = await tx
        .update(creditBalances)
        .set({
          reserved: sql`${creditBalances.reserved} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(creditBalances.userId, userId),
            sql`${creditBalances.balance} + ${creditBalances.bonusCredits} - ${creditBalances.reserved} >= ${amount}`
          )
        )
        .returning()

      if (!updated[0]) {
        throw new Error(`Insufficient credits for user ${userId}`)
      }

      const reservation = await tx
        .insert(creditReservations)
        .values({
          userId,
          amount: String(amount),
          operationType,
          expiresAt,
        })
        .returning()
      return toReservation(reservation[0])
    })
  }

  async commitReservationAtomic(userId: string, reservationId: string): Promise<void> {
    await this.withTx(async (tx) => {
      const reservationRows = await tx
        .select()
        .from(creditReservations)
        .where(and(eq(creditReservations.userId, userId), eq(creditReservations.id, reservationId)))
        .limit(1)
      const reservation = reservationRows[0]
      if (!reservation) throw new Error(`Reservation ${reservationId} not found`)
      if (reservation.status === 'committed') return
      if (reservation.status !== 'reserved') {
        throw new Error(`Cannot commit reservation in ${reservation.status} state`)
      }

      const creditRows = await tx.select().from(creditBalances).where(eq(creditBalances.userId, userId)).limit(1)
      const credits = creditRows[0]
      if (!credits) throw new Error(`User credits not found for user ${userId}`)

      const amount = numberValue(reservation.amount)
      const balance = numberValue(credits.balance)
      const bonusCredits = numberValue(credits.bonusCredits)
      if (balance + bonusCredits < amount) {
        throw new Error(`Insufficient credits to commit reservation ${reservationId}`)
      }

      const balanceDeduction = Math.min(balance, amount)
      const bonusDeduction = amount - balanceDeduction
      const previousTotal = balance + bonusCredits
      const newTotal = previousTotal - amount

      await tx
        .update(creditBalances)
        .set({
          balance: String(balance - balanceDeduction),
          bonusCredits: String(bonusCredits - bonusDeduction),
          reserved: sql`greatest(${creditBalances.reserved} - ${amount}, 0)`,
          monthlyUsed: sql`${creditBalances.monthlyUsed} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(creditBalances.userId, userId))

      await tx
        .update(creditReservations)
        .set({ status: 'committed', completedAt: new Date() })
        .where(and(eq(creditReservations.userId, userId), eq(creditReservations.id, reservationId)))

      await tx.insert(creditJournalEntries).values({
        userId,
        entryType: 'debit',
        amount: String(amount),
        balanceAfter: String(newTotal),
        source: 'operation_commit',
        referenceId: reservationId,
        referenceType: 'reservation',
        description: `Committed ${amount} credits`,
      })
    })
  }

  async releaseReservationAtomic(userId: string, reservationId: string): Promise<void> {
    await this.withTx(async (tx) => {
      const reservationRows = await tx
        .select()
        .from(creditReservations)
        .where(and(eq(creditReservations.userId, userId), eq(creditReservations.id, reservationId)))
        .limit(1)
      const reservation = reservationRows[0]
      if (!reservation) throw new Error(`Reservation ${reservationId} not found`)
      if (reservation.status !== 'reserved') return

      const amount = numberValue(reservation.amount)
      await tx
        .update(creditBalances)
        .set({
          reserved: sql`greatest(${creditBalances.reserved} - ${amount}, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(creditBalances.userId, userId))
      await tx
        .update(creditReservations)
        .set({ status: 'released', completedAt: new Date() })
        .where(and(eq(creditReservations.userId, userId), eq(creditReservations.id, reservationId)))
    })
  }

  async addCreditsAtomic(
    userId: string,
    amount: number,
    description: string,
    paymentRef?: string,
    options?: AddCreditsAtomicOptions
  ): Promise<void> {
    await this.withTx(async (tx) => {
      if (paymentRef) {
        const existing = await tx
          .select()
          .from(creditPluginTransactions)
          .where(eq(creditPluginTransactions.paymentRef, paymentRef))
          .limit(1)
        if (existing[0]) return
      }

      const credits = await this.ensureUserCredits(tx, userId)
      const previousBalance = credits.balance + credits.bonusCredits
      const newBalance = previousBalance + amount

      await tx
        .update(creditBalances)
        .set({
          bonusCredits: sql`${creditBalances.bonusCredits} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(creditBalances.userId, userId))

      const inserted = await tx
        .insert(creditPluginTransactions)
        .values({
          userId,
          type: 'purchase',
          amount: String(amount),
          description,
          paymentRef,
          previousBalance: String(previousBalance),
          newBalance: String(newBalance),
        })
        .returning()

      const journalMetadata = {
        ...(paymentRef ? { paymentRef } : {}),
        ...(options?.metadata ?? {}),
      }

      await tx.insert(creditJournalEntries).values({
        userId,
        entryType: 'credit',
        amount: String(amount),
        balanceAfter: String(newBalance),
        source: options?.source ?? 'purchase',
        referenceId: inserted[0]?.id ?? paymentRef ?? 'unknown',
        referenceType: options?.referenceType ?? 'transaction',
        description,
        metadata: Object.keys(journalMetadata).length > 0 ? journalMetadata : undefined,
      })
    })
  }

  async deductCreditsAtomic(userId: string, amount: number): Promise<{ previousBalance: number; newBalance: number }> {
    return this.withTx(async (tx) => {
      // Single guarded UPDATE: the sufficiency predicate lives in the WHERE clause
      // so the check and the deduction happen atomically. Concurrent callers
      // serialize on the row lock and each re-evaluates the predicate against the
      // committed balance, so two of them can never both spend the same credits
      // (no lost-update / double-spend under READ COMMITTED). Balance is drawn
      // down first, then bonus credits — every SET expression references the
      // pre-update row, matching the previous split logic.
      const updated = await tx
        .update(creditBalances)
        .set({
          balance: sql`greatest(${creditBalances.balance} - ${amount}, 0)`,
          bonusCredits: sql`${creditBalances.bonusCredits} - greatest(${amount} - ${creditBalances.balance}, 0)`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(creditBalances.userId, userId),
            sql`${creditBalances.balance} + ${creditBalances.bonusCredits} - ${creditBalances.reserved} >= ${amount}`
          )
        )
        .returning()

      if (!updated[0]) {
        // No row changed: either the user has no ledger, or not enough available.
        // Disambiguate so callers keep the precise error they relied on.
        const existing = await tx
          .select()
          .from(creditBalances)
          .where(eq(creditBalances.userId, userId))
          .limit(1)
        if (!existing[0]) throw new Error(`User credits not found for user ${userId}`)
        const current = existing[0]
        const available =
          numberValue(current.balance) + numberValue(current.bonusCredits) - numberValue(current.reserved)
        throw new Error(`Insufficient credits. Available: ${available}, requested: ${amount}`)
      }

      const row = updated[0]
      const newBalance = numberValue(row.balance) + numberValue(row.bonusCredits)
      const previousBalance = newBalance + amount
      return { previousBalance, newBalance }
    })
  }

  async createTransaction(input: CreateTransactionInput): Promise<PortableTransaction> {
    const rows = await this.db
      .insert(creditPluginTransactions)
      .values({
        userId: input.userId,
        type: input.type,
        amount: String(input.amount),
        description: input.description,
        paymentRef: input.paymentRef,
        previousBalance: String(input.previousBalance),
        newBalance: String(input.newBalance),
      })
      .returning()
    return toTransaction(rows[0])
  }

  async getTransactions(userId: string, limit = 50, offset = 0): Promise<PortableTransaction[]> {
    const rows = await this.db
      .select()
      .from(creditPluginTransactions)
      .where(eq(creditPluginTransactions.userId, userId))
      .orderBy(desc(creditPluginTransactions.createdAt))
      .limit(limit)
      .offset(offset)
    return rows.map(toTransaction)
  }

  async logUsage(input: CreateUsageLogInput): Promise<PortableUsageLog> {
    const rows = await this.db
      .insert(creditUsageLogs)
      .values({
        userId: input.userId,
        operationType: input.operationType,
        provider: input.provider,
        creditsUsed: String(input.creditsUsed),
        success: input.success,
        errorMessage: input.errorMessage,
        resourceId: input.resourceId,
        resourceType: input.resourceType,
        requestId: input.requestId,
        metadata: input.metadata,
      })
      .returning()
    return toUsageLog(rows[0])
  }

  async getUsageLogs(query: UsageLogQuery): Promise<PortableUsageLog[]> {
    const filters = this.usageFilters(query)
    const rows = await this.db
      .select()
      .from(creditUsageLogs)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(creditUsageLogs.createdAt))
      .limit(query.limit ?? 50)
      .offset(query.offset ?? 0)
    return rows.map(toUsageLog)
  }

  async getUsageLogsCount(query: Omit<UsageLogQuery, 'limit' | 'offset'>): Promise<number> {
    const filters = this.usageFilters(query)
    const rows = await this.db
      .select({ value: count() })
      .from(creditUsageLogs)
      .where(filters.length ? and(...filters) : undefined)
    return Number(rows[0]?.value ?? 0)
  }

  async findAndExpireReservations(batchSize = 100, maxIterations = 100): Promise<{
    expiredCount: number
    creditsReleased: number
    errors: string[]
  }> {
    const errors: string[] = []
    let expiredCount = 0
    let creditsReleased = 0

    for (let i = 0; i < maxIterations; i += 1) {
      const rows = await this.db
        .select()
        .from(creditReservations)
        .where(and(eq(creditReservations.status, 'reserved'), lt(creditReservations.expiresAt, new Date())))
        .limit(batchSize)
      if (rows.length === 0) break

      for (const row of rows) {
        try {
          await this.releaseReservationAtomic(row.userId, row.id)
          await this.db
            .update(creditReservations)
            .set({ status: 'expired', completedAt: new Date() })
            .where(eq(creditReservations.id, row.id))
          expiredCount += 1
          creditsReleased += numberValue(row.amount)
        } catch (error) {
          errors.push(`Failed to expire reservation ${row.id}: ${String(error)}`)
        }
      }
    }

    return { expiredCount, creditsReleased, errors }
  }

  async atomicMonthlyReset(
    userId: string,
    tier: SubscriptionTier,
    expectedResetAt: Date | string
  ): Promise<MonthlyResetResult> {
    const newBalance = getConfigMonthlyLimit(tier)
    const nextReset = getNextMonthlyReset()
    const expected = dateValue(expectedResetAt)
    const rows = await this.db
      .update(creditBalances)
      .set({
        balance: Number.isFinite(newBalance) ? String(newBalance) : sql`${creditBalances.balance}`,
        monthlyUsed: '0',
        monthlyResetAt: nextReset,
        updatedAt: new Date(),
      } as any)
      .where(and(eq(creditBalances.userId, userId), eq(creditBalances.monthlyResetAt, expected as Date)))
      .returning()

    if (rows[0]) return { wasReset: true, credits: toUserCredits(rows[0]) }
    const current = await this.getUserCredits(userId)
    if (!current) throw new Error(`User ${userId} not found`)
    return { wasReset: false, credits: current }
  }

  async checkAndHandleSubscriptionExpiry(userId: string, gracePeriodDays = 3): Promise<SubscriptionExpiryResult> {
    const credits = await this.getUserCredits(userId)
    if (!credits) throw new Error(`User ${userId} not found`)

    const tierConfig = getConfigTierConfig(credits.tier) as { isFree?: boolean }
    if ((tierConfig.isFree ?? credits.tier === 'free') || !credits.subscriptionExpiresAt) {
      return { wasDowngraded: false, inGracePeriod: false, graceDaysRemaining: 0, credits }
    }

    const expiresAt = new Date(credits.subscriptionExpiresAt)
    const daysSinceExpiry = (Date.now() - expiresAt.getTime()) / (1000 * 60 * 60 * 24)
    if (daysSinceExpiry <= 0) {
      return { wasDowngraded: false, inGracePeriod: false, graceDaysRemaining: 0, credits }
    }
    if (daysSinceExpiry <= gracePeriodDays) {
      return {
        wasDowngraded: false,
        inGracePeriod: true,
        graceDaysRemaining: Math.ceil(gracePeriodDays - daysSinceExpiry),
        credits,
      }
    }

    const defaultTier = 'free' as SubscriptionTier
    const defaultTierConfig = getConfigTierConfig(defaultTier)
    await this.updateUserTier(userId, {
      tier: defaultTier,
      monthlyLimit: defaultTierConfig.monthlyCredits,
      balance: Math.min(credits.balance, defaultTierConfig.monthlyCredits),
      subscriptionExpiresAt: null,
    })
    const updatedCredits = (await this.getUserCredits(userId)) ?? credits
    return { wasDowngraded: true, inGracePeriod: false, graceDaysRemaining: 0, credits: updatedCredits }
  }

  async createJournalEntry(input: CreateJournalEntryInput): Promise<PortableJournalEntry> {
    const rows = await this.db
      .insert(creditJournalEntries)
      .values({
        userId: input.userId,
        entryType: input.entryType,
        amount: String(input.amount),
        balanceAfter: String(input.balanceAfter),
        source: input.source,
        referenceId: input.referenceId,
        referenceType: input.referenceType,
        description: input.description,
        metadata: input.metadata,
      })
      .returning()
    return toJournalEntry(rows[0])
  }

  async getJournalEntries(query: JournalEntryQuery): Promise<PortableJournalEntry[]> {
    const filters = this.journalFilters(query)
    const rows = await this.db
      .select()
      .from(creditJournalEntries)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(creditJournalEntries.createdAt))
      .limit(query.limit ?? 50)
      .offset(query.offset ?? 0)
    return rows.map(toJournalEntry)
  }

  async getJournalEntriesCount(query: Omit<JournalEntryQuery, 'limit' | 'offset'>): Promise<number> {
    const filters = this.journalFilters(query)
    const rows = await this.db
      .select({ value: count() })
      .from(creditJournalEntries)
      .where(filters.length ? and(...filters) : undefined)
    return Number(rows[0]?.value ?? 0)
  }

  private usageFilters(query: Omit<UsageLogQuery, 'limit' | 'offset'>): any[] {
    const filters: any[] = []
    if (query.userId) filters.push(eq(creditUsageLogs.userId, query.userId))
    if (query.operationType) filters.push(eq(creditUsageLogs.operationType, query.operationType))
    if (query.success !== undefined) filters.push(eq(creditUsageLogs.success, query.success))
    if (query.startDate) filters.push(gte(creditUsageLogs.createdAt, query.startDate))
    if (query.endDate) filters.push(lte(creditUsageLogs.createdAt, query.endDate))
    return filters
  }

  private journalFilters(query: Omit<JournalEntryQuery, 'limit' | 'offset'>): any[] {
    const filters: any[] = [eq(creditJournalEntries.userId, query.userId)]
    if (query.source) filters.push(eq(creditJournalEntries.source, query.source))
    if (query.referenceType) filters.push(eq(creditJournalEntries.referenceType, query.referenceType))
    if (query.startDate) filters.push(gte(creditJournalEntries.createdAt, query.startDate))
    if (query.endDate) filters.push(lte(creditJournalEntries.createdAt, query.endDate))
    return filters
  }
}

export function createDrizzleCreditRepository(db: DrizzleLikeDB): DrizzleCreditRepository {
  return new DrizzleCreditRepository(db)
}
