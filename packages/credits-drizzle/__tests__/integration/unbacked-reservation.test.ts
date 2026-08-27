/**
 * The same invariant as `credits/__tests__/unit/unbacked-reservation.test.ts`,
 * against real PostgreSQL.
 *
 * A reservation row is only a hold if the transaction that wrote it also raised
 * `credit_balances.reserved`. `hold_placed_at` is that fact, and `reserve` is
 * the only writer of it. A keyed row without it — planted here by raw SQL, as
 * `createReservation` once wrote — must never be adopted as a replay and must
 * never be transitioned, because both would spend coverage that belongs to a
 * different, genuine hold.
 */

import { afterAll, beforeAll, beforeEach, expect, it, describe } from 'vitest'
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

describeIntegration('unbacked reservations (PostgreSQL)', () => {
  let ctx: TestDatabase
  let repo: DrizzleCreditRepository
  let userId: string

  beforeAll(async () => {
    ctx = await setupDatabase()
    repo = new DrizzleCreditRepository(ctx.db)
  })
  afterAll(async () => {
    await teardownDatabase(ctx)
  })
  beforeEach(async () => {
    await truncateAll(ctx.pool)
    userId = newUserId()
    await seedBalance(ctx.pool, userId, { balance: 100 })
  })

  /** A keyed row with no `hold_placed_at`: a row, not a hold. */
  async function plantUnbacked(key: string, amount: number, expiry = "+ interval '10 minutes'") {
    const { rows } = await ctx.pool.query(
      `INSERT INTO credit_reservations
         (user_id, amount, operation_type, status, expires_at, idempotency_key)
       VALUES ($1, $2::numeric, 'story_generation', 'reserved', now() ${expiry}, $3)
       RETURNING id`,
      [userId, String(amount), key]
    )
    return rows[0].id as string
  }

  /** A real hold, placed by the boundary, for the coverage to be stolen from. */
  async function placeGenuineHold(amount: number) {
    const outcome = await repo.reserveCreditsV2({
      userId,
      amount,
      operationType: 'story_generation',
      expiresAt: new Date(Date.now() + 600_000),
    })
    if (outcome.outcome !== 'created') throw new Error('setup failed to reserve')
    return outcome.reservation
  }

  it('refuses an idempotency key on the direct writer, and stores nothing', async () => {
    await expect(
      repo.createReservation({
        userId,
        amount: 10,
        operationType: 'story_generation',
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: 'k1',
      })
    ).rejects.toMatchObject({ code: CreditErrorCode.UNSUPPORTED_OPERATION })

    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM credit_reservations WHERE user_id = $1`,
      [userId]
    )
    expect(rows[0].n).toBe(0)
  })

  it('never returns a replay for a row whose hold it did not place', async () => {
    // Two planted keyed rows and one genuine hold, exactly as the blocker
    // described: `reserved` covers the genuine hold and nothing else.
    const planted = await plantUnbacked('k1', 60)
    await plantUnbacked('k2', 60)
    const genuine = await placeGenuineHold(60)
    expect((await readBalance(ctx.pool, userId))?.reserved).toBe(60)

    await expect(
      repo.reserveCreditsV2({
        userId,
        amount: 60,
        operationType: 'story_generation',
        expiresAt: new Date(Date.now() + 600_000),
        idempotencyKey: 'k1',
      })
    ).rejects.toMatchObject({
      code: CreditErrorCode.UNBACKED_RESERVATION,
      details: { reservationId: planted },
    })

    // Unchanged: the refusal is ahead of every write.
    expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: 100, reserved: 60 })

    // And committing the planted row is refused too, so the genuine hold's
    // coverage is still there to spend.
    await expect(repo.commitReservationV2(userId, planted)).rejects.toMatchObject({
      code: CreditErrorCode.UNBACKED_RESERVATION,
      details: { transition: 'commit' },
    })
    expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: 100, reserved: 60 })

    const committed = await repo.commitReservationV2(userId, genuine.id)
    expect(committed.outcome).toBe('committed')
    expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: 40, reserved: 0 })

    // The planted rows are exactly as planted.
    const { rows } = await ctx.pool.query(
      `SELECT status, hold_placed_at FROM credit_reservations
       WHERE user_id = $1 AND idempotency_key IS NOT NULL AND id <> $2`,
      [userId, genuine.id]
    )
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.status).toBe('reserved')
      expect(row.hold_placed_at).toBeNull()
    }
  })

  it('refuses to release or expire one, so no coverage is handed back', async () => {
    const planted = await plantUnbacked('k1', 60, "- interval '1 minute'")
    await placeGenuineHold(60)

    await expect(repo.releaseReservationV2(userId, planted)).rejects.toMatchObject({
      code: CreditErrorCode.UNBACKED_RESERVATION,
      details: { transition: 'release' },
    })
    await expect(repo.expireReservationV2(userId, planted)).rejects.toMatchObject({
      code: CreditErrorCode.UNBACKED_RESERVATION,
      details: { transition: 'expire' },
    })

    expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: 100, reserved: 60 })
  })

  describe('the guard does not break the operation it protects', () => {
    it('replays a key whose hold this boundary placed, and holds once', async () => {
      const input = {
        userId,
        amount: 25,
        operationType: 'story_generation',
        expiresAt: new Date(Date.now() + 600_000),
        idempotencyKey: 'retry-me',
      }
      const first = await repo.reserveCreditsV2(input)
      const second = await repo.reserveCreditsV2(input)

      expect(first.outcome).toBe('created')
      expect(second.outcome).toBe('replayed')
      expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: 100, reserved: 25 })
    })

    it('writes hold_placed_at in the same transaction as the hold', async () => {
      const reservation = await placeGenuineHold(10)
      const { rows } = await ctx.pool.query(
        `SELECT hold_placed_at FROM credit_reservations WHERE id = $1`,
        [reservation.id]
      )
      expect(rows[0].hold_placed_at).toBeInstanceOf(Date)
    })

    it('leaves legacy unkeyed rows transitionable, since the migration backfills them', async () => {
      // `createReservation` + a manual `reserved` bump is the pre-V2 flow, and
      // the migration grandfathers rows written that way. Simulated here by
      // backfilling `hold_placed_at` exactly as the migration does.
      const reservation = await repo.createReservation({
        userId,
        amount: 10,
        operationType: 'story_generation',
        expiresAt: new Date(Date.now() + 60_000),
      })
      await ctx.pool.query(
        `UPDATE credit_balances SET reserved = 10 WHERE user_id = $1`,
        [userId]
      )
      await ctx.pool.query(
        `UPDATE credit_reservations SET hold_placed_at = created_at WHERE id = $1`,
        [reservation.id]
      )

      const outcome = await repo.commitReservationV2(userId, reservation.id)
      expect(outcome.outcome).toBe('committed')
      expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: 90, reserved: 0 })
    })
  })
})
