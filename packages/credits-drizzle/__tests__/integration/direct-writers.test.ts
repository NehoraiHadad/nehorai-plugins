/**
 * The direct (record-only) writers against real PostgreSQL.
 *
 * SQL parity of `credits/__tests__/unit/direct-writers.test.ts`, plus the one
 * case only a real database can prove: a replay or conflict resolved by
 * `addCreditsV2` rolls back *everything* — including the `credit_balances` row
 * `lockUserCredits` creates for an unknown user. Returning the resolution
 * normally would COMMIT that row, so a refused payment would still have
 * created (and funded) an account.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CreditErrorCode } from '@nehorai/credits'
import { DrizzleCreditRepository } from '../../src/repository/index.js'
import {
  describeIntegration,
  newUserId,
  seedBalance,
  setupDatabase,
  teardownDatabase,
  truncateAll,
  type TestDatabase,
} from '../helpers/database.js'

const OP = 'story_generation'
const soon = () => new Date(Date.now() + 60_000)

describeIntegration('direct writers (PostgreSQL)', () => {
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
    await seedBalance(ctx.pool, alice, { balance: 100 })
  })

  it('createTransaction refuses a paymentRef, so the real delivery still credits', async () => {
    await expect(
      repo.createTransaction({
        userId: alice,
        type: 'purchase',
        amount: 25,
        description: 'recorded, not credited',
        paymentRef: 'pay-x',
        previousBalance: 100,
        newBalance: 125,
      })
    ).rejects.toMatchObject({ code: CreditErrorCode.UNSUPPORTED_OPERATION })

    const outcome = await repo.addCreditsV2({
      userId: alice,
      amount: 25,
      description: 'the actual payment',
      paymentRef: 'pay-x',
    })
    expect(outcome.outcome).toBe('created')
  })

  it('a conflict for an unknown user creates no account row', async () => {
    await repo.addCreditsV2({
      userId: alice,
      amount: 25,
      description: 'original',
      paymentRef: 'pay-1',
    })

    const ghost = newUserId()
    const outcome = await repo.addCreditsV2({
      userId: ghost,
      amount: 25,
      description: 'reused reference, different user',
      paymentRef: 'pay-1',
    })
    expect(outcome.outcome).toBe('conflict')

    const rows = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM credit_balances WHERE user_id = $1`,
      [ghost]
    )
    expect(rows.rows[0].n).toBe(0)
  })

  it('a replay leaves no writes behind either', async () => {
    await repo.addCreditsV2({
      userId: alice,
      amount: 25,
      description: 'original',
      paymentRef: 'pay-2',
    })
    const before = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM credit_journal_entries WHERE user_id = $1`,
      [alice]
    )

    const outcome = await repo.addCreditsV2({
      userId: alice,
      amount: 25,
      description: 'original',
      paymentRef: 'pay-2',
    })
    expect(outcome.outcome).toBe('replayed')

    const after = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM credit_journal_entries WHERE user_id = $1`,
      [alice]
    )
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  it('updateReservationStatus refuses a backed hold, so commit still debits', async () => {
    const reserved = await repo.reserveCreditsV2({
      userId: alice,
      amount: 10,
      operationType: OP,
      expiresAt: soon(),
    })
    if (reserved.outcome !== 'created') throw new Error('expected a hold')

    await expect(
      repo.updateReservationStatus(alice, reserved.reservation.id, 'committed')
    ).rejects.toMatchObject({ code: CreditErrorCode.UNSUPPORTED_OPERATION })

    const commit = await repo.commitReservationV2(alice, reserved.reservation.id)
    expect(commit.outcome).toBe('committed')
  })

  it('annotates plain records with terminal statuses, but never reopens', async () => {
    const record = await repo.createReservation({
      userId: alice,
      amount: 5,
      operationType: OP,
      expiresAt: soon(),
    })

    await repo.updateReservationStatus(alice, record.id, 'released')
    expect((await repo.getReservation(alice, record.id))?.status).toBe('released')

    await expect(
      repo.updateReservationStatus(alice, record.id, 'reserved')
    ).rejects.toMatchObject({ code: CreditErrorCode.UNSUPPORTED_OPERATION })
  })
})
