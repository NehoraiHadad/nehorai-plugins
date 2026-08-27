import { and, count, desc, eq, gte, lte, lt, sql } from 'drizzle-orm'
import type {
  AddCreditsAtomicOptions,
  CommitOutcome,
  CreateJournalEntryInput,
  CreateReservationInput,
  CreateTransactionInput,
  CreateUsageLogInput,
  CreditBalanceUpdate,
  CreditOperationType,
  ExpireOutcome,
  ExpireReservationV2Options,
  ICreditRepository,
  ICreditRepositoryV2,
  JournalEntryQuery,
  MonthlyResetResult,
  PortableJournalEntry,
  PortableReservation,
  PortableTransaction,
  PortableUsageLog,
  PortableUserCredits,
  ReleaseOutcome,
  ReservationStatus,
  ReservationTransitionOptions,
  ReserveCreditsV2Input,
  ReserveOutcome,
  SubscriptionExpiryResult,
  SubscriptionTier,
  TierUpdateInput,
  UsageLogQuery,
} from '@nehorai/credits'
import {
  createInsufficientCreditsError,
  createReservationAlreadyProcessedError,
  createReservationNotFoundError,
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
} from '../schema/index.js'
import { withTx, type DrizzleLikeDB } from './db.js'
import { ensureUserCredits } from './ensure-user.js'
import {
  dateValue,
  numberValue,
  toJournalEntry,
  toReservation,
  toTransaction,
  toUsageLog,
  toUserCredits,
} from './mappers.js'
import { commitReservationV2 } from './v2/commit.js'
import { expireReservationV2, releaseReservationV2 } from './v2/release-expire.js'
import { reserveCreditsV2 } from './v2/reserve.js'

export type { DrizzleLikeDB } from './db.js'

export class DrizzleCreditRepository implements ICreditRepository {
  constructor(private readonly db: DrizzleLikeDB) {}

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
        idempotencyKey: input.idempotencyKey ?? null,
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

  // ==================== V2 boundary ====================
  //
  // The four V2 methods below are the real implementation; the legacy
  // `*Atomic` methods are thin adapters over them. Routing both through one
  // code path means a caller on the old API still gets the locking, the
  // status CAS and the single-journal guarantee — it just loses the ability
  // to tell a winner from a duplicate delivery.

  async reserveCreditsV2(input: ReserveCreditsV2Input): Promise<ReserveOutcome> {
    return reserveCreditsV2(this.db, input)
  }

  async commitReservationV2(
    userId: string,
    reservationId: string,
    options?: ReservationTransitionOptions
  ): Promise<CommitOutcome> {
    return commitReservationV2(this.db, userId, reservationId, options)
  }

  async releaseReservationV2(
    userId: string,
    reservationId: string,
    options?: ReservationTransitionOptions
  ): Promise<ReleaseOutcome> {
    return releaseReservationV2(this.db, userId, reservationId, options)
  }

  async expireReservationV2(
    userId: string,
    reservationId: string,
    options?: ExpireReservationV2Options
  ): Promise<ExpireOutcome> {
    return expireReservationV2(this.db, userId, reservationId, options)
  }

  // ==================== Legacy atomic operations ====================

  async reserveCreditsAtomic(
    userId: string,
    amount: number,
    operationType: CreditOperationType,
    expiresAt: Date
  ): Promise<PortableReservation> {
    const outcome = await this.reserveCreditsV2({ userId, amount, operationType, expiresAt })
    if (outcome.outcome === 'created' || outcome.outcome === 'replayed') return outcome.reservation
    if (outcome.outcome === 'insufficient') {
      throw createInsufficientCreditsError(outcome.required, outcome.available)
    }
    // Unreachable without an idempotency key, but never silently succeed.
    throw createReservationAlreadyProcessedError(outcome.existing.id, outcome.existing.status)
  }

  async commitReservationAtomic(userId: string, reservationId: string): Promise<void> {
    const outcome = await this.commitReservationV2(userId, reservationId)
    if (outcome.outcome === 'committed') return
    if (outcome.outcome === 'not_found') throw createReservationNotFoundError(reservationId)
    // A re-delivered commit of an already-committed reservation stays a no-op,
    // matching the previous contract.
    if (outcome.terminalStatus === 'committed') return
    throw createReservationAlreadyProcessedError(reservationId, outcome.terminalStatus)
  }

  async releaseReservationAtomic(userId: string, reservationId: string): Promise<void> {
    const outcome = await this.releaseReservationV2(userId, reservationId)
    if (outcome.outcome === 'not_found') throw createReservationNotFoundError(reservationId)
    // Releasing an already-terminal reservation is a no-op, as before.
  }

  async addCreditsAtomic(
    userId: string,
    amount: number,
    description: string,
    paymentRef?: string,
    options?: AddCreditsAtomicOptions
  ): Promise<void> {
    await withTx(this.db, async (tx) => {
      if (paymentRef) {
        const existing = await tx
          .select()
          .from(creditPluginTransactions)
          .where(eq(creditPluginTransactions.paymentRef, paymentRef))
          .limit(1)
        if (existing[0]) return
      }

      const credits = await ensureUserCredits(tx, userId)
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
    return withTx(this.db, async (tx) => {
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

  /**
   * Expire every hold whose deadline has passed.
   *
   * Each reservation is expired by a single guarded transaction
   * ({@link expireReservationV2}) that locks the row, checks the deadline and
   * flips the status in one CAS. The previous implementation released the hold
   * and then overwrote the status in a second, unguarded statement — a commit
   * landing between the two would have its credits handed back and then be
   * relabelled `expired`.
   */
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

      let progressed = 0
      for (const row of rows) {
        try {
          const outcome = await this.expireReservationV2(row.userId, row.id)
          if (outcome.outcome === 'expired') {
            expiredCount += 1
            creditsReleased += outcome.amount
            progressed += 1
          } else if (outcome.outcome !== 'not_due') {
            // Someone else committed/released it first — the sweep did its job
            // by not double-counting, and the row is no longer a candidate.
            progressed += 1
          }
        } catch (error) {
          errors.push(`Failed to expire reservation ${row.id}: ${String(error)}`)
        }
      }

      // Nothing in this batch changed state, so the next SELECT would return
      // the same rows. Stop instead of spinning until maxIterations.
      if (progressed === 0) break
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
        idempotencyKey: input.idempotencyKey ?? null,
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
