/**
 * The monthly reset, on exact values, in both adapters.
 *
 * "Unlimited" has to have one persisted representation, or the two adapters
 * disagree about what an unlimited account looks like and each reset drags it
 * further apart. The contract lives in `monthlyResetBalance`:
 *
 * - a metered tier resets to *exactly* its configured limit;
 * - an unlimited tier resets to *at least* `UNLIMITED_BALANCE_SENTINEL`.
 *
 * The SQL adapter used to leave an unlimited balance strictly alone —
 * `Number.isFinite(newBalance) ? ... : sql`balance`` — which is right for a
 * healthy account and a trap for a degraded one: an unlimited user whose
 * balance had been written as `0` stayed at `0` through every reset, forever,
 * while the in-memory adapter recovered. Both directions are asserted on
 * literal values here, because comparing the adapters only to each other would
 * pass if they regressed together.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  UNLIMITED_BALANCE_SENTINEL,
  createInMemoryCreditRepository,
  getConfigMonthlyLimit,
  resetConfig,
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

describeIntegration('monthly reset parity (PostgreSQL vs in-memory)', () => {
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
    // The suite reads the shipped tier configuration rather than installing
    // one, but any test that did install one must not leak into the next.
    resetConfig()
  })

  /**
   * The same row in both adapters, with a reset that is due right now.
   *
   * The reset is a compare-and-set on `monthly_reset_at`, so both adapters have
   * to be handed the same expected value for the CAS to fire.
   */
  async function bothAt(balance: number, monthlyUsed = 25) {
    const resetAt = new Date(Date.now() - 60_000)
    await seedBalance(ctx.pool, userId, { balance, monthlyUsed })
    await ctx.pool.query(`UPDATE credit_balances SET monthly_reset_at = $2 WHERE user_id = $1`, [
      userId,
      resetAt,
    ])

    const memory = createInMemoryCreditRepository()
    await memory.initializeUserCredits(userId, 'free', balance)
    await memory.updateUserCredits(userId, { monthlyUsed, monthlyResetAt: resetAt.toISOString() })
    return { memory, resetAt }
  }

  async function resetBoth(
    memory: ReturnType<typeof createInMemoryCreditRepository>,
    tier: string,
    resetAt: Date
  ) {
    const fromSql = await sql.atomicMonthlyReset(userId, tier, resetAt)
    const fromMemory = await memory.atomicMonthlyReset(userId, tier, resetAt.toISOString())
    expect(fromSql.wasReset, 'the SQL CAS did not fire').toBe(true)
    expect(fromMemory.wasReset, 'the in-memory CAS did not fire').toBe(true)

    const row = await readBalance(ctx.pool, userId)
    const stored = await memory.getUserCredits(userId)
    return {
      sql: { balance: row!.balance, monthlyUsed: row!.monthly_used },
      memory: { balance: stored!.balance, monthlyUsed: stored!.monthlyUsed },
    }
  }

  describe('a metered tier', () => {
    it('resets to exactly its configured limit in both adapters', async () => {
      const { memory, resetAt } = await bothAt(17)
      const after = await resetBoth(memory, 'premium', resetAt)

      // The literal, not just agreement: an accidental zero would satisfy
      // "both adapters match" and fail here.
      expect(getConfigMonthlyLimit('premium')).toBe(500)
      expect(after.sql).toEqual({ balance: 500, monthlyUsed: 0 })
      expect(after.memory).toEqual({ balance: 500, monthlyUsed: 0 })
    })

    it('resets a balance that is already above the limit back down to it', async () => {
      const { memory, resetAt } = await bothAt(9000)
      const after = await resetBoth(memory, 'premium', resetAt)
      expect(after.sql).toEqual({ balance: 500, monthlyUsed: 0 })
      expect(after.memory).toEqual({ balance: 500, monthlyUsed: 0 })
    })
  })

  describe('an unlimited tier', () => {
    it('repairs a degraded balance to the sentinel in both adapters', async () => {
      // The blocker: this row stayed at 0 through every SQL reset.
      const { memory, resetAt } = await bothAt(0)
      const after = await resetBoth(memory, 'unlimited', resetAt)

      expect(UNLIMITED_BALANCE_SENTINEL).toBe(999999)
      expect(after.sql).toEqual({ balance: 999999, monthlyUsed: 0 })
      expect(after.memory).toEqual({ balance: 999999, monthlyUsed: 0 })
    })

    it('repairs a partially-spent balance too', async () => {
      const { memory, resetAt } = await bothAt(1234.56)
      const after = await resetBoth(memory, 'unlimited', resetAt)
      expect(after.sql).toEqual({ balance: 999999, monthlyUsed: 0 })
      expect(after.memory).toEqual({ balance: 999999, monthlyUsed: 0 })
    })

    it('never cuts down a balance that is already above the sentinel', async () => {
      // A floor, not an assignment: an account topped up beyond the sentinel
      // keeps what it was given.
      const { memory, resetAt } = await bothAt(1_500_000)
      const after = await resetBoth(memory, 'unlimited', resetAt)
      expect(after.sql).toEqual({ balance: 1_500_000, monthlyUsed: 0 })
      expect(after.memory).toEqual({ balance: 1_500_000, monthlyUsed: 0 })
    })

    it('keeps a balance exactly at the sentinel unchanged', async () => {
      const { memory, resetAt } = await bothAt(UNLIMITED_BALANCE_SENTINEL)
      const after = await resetBoth(memory, 'unlimited', resetAt)
      expect(after.sql).toEqual({ balance: 999999, monthlyUsed: 0 })
      expect(after.memory).toEqual({ balance: 999999, monthlyUsed: 0 })
    })
  })

  describe('a reset that is not due', () => {
    it('changes nothing in either adapter', async () => {
      const { memory } = await bothAt(17)
      const wrongExpectation = new Date(Date.now() + 86_400_000)

      const fromSql = await sql.atomicMonthlyReset(userId, 'premium', wrongExpectation)
      const fromMemory = await memory.atomicMonthlyReset(
        userId,
        'premium',
        wrongExpectation.toISOString()
      )

      expect(fromSql.wasReset).toBe(false)
      expect(fromMemory.wasReset).toBe(false)
      expect((await readBalance(ctx.pool, userId))?.balance).toBe(17)
      expect((await memory.getUserCredits(userId))?.balance).toBe(17)
    })
  })
})
