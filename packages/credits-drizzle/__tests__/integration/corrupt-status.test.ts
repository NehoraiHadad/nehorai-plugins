/**
 * The SQL parity of `credits/__tests__/unit/corrupt-status.test.ts`.
 *
 * `status` is a plain `text` column, so anything can be in it: a partial
 * migration, another service, a hand-run UPDATE. The transitions used to cast
 * it and report `already_terminal` — a success outcome — over whatever they
 * found. Here the row is corrupted in the database itself, which is the only
 * way to prove the adapter validates what it reads back rather than what it
 * believes it wrote.
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

const ALLOWED = ['reserved', 'committed', 'released', 'expired']

describeIntegration('corrupt persisted status (PostgreSQL)', () => {
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

  /** A genuine hold, then a status straight into the column. */
  async function heldWithStatus(status: string) {
    const outcome = await repo.reserveCreditsV2({
      userId,
      amount: 10,
      operationType: 'story_generation',
      expiresAt: new Date(Date.now() - 1000),
    })
    if (outcome.outcome !== 'created') throw new Error('setup failed to reserve')
    await ctx.pool.query(`UPDATE credit_reservations SET status = $2 WHERE id = $1`, [
      outcome.reservation.id,
      status,
    ])
    return outcome.reservation.id
  }

  async function snapshot(id: string) {
    const { rows } = await ctx.pool.query(
      `SELECT status, completed_at FROM credit_reservations WHERE id = $1`,
      [id]
    )
    const journal = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM credit_journal_entries WHERE user_id = $1`,
      [userId]
    )
    return {
      balance: await readBalance(ctx.pool, userId),
      status: rows[0]?.status,
      completedAt: rows[0]?.completed_at,
      journal: journal.rows[0].n as number,
    }
  }

  const CORRUPT = ['RESERVED', 'pending', '', 'committed ', 'ready-to-commit']

  for (const status of CORRUPT) {
    describe(`a row holding ${JSON.stringify(status)}`, () => {
      for (const transition of ['commit', 'release', 'expire'] as const) {
        it(`refuses the ${transition}, and changes nothing`, async () => {
          const id = await heldWithStatus(status)
          const before = await snapshot(id)

          const call =
            transition === 'commit'
              ? repo.commitReservationV2(userId, id)
              : transition === 'release'
                ? repo.releaseReservationV2(userId, id)
                : repo.expireReservationV2(userId, id)

          const error = await call.then(
            (outcome) => {
              throw new Error(
                `reported ${JSON.stringify(outcome)} over a corrupt status instead of refusing`
              )
            },
            (e) => e
          )

          expect(error).toMatchObject({
            code: CreditErrorCode.CORRUPT_RESERVATION_STATUS,
            details: {
              userId,
              reservationId: id,
              transition,
              status,
              reason: 'corrupt_reservation_status',
            },
          })
          expect(error.details.allowed).toEqual(ALLOWED)
          expect(await snapshot(id)).toEqual(before)
        })
      }
    })
  }

  describe('the guard does not break the outcome it protects', () => {
    it('still reports already_terminal for a genuinely committed row', async () => {
      const id = await heldWithStatus('committed')
      const outcome = await repo.releaseReservationV2(userId, id)
      expect(outcome).toMatchObject({ outcome: 'already_terminal', terminalStatus: 'committed' })
    })

    it('still expires a due, reserved row', async () => {
      const id = await heldWithStatus('reserved')
      const outcome = await repo.expireReservationV2(userId, id)
      expect(outcome.outcome).toBe('expired')
      expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: 100, reserved: 0 })
    })
  })
})
