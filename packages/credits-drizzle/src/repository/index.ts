import { and, count, desc, eq, gte, lte, lt, notInArray, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type {
  AddCreditsAtomicOptions,
  AddCreditsOutcome,
  AddCreditsV2Input,
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
  ICreditRepositoryCreditsV2,
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
  createPaymentRefConflictError,
  createReservationAlreadyProcessedError,
  createReservationNotFoundError,
  getConfigMonthlyLimit,
  getConfigTierConfig,
  getDefaultTier,
  monthlyResetBalance,
  normalizePaymentRef,
} from '@nehorai/credits'
import {
  assertRepresentableAmount,
  assertRepresentableFields,
  assertRepresentableTierAmount,
  storedMonthlyLimit,
  assertValidCreditAmount,
  assertValidIdempotencyKey,
  assertUnkeyedDirectReservation,
  assertDirectStatusWriteAllowed,
  assertUnreferencedDirectTransaction,
  classifyDatabaseError,
  assertPublicJournalKey,
  backedBalanceFloor,
  getNextMonthlyReset,
  sumAmounts,
} from '@nehorai/credits'
import {
  creditBalances,
  creditJournalEntries,
  creditPluginTransactions,
  creditReservations,
  creditUsageLogs,
} from '../schema/index.js'
import { withTx, type DrizzleLikeDB } from './db.js'
import {
  ensureUserCredits,
  lockUserCredits,
  lockUserCreditsIfPresent,
} from './ensure-user.js'
import {
  dateValue,
  toJournalEntry,
  toReservation,
  toTransaction,
  toUsageLog,
  toUserCredits,
} from './mappers.js'
import { addCreditsV2 } from './add-credits.js'
import { commitReservationV2 } from './v2/commit.js'
import { expireReservationV2, releaseReservationV2 } from './v2/release-expire.js'
import { reserveCreditsV2 } from './v2/reserve.js'
import { rejectOverflowAsAmountError } from './v2/shared.js'

export type { DrizzleLikeDB } from './db.js'

/**
 * Run a V2 operation and normalise whatever escapes it into a `CreditError`.
 *
 * This is the outermost boundary of the adapter, so it is the only place that
 * knows both that a driver error happened and which operation it happened in.
 * `classifyDatabaseError` returns an existing `CreditError` untouched — so an
 * `INSUFFICIENT_CREDITS`, `IDEMPOTENCY_CONFLICT`, `INVALID_AMOUNT`,
 * `UNSUPPORTED_OPERATION` or invariant `DATABASE_ERROR` raised deliberately
 * inside keeps its meaning, and only genuinely unknown driver failures get
 * classified by SQLSTATE.
 *
 * A caveat worth stating rather than hiding: a class `08` connection failure is
 * reported as `TRANSIENT_ERROR`, but if the connection dropped *during* COMMIT
 * the operation may in fact have succeeded. Retrying is only safe when the
 * retry is idempotent — which for reserve means passing an `idempotencyKey`,
 * and for the transitions is guaranteed by the status CAS.
 */
async function classified<T>(
  run: () => Promise<T>,
  context: Record<string, unknown>
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw classifyDatabaseError(error, context)
  }
}

export class DrizzleCreditRepository implements ICreditRepository, ICreditRepositoryCreditsV2 {
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
    // Zero is a legitimate starting balance, so this is a representability
    // check rather than a spendability one. Without it, `1.005` was silently
    // rounded by the column and `1e12` escaped as a raw SQLSTATE 22003.
    assertRepresentableAmount(initialBalance, 'initialBalance', { userId })

