/**
 * `balanceCap` and the current-tier reset against real PostgreSQL, where the
 * decision is taken from a row locked FOR UPDATE.
 *
 * The in-memory parity of these cases lives in
 * `credits/__tests__/unit/free-grants.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CreditErrorCode } from '@nehorai/credits'
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

describeIntegration('free-tier tier writes (PostgreSQL)', () => {
  let ctx: TestDatabase
  let repo: DrizzleCreditRepository
  let alice: string

  beforeAll(async () => {
    ctx = await setupDatabase()
    repo = new DrizzleCreditRepository(ctx.db)
  })
  afterAll(async () => {
    await teardownDatabase(ctx)
  })
  beforeEach(async () => {
    await truncateAll(ctx.pool)
    alice = newUserId()
  })

  async function tierOf(userId: string): Promise<string> {
    const { rows } = await ctx.pool.query(`SELECT tier FROM credit_balances WHERE user_id = $1`, [userId])
    return rows[0].tier
  }

  it('the reset uses the tier on the row when the argument names the paid tier', async () => {
    await seedBalance(ctx.pool, alice, { balance: 3 })
    const resetAt = new Date(Date.now() - 60_000)
    await ctx.pool.query(`UPDATE credit_balances SET monthly_reset_at = $2 WHERE user_id = $1`, [alice, resetAt])

    const result = await repo.atomicMonthlyReset(alice, 'premium', resetAt)

    expect(result.wasReset).toBe(true)
    expect(result.credits.balance).toBe(25)
    expect(await tierOf(alice)).toBe('free')
  })

  it('balanceCap lowers a paid account', async () => {
    await seedBalance(ctx.pool, alice, { balance: 400, tier: 'premium' })

    await repo.updateUserTier(alice, { tier: 'free', monthlyLimit: 25, balanceCap: 25 })

    expect((await readBalance(ctx.pool, alice))?.balance).toBe(25)
    expect(await tierOf(alice)).toBe('free')
  })

  it('balanceCap is ignored for an account already free', async () => {
    await seedBalance(ctx.pool, alice, { balance: 400 })

    await repo.updateUserTier(alice, { tier: 'free', monthlyLimit: 50, balanceCap: 25 })

    expect((await readBalance(ctx.pool, alice))?.balance).toBe(400)
  })

  it('balanceCap racing a charge never writes the spent balance back', async () => {
    await seedBalance(ctx.pool, alice, { balance: 20, tier: 'premium' })

    await Promise.all([
      repo.deductCreditsAtomic(alice, 20),
      repo.updateUserTier(alice, { tier: 'free', monthlyLimit: 25, balanceCap: 25 }),
    ])

    expect((await readBalance(ctx.pool, alice))?.balance).toBe(0)
  })

  it('balanceCap does not cut through the credits backing a live hold', async () => {
    await seedBalance(ctx.pool, alice, { balance: 100, tier: 'premium' })
    const hold = await repo.reserveCreditsV2({
      userId: alice,
      amount: 60,
      operationType: 'story_generation',
      expiresAt: new Date(Date.now() + 60_000),
    })
    if (hold.outcome !== 'created') throw new Error('expected a hold')

    await repo.updateUserTier(alice, { tier: 'free', monthlyLimit: 25, balanceCap: 25 })

    expect((await readBalance(ctx.pool, alice))?.balance).toBe(60)
    expect((await repo.commitReservationV2(alice, hold.reservation.id)).outcome).toBe('committed')
  })

  it('refuses balance and balanceCap together', async () => {
    await seedBalance(ctx.pool, alice, { balance: 400, tier: 'premium' })

    await expect(
      repo.updateUserTier(alice, { tier: 'free', monthlyLimit: 25, balance: 25, balanceCap: 25 })
    ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT })

    expect(await tierOf(alice)).toBe('premium')
  })
})
