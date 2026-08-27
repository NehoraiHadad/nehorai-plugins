/**
 * The two adapters must agree, on the same inputs, about the same values.
 *
 * A test suite that runs against the in-memory repository is only useful if
 * production behaves the same way. Three divergences reached this branch
 * because nothing compared them directly: the SQL adapter hard-coded `'free'`
 * as the downgrade target while the in-memory one honoured the configured
 * default tier; a call supplying both an absolute field and its increment
 * stored different numbers in each; and derived totals were computed with
 * float arithmetic that could land off the cent grid the ledger validates
 * against.
 *
 * Every assertion here runs both adapters and compares them to each other
 * *and* to a literal expected value — comparing only to each other would pass
 * if both regressed together.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createInMemoryCreditRepository,
  initializeConfig,
  resetConfig,
  type CreditBalanceUpdate,
} from '@nehorai/credits'
import { DrizzleCreditRepository } from '../../src/repository/index.js'
import {
  describeIntegration,
  newUserId,
  readBalance,
  seedBalance,
  setupDatabase,
  teardownDatabase,
  truncateAll,
  type TestDatabase,
} from '../helpers/database.js'

describeIntegration('adapter parity (PostgreSQL vs in-memory)', () => {
  let ctx: TestDatabase
  let sql: DrizzleCreditRepository
  let userId: string

  beforeAll(async () => {
    ctx = await setupDatabase()
    sql = new DrizzleCreditRepository(ctx.db)
  })
  afterAll(async () => {
    await teardownDatabase(ctx)
  })
  beforeEach(async () => {
    await truncateAll(ctx.pool)
    userId = newUserId()
  })
  afterEach(() => {
    resetConfig()
  })

  /** The same starting row in both adapters. */
  async function bothSeeded(balance: number, bonusCredits = 0, monthlyUsed = 0) {
    await seedBalance(ctx.pool, userId, { balance, bonusCredits, monthlyUsed })
    const memory = createInMemoryCreditRepository()
    await memory.initializeUserCredits(userId, 'free', balance)
    await memory.updateUserCredits(userId, { bonusCredits, monthlyUsed })
    return memory
  }

  async function sqlBalance() {
    const row = await readBalance(ctx.pool, userId)
    return {
      balance: row!.balance,
      bonusCredits: row!.bonus,
      monthlyUsed: row!.monthly_used,
    }
  }

  async function memoryBalance(memory: ReturnType<typeof createInMemoryCreditRepository>) {
    const credits = await memory.getUserCredits(userId)
    return {
      balance: credits!.balance,
      bonusCredits: credits!.bonusCredits,
      monthlyUsed: credits!.monthlyUsed,
    }
  }

  describe('an update carrying both an absolute value and its increment', () => {
    // PostgreSQL evaluates `monthly_used + 2` against the *stored* row, so the
    // column expression silently discarded the absolute `5` in the same call
    // while the in-memory adapter applied the increment on top of it. Same
    // input, 102 in production and 7 in tests.
    const updates: CreditBalanceUpdate = { monthlyUsed: 5, monthlyUsedIncrement: 2 }

    it('applies the increment on top of the absolute in both adapters', async () => {
      const memory = await bothSeeded(50, 0, 100)

      await sql.updateUserCredits(userId, updates)
      await memory.updateUserCredits(userId, updates)

      expect((await sqlBalance()).monthlyUsed).toBe(7)
      expect((await memoryBalance(memory)).monthlyUsed).toBe(7)
    })

    // A positive control, not a regression: the increment-only path behaved
    // correctly before the fix too. It is here so a fix that broke it would be
    // caught.
    it('still reads the stored column when only an increment is given', async () => {
      const memory = await bothSeeded(50, 0, 100)
      const incrementOnly: CreditBalanceUpdate = { monthlyUsedIncrement: 2 }

      await sql.updateUserCredits(userId, incrementOnly)
      await memory.updateUserCredits(userId, incrementOnly)

      expect((await sqlBalance()).monthlyUsed).toBe(102)
      expect((await memoryBalance(memory)).monthlyUsed).toBe(102)
    })
  })

  describe('the grace-period downgrade target', () => {
    beforeEach(() => {
      // An app is entitled to make something other than `free` its default.
      initializeConfig({
        tierConfigs: {
          free: { tier: 'free', monthlyCredits: 10, priceUsd: 0, features: [], isFree: true },
          premium: {
            tier: 'premium',
            monthlyCredits: 500,
            priceUsd: 19.99,
            features: [],
            isDefault: true,
          },
          unlimited: {
            tier: 'unlimited',
            monthlyCredits: 0,
            priceUsd: 49.99,
            features: [],
            unlimited: true,
          },
        },
      } as never)
    })

    it('is the configured default tier in both adapters, not a hard-coded free', async () => {
      const expired = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
      await seedBalance(ctx.pool, userId, { balance: 5 })
      await ctx.pool.query(
        'UPDATE credit_balances SET tier = $2, subscription_expires_at = $3 WHERE user_id = $1',
        [userId, 'unlimited', expired]
      )
      const memory = createInMemoryCreditRepository()
      await memory.initializeUserCredits(userId, 'unlimited', 5)
      await memory.updateUserCredits(userId, { subscriptionExpiresAt: expired })

      const sqlResult = await sql.checkAndHandleSubscriptionExpiry(userId)
      const memoryResult = await memory.checkAndHandleSubscriptionExpiry(userId)

      expect(sqlResult.wasDowngraded).toBe(true)
      expect(memoryResult.wasDowngraded).toBe(true)
      expect(sqlResult.credits?.tier).toBe('premium')
      expect(memoryResult.credits?.tier).toBe('premium')
      expect(sqlResult.credits?.monthlyLimit).toBe(500)
      expect(memoryResult.credits?.monthlyLimit).toBe(500)
    })
  })

  describe('a replayed paymentRef', () => {
    it('credits exactly once in both adapters', async () => {
      const memory = await bothSeeded(10)

      await sql.addCreditsAtomic(userId, 25, 'top-up', 'pay_parity')
      await sql.addCreditsAtomic(userId, 25, 'top-up', 'pay_parity')
      await memory.addCreditsAtomic(userId, 25, 'top-up', 'pay_parity')
      await memory.addCreditsAtomic(userId, 25, 'top-up', 'pay_parity')

      // The in-memory adapter ignored `paymentRef` outright, so a replayed
      // webhook credited twice in tests and once in production — the direction
      // of divergence that hides the bug instead of surfacing it.
      expect(await sqlBalance()).toMatchObject({ bonusCredits: 25 })
      expect(await memoryBalance(memory)).toMatchObject({ bonusCredits: 25 })
      expect(await memory.getTransactions(userId)).toHaveLength(1)
    })

    it('treats an empty reference as no reference in both adapters', async () => {
      const memory = await bothSeeded(10)

      // The SQL adapter skipped the duplicate check on '' (falsy) and then
      // stored it, so the second call hit the partial unique index and threw,
      // while the in-memory adapter treated it as an idempotent no-op. Neither
      // may reject, and — since '' is not a reference — both must credit twice.
      await sql.addCreditsAtomic(userId, 25, 'top-up', '')
      await sql.addCreditsAtomic(userId, 25, 'top-up', '')
      await memory.addCreditsAtomic(userId, 25, 'top-up', '')
      await memory.addCreditsAtomic(userId, 25, 'top-up', '')

      expect(await sqlBalance()).toMatchObject({ bonusCredits: 50 })
      expect(await memoryBalance(memory)).toMatchObject({ bonusCredits: 50 })

      // And nothing recorded an empty string as a payment reference.
      const { rows } = await ctx.pool.query(
        `SELECT count(*)::int AS n FROM credit_plugin_transactions
           WHERE user_id = $1 AND payment_ref IS NOT NULL`,
        [userId]
      )
      expect(rows[0].n).toBe(0)
      const stored = await memory.getTransactions(userId)
      expect(stored.map((t) => t.paymentRef)).toEqual([undefined, undefined])
    })

    it('credits each distinct reference in both adapters', async () => {
      const memory = await bothSeeded(10)

      await sql.addCreditsAtomic(userId, 25, 'top-up', 'pay_parity_a')
      await sql.addCreditsAtomic(userId, 5, 'top-up', 'pay_parity_b')
      await memory.addCreditsAtomic(userId, 25, 'top-up', 'pay_parity_a')
      await memory.addCreditsAtomic(userId, 5, 'top-up', 'pay_parity_b')

      expect(await sqlBalance()).toMatchObject({ bonusCredits: 30 })
      expect(await memoryBalance(memory)).toMatchObject({ bonusCredits: 30 })
    })
  })

  describe('amounts that break float arithmetic', () => {
    // `0.1 + 0.2` is `0.30000000000000004` and `0.3 - 0.1` is
    // `0.19999999999999998`; both are off the cent grid the ledger validates
    // against, so deriving totals with `+`/`-` rejected legal operations.
    it('adds bonus credits to the same total in both adapters', async () => {
      const memory = await bothSeeded(0.1)

      await sql.addCreditsAtomic(userId, 0.2, 'top-up')
      await memory.addCreditsAtomic(userId, 0.2, 'top-up')

      expect(await sqlBalance()).toMatchObject({ balance: 0.1, bonusCredits: 0.2 })
      expect(await memoryBalance(memory)).toMatchObject({ balance: 0.1, bonusCredits: 0.2 })
    })

    it('deducts to the same remainder in both adapters', async () => {
      const memory = await bothSeeded(0.3)

      const sqlTotals = await sql.deductCreditsAtomic(userId, 0.1)
      const memoryTotals = await memory.deductCreditsAtomic(userId, 0.1)

      expect(sqlTotals).toEqual({ previousBalance: 0.3, newBalance: 0.2 })
      expect(memoryTotals).toEqual({ previousBalance: 0.3, newBalance: 0.2 })
      expect((await sqlBalance()).balance).toBe(0.2)
      expect((await memoryBalance(memory)).balance).toBe(0.2)
    })

    it('deducts across balance and bonus credits identically', async () => {
      // Two off-grid intermediates in one operation: 0.30 - 0.20 is
      // 0.09999999999999998 to take from bonus, and 0.20 minus that is
      // 0.10000000000000003.
      const memory = await bothSeeded(0.2, 0.2)

      const sqlTotals = await sql.deductCreditsAtomic(userId, 0.3)
      const memoryTotals = await memory.deductCreditsAtomic(userId, 0.3)

      expect(sqlTotals).toEqual({ previousBalance: 0.4, newBalance: 0.1 })
      expect(memoryTotals).toEqual({ previousBalance: 0.4, newBalance: 0.1 })
      const expected = { balance: 0, bonusCredits: 0.1 }
      expect(await sqlBalance()).toMatchObject(expected)
      expect(await memoryBalance(memory)).toMatchObject(expected)
    })

    it('holds and releases fractional amounts identically', async () => {
      const memory = await bothSeeded(1)
      const expiresAt = new Date(Date.now() + 60_000)
      const small = { userId, amount: 0.1, operationType: 'story_generation', expiresAt }
      const large = { userId, amount: 0.2, operationType: 'story_generation', expiresAt }

      const sqlSmall = await sql.reserveCreditsV2(small)
      await sql.reserveCreditsV2(large)
      const memorySmall = await memory.reserveCreditsV2(small)
      await memory.reserveCreditsV2(large)

      // reserved = 0.1 + 0.2, which float addition puts off the grid.
      expect((await readBalance(ctx.pool, userId))!.reserved).toBe(0.3)
      expect((await memory.getUserCredits(userId))!.reserved).toBe(0.3)

      await sql.releaseReservationV2(userId, sqlSmall.reservation!.id)
      await memory.releaseReservationV2(userId, memorySmall.reservation!.id)

      // 0.3 - 0.1, likewise.
      expect((await readBalance(ctx.pool, userId))!.reserved).toBe(0.2)
      expect((await memory.getUserCredits(userId))!.reserved).toBe(0.2)
    })

    it('commits a hold and journals a residue that is itself off the grid', async () => {
      // The residue must be *two* non-zero columns whose float sum misses the
      // grid. Leaving 0 + 0.2 is not enough: a float sum reaches 0.2 just as
      // exactly, so it could not expose a raw `balance + bonusCredits`.
      // 0.20 - 0.10 leaves 0.1, and 0.1 + 0.2 is 0.30000000000000004.
      const memory = await bothSeeded(0.2, 0.2)
      const expiresAt = new Date(Date.now() + 60_000)
      const input = { userId, amount: 0.1, operationType: 'story_generation', expiresAt }

      const sqlHeld = await sql.reserveCreditsV2(input)
      const memoryHeld = await memory.reserveCreditsV2(input)
      const sqlOutcome = await sql.commitReservationV2(userId, sqlHeld.reservation!.id)
      const memoryOutcome = await memory.commitReservationV2(userId, memoryHeld.reservation!.id)

      expect(sqlOutcome).toMatchObject({ outcome: 'committed', balanceAfter: 0.3 })
      expect(memoryOutcome).toMatchObject({ outcome: 'committed', balanceAfter: 0.3 })
      const expected = { balance: 0.1, bonusCredits: 0.2, monthlyUsed: 0.1 }
      expect(await sqlBalance()).toMatchObject(expected)
      expect(await memoryBalance(memory)).toMatchObject(expected)

      const { rows } = await ctx.pool.query(
        'SELECT balance_after::float8 AS after FROM credit_journal_entries WHERE user_id = $1',
        [userId]
      )
      expect(rows[0].after).toBe(0.3)
    })
  })
})