    // Derived from tier configuration, not from the caller, and just as able
    // to be unrepresentable. Previously coerced to 0 when non-finite, which
    // silently gave an unlimited tier a zero limit.
    const monthlyLimit = getConfigMonthlyLimit(tier)
    assertRepresentableTierAmount(monthlyLimit, 'monthlyLimit', { userId, tier })
    const rows = await this.db
      .insert(creditBalances)
      .values({
        userId,
        tier,
        balance: String(initialBalance),
        monthlyLimit: String(storedMonthlyLimit(monthlyLimit)),
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
    assertRepresentableFields(
      {
        balance: updates.balance,
        bonusCredits: updates.bonusCredits,
        reserved: updates.reserved,
        monthlyLimit: updates.monthlyLimit,
        monthlyUsed: updates.monthlyUsed,
        balanceIncrement: updates.balanceIncrement,
        bonusCreditsIncrement: updates.bonusCreditsIncrement,
        reservedIncrement: updates.reservedIncrement,
        monthlyUsedIncrement: updates.monthlyUsedIncrement,
      },
      { userId, operation: 'updateUserCredits' }
    )

    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (updates.balance !== undefined) set.balance = String(updates.balance)
    if (updates.bonusCredits !== undefined) set.bonusCredits = String(updates.bonusCredits)
    if (updates.reserved !== undefined) set.reserved = String(updates.reserved)
    if (updates.tier !== undefined) set.tier = updates.tier
    if (updates.monthlyLimit !== undefined) set.monthlyLimit = String(updates.monthlyLimit)
    if (updates.monthlyUsed !== undefined) set.monthlyUsed = String(updates.monthlyUsed)
    if (updates.monthlyResetAt !== undefined) set.monthlyResetAt = dateValue(updates.monthlyResetAt)
    if (updates.subscriptionExpiresAt !== undefined) set.subscriptionExpiresAt = dateValue(updates.subscriptionExpiresAt)

    // The increments are summed by PostgreSQL, so an overflow surfaces as a raw
    // SQLSTATE 22003 rather than as anything a caller can branch on. The
    // in-memory adapter refuses the same inputs with `INVALID_AMOUNT`; this
    // makes the two agree.
    //
    // `incrementFrom` rather than a bare `column + delta`: when a call supplies
    // both the absolute field and its increment, the column expression read the
    // *stored* value and silently discarded the absolute, while the in-memory
    // adapter applied the increment on top of it. Same input, two different
    // stored results. The absolute now seeds the sum when it is present.
    await rejectOverflowAsAmountError(userId, 'updateUserCredits', incrementedColumns(updates), () =>
      this.db
      .update(creditBalances)
      .set({
        ...set,
        balance: incrementFrom(creditBalances.balance, set.balance, updates.balanceIncrement),
        bonusCredits: incrementFrom(
          creditBalances.bonusCredits,
          set.bonusCredits,
          updates.bonusCreditsIncrement
        ),
        reserved: incrementFrom(creditBalances.reserved, set.reserved, updates.reservedIncrement),
        monthlyUsed: incrementFrom(
          creditBalances.monthlyUsed,
          set.monthlyUsed,
          updates.monthlyUsedIncrement
        ),
      } as any)
        .where(eq(creditBalances.userId, userId))
    )
  }

  async updateUserTier(userId: string, input: TierUpdateInput): Promise<void> {
    assertRepresentableFields(
      { monthlyLimit: input.monthlyLimit, balance: input.balance, monthlyUsed: input.monthlyUsed },
      { userId, operation: 'updateUserTier' }
    )

    await this.db
      .update(creditBalances)
      .set({
        tier: input.tier,
        monthlyLimit: String(input.monthlyLimit),
        // A tier write may lower the balance, but never below what still backs
        // the outstanding holds: cutting `balance + bonusCredits` under
        // `reserved` strands every live reservation at commit time. The floor
        // is computed by PostgreSQL from the row's own columns, so it cannot
        // race a concurrent reserve. See `backedBalanceFloor` in the core
        // package; the in-memory adapter applies the same clamp.
        balance:
          input.balance !== undefined
            ? sql`greatest(${String(input.balance)}::numeric, greatest(${creditBalances.reserved} - ${creditBalances.bonusCredits}, 0::numeric))`
            : undefined,
        monthlyUsed: input.monthlyUsed !== undefined ? String(input.monthlyUsed) : undefined,
        subscriptionExpiresAt:
          input.subscriptionExpiresAt !== undefined ? dateValue(input.subscriptionExpiresAt) : undefined,
        updatedAt: new Date(),
      } as any)
      .where(eq(creditBalances.userId, userId))
  }

  async createReservation(input: CreateReservationInput): Promise<PortableReservation> {
    // The V2 transitions re-validate what they lock, but a row that never
    // should have existed is still worth refusing at the point of writing: an
    // amount off the cent grid or below zero has no repair path once persisted
    // except an operator with SQL.
    assertValidCreditAmount(input.amount, { userId: input.userId, operation: 'createReservation' })
    // A key here would name a hold this method does not place: the INSERT below
    // leaves `credit_balances.reserved` alone. `reserveCreditsV2` would then
    // adopt the row as a `replayed` reservation, and its commit would spend
    // another hold's coverage. The row is written without a key and without the
    // hold-origin fact, so the V2 transitions refuse it as well.
    assertUnkeyedDirectReservation(input)

    const rows = await this.db
      .insert(creditReservations)
      .values({
        userId: input.userId,
        amount: String(input.amount),
        operationType: input.operationType,
        expiresAt: input.expiresAt,
        idempotencyKey: null,
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
    // A backed hold's status is owned by the transition that settles it, and no
    // row may be reopened: this method assigns a status and nothing else, so on
    // a V2 row it would change the status without the ledger movement the
    // status stands for. See `assertDirectStatusWriteAllowed`. The row's
    // `holdPlacedAt` is immutable after creation, so the read is not racing the
    // reserve path — but the UPDATE still repeats the predicate as
    // `hold_placed_at IS NULL`, so a row this code misread cannot be written.
    const existing = await this.getReservation(userId, reservationId)
    if (existing) assertDirectStatusWriteAllowed(existing, status)
    else if (status === 'reserved') {
      // The reopen refusal must not depend on the row being readable.
      assertDirectStatusWriteAllowed({ id: reservationId, userId, status: 'reserved' }, status)
    }

    await this.db
      .update(creditReservations)
      .set({ status, completedAt: completedAt ?? new Date() })
      .where(
        and(
          eq(creditReservations.userId, userId),
          eq(creditReservations.id, reservationId),
          sql`${creditReservations.holdPlacedAt} is null`
        )
      )
  }

  // ==================== V2 boundary ====================
  //
  // The four V2 methods below are the real implementation; the legacy
  // `*Atomic` methods are thin adapters over them. Routing both through one
  // code path means a caller on the old API still gets the locking, the
  // status CAS and the single-journal guarantee — it just loses the ability
  // to tell a winner from a duplicate delivery.

  async reserveCreditsV2(input: ReserveCreditsV2Input): Promise<ReserveOutcome> {
    return classified(() => reserveCreditsV2(this.db, input), {
      operation: 'reserveCreditsV2',
      userId: input.userId,
    })
  }

  async commitReservationV2(
    userId: string,
    reservationId: string,
    options?: ReservationTransitionOptions
  ): Promise<CommitOutcome> {
    return classified(() => commitReservationV2(this.db, userId, reservationId, options), {
      operation: 'commitReservationV2',
      userId,
      reservationId,
    })
  }

  async releaseReservationV2(
    userId: string,
    reservationId: string,
    options?: ReservationTransitionOptions
  ): Promise<ReleaseOutcome> {
    return classified(() => releaseReservationV2(this.db, userId, reservationId, options), {
      operation: 'releaseReservationV2',
      userId,
      reservationId,
    })
  }

  async expireReservationV2(
    userId: string,
    reservationId: string,
    options?: ExpireReservationV2Options
  ): Promise<ExpireOutcome> {
    return classified(() => expireReservationV2(this.db, userId, reservationId, options), {
      operation: 'expireReservationV2',
      userId,
      reservationId,
    })
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

  /**
   * Credit an account and say what happened to the `paymentRef`.
   *
   * The work lives in `add-credits.ts`; this is the interface surface.
   */
  async addCreditsV2(input: AddCreditsV2Input): Promise<AddCreditsOutcome> {
    return addCreditsV2(this.db, input)
  }

  /**
   * The legacy signature, on top of {@link addCreditsV2}.
   *
   * `Promise<void>` has nowhere to report a conflict, and silently returning is
   * indistinguishable from "credited" - the exact failure this round is
   * closing - so a conflict throws. A genuine replay still returns quietly,
   * because that *is* the idempotent no-op the caller asked for.
   */
  async addCreditsAtomic(
    userId: string,
    amount: number,
    description: string,
    paymentRef?: string,
    options?: AddCreditsAtomicOptions
  ): Promise<void> {
    const outcome = await this.addCreditsV2({ userId, amount, description, paymentRef, options })
    if (outcome.outcome === 'conflict') {
      throw createPaymentRefConflictError(outcome.paymentRef, {
        userId,
        mismatch: outcome.mismatch,
        existingUserId: outcome.existing.userId,
      })
    }
  }

  async deductCreditsAtomic(userId: string, amount: number): Promise<{ previousBalance: number; newBalance: number }> {
    // Validated here rather than only in the service, so a caller holding the
    // repository directly cannot push `Infinity` or a third decimal into the
    // `numeric(12, 2)` arithmetic below.
    assertValidCreditAmount(amount, { userId, operation: 'deductCredits' })

    return rejectOverflowAsAmountError(
      userId,
      'deductCredits',
      ['balance', 'bonusCredits', 'previousBalance', 'newBalance'],
      () =>
      withTx(this.db, async (tx) => {
      // Locked read, then check, then literal write. This used to be a single
      // guarded UPDATE with the sufficiency predicate in the WHERE clause; the
      // derived totals it produced were computed by PostgreSQL, so an
      // unstorable one arrived as a bare SQLSTATE 22003 that could not say
      // which expression overflowed. Atomicity is unchanged: concurrent callers
      // now serialize on `SELECT ... FOR UPDATE` instead of on the predicate,
      // and each re-reads the committed row, so two of them still cannot both
      // spend the same credits under READ COMMITTED. Balance is drawn down
      // first, then bonus credits, as before.
      const credits = await lockUserCreditsIfPresent(tx, userId)
      if (!credits) throw new Error(`User credits not found for user ${userId}`)

      const available = sumAmounts(credits.balance, credits.bonusCredits, -credits.reserved)
      if (available < amount) {
        throw new Error(`Insufficient credits. Available: ${available}, requested: ${amount}`)
      }

      // Drain balance before bonus, matching the in-memory adapter and commit.
      const balanceDeduction = Math.min(credits.balance, amount)
      const nextBalance = sumAmounts(credits.balance, -balanceDeduction)
      const nextBonusCredits = sumAmounts(credits.bonusCredits, -sumAmounts(amount, -balanceDeduction))
      // `previousBalance` and `newBalance` are *totals*, so each column can sit
      // legally at the ceiling while their sum does not fit. They are returned
      // to the caller and, for `addCredits`, stored — so they are checked under
      // their own names before the row moves, exactly as the in-memory adapter
      // checks them.
      const previousBalance = sumAmounts(credits.balance, credits.bonusCredits)
      const newBalance = sumAmounts(previousBalance, -amount)
      assertRepresentableFields(
        { previousBalance, balance: nextBalance, bonusCredits: nextBonusCredits, newBalance },
        { userId, operation: 'deductCredits' }
      )

      await tx
        .update(creditBalances)
        .set({
          balance: String(nextBalance),
          bonusCredits: String(nextBonusCredits),
          updatedAt: new Date(),
        })
        .where(eq(creditBalances.userId, userId))

      return { previousBalance, newBalance }
      })
    )
  }

  async createTransaction(input: CreateTransactionInput): Promise<PortableTransaction> {
    // A record with a `paymentRef` would occupy the global payment boundary
    // without crediting anyone — a later addCredits with the same reference
    // then reports `replayed` and credits nothing. Referenced payments go
    // through addCredits; see `assertUnreferencedDirectTransaction`.
    assertUnreferencedDirectTransaction(input)
    // Ledger record, not a movement: a correcting transaction may legitimately
    // be negative and a balance may legitimately be below zero, so these are
    // checked for what `numeric(12, 2)` can hold rather than for spendability.
    assertRepresentableAmount(input.amount, 'transaction amount', { userId: input.userId })
    assertRepresentableAmount(input.previousBalance, 'transaction previousBalance', {
      userId: input.userId,
    })
    assertRepresentableAmount(input.newBalance, 'transaction newBalance', { userId: input.userId })

    const rows = await this.db
      .insert(creditPluginTransactions)
      .values({
        userId: input.userId,
        type: input.type,
        amount: String(input.amount),
        description: input.description,
        // Always absent after the guard above; spelled as the normalised value
        // so a blank string can never occupy a payment_ref index slot.
        paymentRef: normalizePaymentRef(input.paymentRef),
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
    assertRepresentableAmount(input.creditsUsed, 'creditsUsed', { userId: input.userId })

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
    // Rows that failed this run. Excluded from later batches so a handful of
    // corrupt reservations cannot sit at the head of every `LIMIT` and starve
    // the healthy ones behind them for the rest of the sweep.
    const skip = new Set<string>()
    let expiredCount = 0
    let creditsReleased = 0

    for (let i = 0; i < maxIterations; i += 1) {
      const due = and(
        eq(creditReservations.status, 'reserved'),
        lt(creditReservations.expiresAt, new Date())
      )
      const rows = await this.db
        .select()
        .from(creditReservations)
        .where(skip.size ? and(due, notInArray(creditReservations.id, [...skip])) : due)
        .limit(batchSize)
      if (rows.length === 0) break

      let progressed = 0
      let skipped = 0
      for (const row of rows) {
        try {
          const outcome = await this.expireReservationV2(row.userId, row.id)
          if (outcome.outcome === 'expired') {
            expiredCount += 1
            creditsReleased = sumAmounts(creditsReleased, outcome.amount)
            progressed += 1
          } else if (outcome.outcome !== 'not_due') {
            // Someone else committed/released it first — the sweep did its job
            // by not double-counting, and the row is no longer a candidate.
            progressed += 1
          }
        } catch (error) {
          // One bad row must not abort the sweep, and must not be retried
          // forever: record it, skip it, keep going.
          errors.push(`Failed to expire reservation ${row.id}: ${String(error)}`)
          skip.add(row.id)
          skipped += 1
        }
      }

      // Stop only when the batch neither changed state nor grew the skip set:
      // then the next SELECT really would return the same rows. A batch that
      // was *entirely* poison still counts as progress, because the exclusion
      // list grew and the following query reaches the healthy rows behind it —
      // stopping there would reintroduce the starvation this guards against.
      if (progressed === 0 && skipped === 0) break
    }

    return { expiredCount, creditsReleased, errors }
  }

  async atomicMonthlyReset(
    userId: string,
    tier: SubscriptionTier,
    expectedResetAt: Date | string
  ): Promise<MonthlyResetResult> {
    assertRepresentableTierAmount(getConfigMonthlyLimit(tier), 'monthlyLimit', { userId, tier })
    // One canonical reset contract, shared with the in-memory adapter: a
    // metered tier resets to its exact limit, an unlimited tier to *at least*
    // the sentinel, and never below what still backs the outstanding holds
    // (`backedBalanceFloor` — cutting `balance + bonusCredits` under `reserved`
    // strands every live reservation at commit time).
    const target = monthlyResetBalance(tier)
    const expected = dateValue(expectedResetAt)

    // One transaction for the CAS, the balance write AND the journal line. The
    // journal used to be a separate service call after this method returned; a
    // failure there landed after the CAS was already consumed, so no retry ever
    // saw the reset again and the line was lost for good. The row is locked
    // FOR UPDATE, which serializes this against every balance writer — so
    // deriving the new balance in code from the locked row cannot race a
    // concurrent reserve or commit.
    return await withTx(this.db, async (tx) => {
      const current = await lockUserCreditsIfPresent(tx, userId)
      if (!current) throw new Error(`User ${userId} not found`)
      // An unparseable expected value can never match the column: CAS mismatch.
      if (!expected) return { wasReset: false, credits: current }

      const floor = backedBalanceFloor(current.reserved, current.bonusCredits)
      const newBalance =
        target.kind === 'atLeast'
          ? Math.max(current.balance, target.value, floor)
          : Math.max(target.value, floor)

      // The CAS is the SQL predicate below, evaluated by PostgreSQL against
      // the stored column — never a JS `getTime()` compare over driver-mapped
      // values, which cannot see the column at all below one millisecond.
      //
      // Its granularity is deliberate: the caller's expectation arrives
      // through a JS `Date`, which cannot express microseconds, so exact
      // equality would *permanently* refuse any row whose stored value carries
      // genuine sub-millisecond precision (schema-valid, e.g. written by SQL
      // `now()`) — the caller re-reads, re-truncates, re-mismatches, forever.
      // The predicate therefore accepts exactly the one millisecond the caller
      // names: `expected <= monthly_reset_at < expected + 1ms`. That is the
      // full precision the interface can express, and it is sound here because
      // the row is locked FOR UPDATE (nothing moves during the operation) and
      // every reset advances the column by about a month — a *stale*
      // expectation therefore misses by far more than a millisecond and
      // refuses. A successful reset writes a millisecond-precision JS date, so
      // the row is exact-round-trip from then on.
      const rows = await tx
        .update(creditBalances)
        .set({
          balance: String(newBalance),
          monthlyUsed: '0',
          monthlyResetAt: getNextMonthlyReset(),
          updatedAt: new Date(),
        } as any)
        .where(
          and(
            eq(creditBalances.userId, userId),
            gte(creditBalances.monthlyResetAt, expected),
            lt(creditBalances.monthlyResetAt, new Date(expected.getTime() + 1))
          )
        )
        .returning()
      if (!rows[0]) {
        // Another request already performed the reset.
        return { wasReset: false, credits: current }
      }
      const credits = toUserCredits(rows[0])

      const change = sumAmounts(newBalance, -current.balance)
      if (change !== 0) {
        await tx.insert(creditJournalEntries).values({
          userId,
          entryType: change > 0 ? 'credit' : 'debit',
          amount: String(Math.abs(change)),
          balanceAfter: String(sumAmounts(credits.balance, credits.bonusCredits)),
          source: 'monthly_reset',
          referenceId: `reset-${Date.now()}`,
          referenceType: 'reset',
          description: `Monthly credit reset for ${tier} tier.`,
          metadata: { tier, previousBalance: current.balance, newBalance: credits.balance },
        })
      }

      return { wasReset: true, credits, journaled: true }
    })
  }

  async checkAndHandleSubscriptionExpiry(userId: string, gracePeriodDays = 3): Promise<SubscriptionExpiryResult> {
    // Eligibility is decided from a row locked FOR UPDATE, in the same
    // transaction as the downgrade. Deciding from an unlocked read let two
    // races through: a renewal committing between the read and the write was
    // overwritten (the account downgraded and its new expiry cleared), and two
    // concurrent expiry workers both saw the expired state and both reported
    // `wasDowngraded: true` — duplicate journal lines and notifications. Under
    // the lock, a renewal that committed first is visible here, one that
    // arrives later queues behind us, and a second worker re-reads the
    // already-downgraded row and returns without acting.
    return await withTx(this.db, async (tx) => {
      const credits = await lockUserCreditsIfPresent(tx, userId)
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

      // `getDefaultTier()`, not a hard-coded `'free'`: an app is free to
      // configure a different default, and the in-memory adapter has always
      // honoured it. Hard-coding here made the two adapters downgrade the same
      // user onto different tiers.
      const defaultTier = getDefaultTier()
      // `getConfigMonthlyLimit`, not the raw `monthlyCredits`: in tier *config*
      // zero means unlimited, so reading the field directly would downgrade onto
      // an unlimited default tier with a limit and a balance of zero.
      const limit = storedMonthlyLimit(getConfigMonthlyLimit(defaultTier))
      assertRepresentableFields({ monthlyLimit: limit }, { userId, operation: 'subscriptionExpiry' })
      // The clamp target is `least(balance, limit)` computed by PostgreSQL from
      // the row's live column, floored at the hold backing on the same terms as
      // `updateUserTier` (see `backedBalanceFloor`) — so even outside the lock
      // this write could never re-mint credits a concurrent commit had spent.
      const rows = await tx
        .update(creditBalances)
        .set({
          tier: defaultTier,
          monthlyLimit: String(limit),
          balance: sql`greatest(least(${creditBalances.balance}, ${String(limit)}::numeric), greatest(${creditBalances.reserved} - ${creditBalances.bonusCredits}, 0::numeric))`,
          subscriptionExpiresAt: null,
          updatedAt: new Date(),
        } as any)
        .where(eq(creditBalances.userId, userId))
        .returning()
      const updatedCredits = rows[0] ? toUserCredits(rows[0]) : credits

      // The journal line commits with the downgrade or not at all. Written
      // separately by the service, a failure landed after the tier write had
      // committed — and no retry ever fired again, because the row was no
      // longer eligible. The audit line was permanently gone.
      await tx.insert(creditJournalEntries).values({
        userId,
        entryType: 'debit',
        amount: '0', // No credits deducted, just tier change
        balanceAfter: String(sumAmounts(updatedCredits.balance, updatedCredits.bonusCredits)),
        source: 'subscription_downgrade',
        referenceId: `downgrade-${Date.now()}`,
        referenceType: 'subscription',
        description: `Subscription expired. Downgraded from ${credits.tier} to ${defaultTier} tier.`,
        metadata: {
          previousTier: credits.tier,
          previousBalance: credits.balance,
          newBalance: updatedCredits.balance,
        },
      })

      return {
        wasDowngraded: true,
        inGracePeriod: false,
        graceDaysRemaining: 0,
        credits: updatedCredits,
        journaled: true,
      }
    })
  }

  async createJournalEntry(input: CreateJournalEntryInput): Promise<PortableJournalEntry> {
    // `amount` is 0 on a release entry and `balanceAfter` goes negative on a
    // corrected account, so both are representability checks, not spendability.
    assertRepresentableAmount(input.amount, 'journal amount', { userId: input.userId })
    assertRepresentableAmount(input.balanceAfter, 'journal balanceAfter', { userId: input.userId })
    assertValidIdempotencyKey(input.idempotencyKey, { userId: input.userId })
    assertPublicJournalKey(input.idempotencyKey, input.userId)

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


/**
 * Name the columns PostgreSQL will be summing for this update.
 *
 * An overflow can only come from a column the caller asked to increment, so
 * this is the exact candidate set for the error's `field`. Direct assignments
 * are excluded: those values were already validated in JS before the statement
 * was built, so they cannot be the operand that failed.
 */
/**
 * The value to store for one column of an `updateUserCredits` call.
 *
 * With no increment the absolute assignment stands (or the column is left
 * alone). With an increment the sum is computed by PostgreSQL, from the
 * absolute value when the same call supplied one and from the stored column
 * otherwise — which is what the in-memory adapter does, and what a caller
 * passing both would expect.
 */
function incrementFrom(
  column: AnyPgColumn,
  absolute: unknown,
  increment: number | undefined
): unknown {
  if (increment === undefined) return absolute
  const base = absolute === undefined ? sql`${column}` : sql`${String(absolute)}::numeric`
  return sql`${base} + ${increment}`
}

function incrementedColumns(updates: CreditBalanceUpdate): string[] {
  return [
    updates.balanceIncrement !== undefined ? 'balance' : undefined,
    updates.bonusCreditsIncrement !== undefined ? 'bonusCredits' : undefined,
    updates.reservedIncrement !== undefined ? 'reserved' : undefined,
    updates.monthlyUsedIncrement !== undefined ? 'monthlyUsed' : undefined,
  ].filter((column): column is string => column !== undefined)
}
