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

  it('monthly reset writes its journal line in the same transaction', async () => {
    await seedBalance(ctx.pool, alice, { balance: 9000 })
    const resetAt = await pinResetAt()

    const reset = await repo.atomicMonthlyReset(alice, 'premium', resetAt)
    // `journaled: true` tells the service to skip its own journal call, which
    // ran outside the reset's atomicity: a failure there landed after the CAS
    // was consumed, and the line was lost for good.
    expect(reset.journaled).toBe(true)

    const { rows } = await ctx.pool.query(
      `SELECT entry_type, amount::float AS amount FROM credit_journal_entries
       WHERE user_id = $1 AND source = 'monthly_reset'`,
      [alice]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].entry_type).toBe('debit')
    expect(rows[0].amount).toBe(8500)
  })

  it('the reset CAS is exact: a stored microsecond the caller cannot see refuses', async () => {
    await seedBalance(ctx.pool, alice, { balance: 9000 })
    // A value with sub-millisecond precision, as SQL `now()` writes them. The
    // driver's Date carries only milliseconds, so the caller's expectation can
    // never exactly equal the column — and the CAS must refuse, not pass a
    // stale expectation because the difference is too small for JS to see.
    await ctx.pool.query(
      `UPDATE credit_balances
       SET monthly_reset_at = date_trunc('milliseconds', now() - interval '1 day') + interval '123 microseconds'
       WHERE user_id = $1`,
      [alice]
    )
    const { rows } = await ctx.pool.query(
      `SELECT monthly_reset_at FROM credit_balances WHERE user_id = $1`,
      [alice]
    )

    const reset = await repo.atomicMonthlyReset(alice, 'premium', rows[0].monthly_reset_at)
    expect(reset.wasReset).toBe(false)
    expect(reset.credits.balance).toBe(9000)
  })

  it('concurrent expiry workers downgrade exactly once', async () => {
    await seedBalance(ctx.pool, alice, { balance: 1000 })
    await ctx.pool.query(
      `UPDATE credit_balances
       SET tier = 'premium', subscription_expires_at = now() - interval '10 days'
       WHERE user_id = $1`,
      [alice]
    )

    // Eligibility used to be decided from an unlocked read, so every worker
    // saw the expired state and every one reported `wasDowngraded: true` —
    // duplicate journal lines and notifications downstream. Under the row
    // lock, exactly one wins; the rest re-read the downgraded row and pass.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => repo.checkAndHandleSubscriptionExpiry(alice, 3))
    )
    expect(results.filter((r) => r.wasDowngraded)).toHaveLength(1)
  })

  it('subscription expiry clamps against the live row, not a stale read', async () => {
    const reservationId = await holdOf(1000, 800)
    await ctx.pool.query(
      `UPDATE credit_balances
       SET tier = 'premium', subscription_expires_at = now() - interval '10 days'
       WHERE user_id = $1`,
      [alice]
    )

    const result = await repo.checkAndHandleSubscriptionExpiry(alice, 3)
    expect(result.wasDowngraded).toBe(true)
    // The free limit is far below the 800-credit hold; the floor wins — and
    // both the clamp target and the floor come from the row's own columns
    // inside the UPDATE, so a commit that lands mid-downgrade can never have
    // its spend re-minted by a stale `Math.min` write-back.
    expect(result.credits.balance).toBe(800)

    const commit = await repo.commitReservationV2(alice, reservationId)
    expect(commit.outcome).toBe('committed')
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
