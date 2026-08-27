import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { DrizzleCreditRepository } from '../../src/repository/index.js'
import {
  countJournal,
  describeIntegration,
  newUserId,
  readBalance,
  seedBalance,
  setupDatabase,
  teardownDatabase,
  truncateAll,
  type TestDatabase,
} from '../helpers/database.js'

describeIntegration('transaction rollback (PostgreSQL)', () => {
  let ctx: TestDatabase
  let repo: DrizzleCreditRepository

  beforeAll(async () => {
    ctx = await setupDatabase()
    repo = new DrizzleCreditRepository(ctx.db)
  })
  afterAll(async () => {
    await teardownDatabase(ctx)
  })
  beforeEach(async () => {
    await truncateAll(ctx.pool)
  })

  /**
   * Make the journal insert fail at the database level.
   *
   * A trigger is the honest way to inject this: it fails inside the real
   * transaction, exactly where a constraint violation or disk error would, so
   * the rollback under test is PostgreSQL's and not a mock's.
   */
  async function withFailingJournal<T>(fn: () => Promise<T>): Promise<T> {
    await ctx.pool.query(`
      CREATE OR REPLACE FUNCTION credits_test_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected journal failure'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER credits_test_fail_trigger
        BEFORE INSERT ON credit_journal_entries
        FOR EACH ROW EXECUTE FUNCTION credits_test_fail();
    `)
    try {
      return await fn()
    } finally {
      await ctx.pool.query(
        `DROP TRIGGER IF EXISTS credits_test_fail_trigger ON credit_journal_entries`
      )
    }
  }

  it('rolls the whole commit back when the journal write fails', async () => {
    const userId = newUserId()
    await seedBalance(ctx.pool, userId, { balance: 500 })
    const reserved = await repo.reserveCreditsV2({
      userId,
      amount: 60,
      operationType: 'story_generation',
      expiresAt: new Date(Date.now() + 60_000),
    })
    if (reserved.outcome !== 'created') throw new Error('setup failed')

    await withFailingJournal(async () => {
      await expect(repo.commitReservationV2(userId, reserved.reservation.id)).rejects.toThrow(
        /injected journal failure/
      )
    })

    // Nothing may have leaked out of the aborted transaction.
    const balance = await readBalance(ctx.pool, userId)
    expect(balance).toMatchObject({ balance: 500, reserved: 60, monthly_used: 0 })
    expect(await countJournal(ctx.pool, userId)).toBe(0)

    const { rows } = await ctx.pool.query(
      `SELECT status, completed_at FROM credit_reservations WHERE id = $1`,
      [reserved.reservation.id]
    )
    expect(rows[0].status).toBe('reserved')
    expect(rows[0].completed_at).toBeNull()

    // And the reservation is still committable once the fault clears.
    const retry = await repo.commitReservationV2(userId, reserved.reservation.id)
    expect(retry.outcome).toBe('committed')
    expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: 440, reserved: 0 })
  })

  it('rolls the reservation back when the hold cannot be placed', async () => {
    const userId = newUserId()
    await seedBalance(ctx.pool, userId, { balance: 10 })

    const outcome = await repo.reserveCreditsV2({
      userId,
      amount: 500,
      operationType: 'story_generation',
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: 'too-expensive',
    })
    expect(outcome.outcome).toBe('insufficient')

    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM credit_reservations WHERE user_id = $1`,
      [userId]
    )
    expect(rows[0].n).toBe(0)

    // The key is not burned: the same request can succeed once funds arrive.
    await ctx.pool.query(`UPDATE credit_balances SET balance = 1000 WHERE user_id = $1`, [userId])
    const retry = await repo.reserveCreditsV2({
      userId,
      amount: 500,
      operationType: 'story_generation',
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: 'too-expensive',
    })
    expect(retry.outcome).toBe('created')
  })

  it('keeps the ledger balanced across a mixed concurrent workload', async () => {
    const userId = newUserId()
    await seedBalance(ctx.pool, userId, { balance: 1000 })

    const reservations = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        repo.reserveCreditsV2({
          userId,
          amount: 10,
          operationType: 'story_generation',
          expiresAt: new Date(Date.now() + 60_000),
          idempotencyKey: `mixed-${i}`,
        })
      )
    )
    const ids = reservations.flatMap((r) => (r.outcome === 'created' ? [r.reservation.id] : []))
    expect(ids).toHaveLength(12)

    // Commit the first half, release the second, all at once.
    const outcomes = await Promise.all([
      ...ids.slice(0, 6).map((id) => repo.commitReservationV2(userId, id)),
      ...ids.slice(6).map((id) => repo.releaseReservationV2(userId, id)),
    ])
    expect(outcomes.filter((o) => o.outcome === 'committed')).toHaveLength(6)
    expect(outcomes.filter((o) => o.outcome === 'released')).toHaveLength(6)

    const balance = await readBalance(ctx.pool, userId)
    expect(balance).toMatchObject({ balance: 940, reserved: 0, monthly_used: 60 })
    expect(await countJournal(ctx.pool, userId, 'operation_commit')).toBe(6)
    expect(await countJournal(ctx.pool, userId, 'operation_release')).toBe(6)
  })
})
