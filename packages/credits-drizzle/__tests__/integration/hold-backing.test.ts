/**
 * Balance reductions never cut through the credits that back live holds —
 * against real PostgreSQL, where the floor is computed by the UPDATE itself
 * from the row's own columns, so it cannot race a concurrent reserve.
 *
 * The in-memory parity of these cases lives in
 * `credits/__tests__/unit/hold-backing.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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

const OP = 'story_generation'
const soon = () => new Date(Date.now() + 60_000)

describeIntegration('hold backing (PostgreSQL)', () => {
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

  async function holdOf(balance: number, amount: number): Promise<string> {
    await seedBalance(ctx.pool, alice, { balance })
    const reserved = await repo.reserveCreditsV2({
      userId: alice,
      amount,
      operationType: OP,
      expiresAt: soon(),
    })
    if (reserved.outcome !== 'created') throw new Error('expected a hold')
    return reserved.reservation.id
  }

  /** Pin `monthly_reset_at` to a known instant so the reset's CAS can fire. */
  async function pinResetAt(): Promise<Date> {
    const resetAt = new Date('2026-01-01T00:00:00.000Z')
    await ctx.pool.query(
      `UPDATE credit_balances SET monthly_reset_at = $2 WHERE user_id = $1`,
      [alice, resetAt]
    )
    return resetAt
  }

  it('monthly reset floors at the outstanding hold, and the commit lands', async () => {
    const reservationId = await holdOf(9000, 1000)
    const resetAt = await pinResetAt()

    // Premium's configured target is 500 — below the 1000-credit hold.
    const reset = await repo.atomicMonthlyReset(alice, 'premium', resetAt)
    expect(reset.wasReset).toBe(true)
    expect(reset.credits.balance).toBe(1000)

    const commit = await repo.commitReservationV2(alice, reservationId)
    expect(commit.outcome).toBe('committed')
    expect((await readBalance(ctx.pool, alice))?.reserved).toBe(0)
  })

  it('monthly reset still hits the exact target when nothing is held', async () => {
    await seedBalance(ctx.pool, alice, { balance: 9000 })
    const resetAt = await pinResetAt()

    const reset = await repo.atomicMonthlyReset(alice, 'premium', resetAt)
    expect(reset.wasReset).toBe(true)
    expect(reset.credits.balance).toBe(500)
  })

  it('a tier write clamps to the new limit but not below the hold', async () => {
    const reservationId = await holdOf(1000, 800)

    await repo.updateUserTier(alice, { tier: 'free', monthlyLimit: 25, balance: 25 })
    expect((await readBalance(ctx.pool, alice))?.balance).toBe(800)

    const commit = await repo.commitReservationV2(alice, reservationId)
    expect(commit.outcome).toBe('committed')
  })

  it('bonus credits count toward the backing, so the floor is only the gap', async () => {
    await seedBalance(ctx.pool, alice, { balance: 1000, bonusCredits: 300 })
    const reserved = await repo.reserveCreditsV2({
      userId: alice,
      amount: 800,
      operationType: OP,
      expiresAt: soon(),
    })
    if (reserved.outcome !== 'created') throw new Error('expected a hold')

    await repo.updateUserTier(alice, { tier: 'free', monthlyLimit: 25, balance: 25 })
    // reserved (800) - bonus (300) = 500 is all the balance must retain.
    expect((await readBalance(ctx.pool, alice))?.balance).toBe(500)

    const commit = await repo.commitReservationV2(alice, reserved.reservation.id)
    expect(commit.outcome).toBe('committed')
  })
})
