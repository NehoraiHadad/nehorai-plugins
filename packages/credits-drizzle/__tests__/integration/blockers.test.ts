/**
 * PostgreSQL regressions for the release blockers.
 *
 * Every test here corresponds to a way the first V2 implementation could lose
 * or invent money. They run against a real PostgreSQL because that is the only
 * place a transaction, a SQLSTATE, or a partial unique index actually exists.
 */
import { afterAll, beforeAll, beforeEach, expect, it, describe } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { CreditErrorCode, isCreditError, reservationJournalKey } from '@nehorai/credits'
import { DrizzleCreditRepository } from '../../src/repository/index.js'
import type { DrizzleLikeDB } from '../../src/repository/db.js'
import {
  countJournal,
  countReservations,
  describeIntegration,
  newUserId,
  readBalance,
  seedBalance,
  setupDatabase,
  TEST_DATABASE_URL,
  teardownDatabase,
  truncateAll,
  type TestDatabase,
} from '../helpers/database.js'

describeIntegration('V2 release blockers (PostgreSQL)', () => {
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
  })

  const soon = () => new Date(Date.now() + 60_000)

  async function hold(amount: number) {
    const outcome = await repo.reserveCreditsV2({
      userId,
      amount,
      operationType: 'story_generation',
      expiresAt: soon(),
    })
    if (outcome.outcome !== 'created') throw new Error(`expected created, got ${outcome.outcome}`)
    return outcome.reservation
  }

  // ==================== Blocker 1: transaction guarantee ====================

  describe('transaction guarantee', () => {
    /** A handle with no `transaction` at all — a shim or a hand-rolled mock. */
    const nonTransactional = (): DrizzleLikeDB => ({
      select: ctx.db.select.bind(ctx.db),
      insert: ctx.db.insert.bind(ctx.db),
      update: ctx.db.update.bind(ctx.db),
      execute: ctx.db.execute.bind(ctx.db),
    })

    /**
     * The nastier case: `transaction` exists but does not open one. A caller
     * could reasonably write this shim by hand and never notice that every
     * "transaction" is really autocommit.
     */
    const fakeTransaction = (): DrizzleLikeDB => ({
      select: ctx.db.select.bind(ctx.db),
      insert: ctx.db.insert.bind(ctx.db),
      update: ctx.db.update.bind(ctx.db),
      execute: ctx.db.execute.bind(ctx.db),
      transaction: (async (cb: (tx: DrizzleLikeDB) => Promise<unknown>) =>
        cb(fakeTransaction())) as never,
    })

    it('refuses to reserve on a handle that cannot open a transaction', async () => {
      const unsafe = new DrizzleCreditRepository(nonTransactional())
      await seedBalance(ctx.pool, userId, { balance: 500 })

      await expect(
        unsafe.reserveCreditsV2({
          userId,
          amount: 40,
          operationType: 'story_generation',
          expiresAt: soon(),
        })
      ).rejects.toMatchObject({ code: CreditErrorCode.UNSUPPORTED_OPERATION })

      // "Before any write" is the whole point.
      expect(await countReservations(ctx.pool, userId)).toBe(0)
      expect((await readBalance(ctx.pool, userId))?.reserved).toBe(0)
    })

    it('refuses to commit on a handle that cannot open a transaction', async () => {
      await seedBalance(ctx.pool, userId, { balance: 500 })
      const reservation = await hold(60)
      const unsafe = new DrizzleCreditRepository(nonTransactional())

      await expect(unsafe.commitReservationV2(userId, reservation.id)).rejects.toMatchObject({
        code: CreditErrorCode.UNSUPPORTED_OPERATION,
      })

      const balance = await readBalance(ctx.pool, userId)
      expect(balance).toMatchObject({ balance: 500, reserved: 60, monthly_used: 0 })
      expect(await countJournal(ctx.pool, userId)).toBe(0)
    })

    it('detects a transaction method that does not actually open one', async () => {
      const unsafe = new DrizzleCreditRepository(fakeTransaction())
      await seedBalance(ctx.pool, userId, { balance: 500 })

      await expect(
        unsafe.reserveCreditsV2({
          userId,
          amount: 40,
          operationType: 'story_generation',
          expiresAt: soon(),
        })
      ).rejects.toMatchObject({ code: CreditErrorCode.UNSUPPORTED_OPERATION })

      expect(await countReservations(ctx.pool, userId)).toBe(0)
      expect((await readBalance(ctx.pool, userId))?.reserved).toBe(0)
    })

    it('refuses a handle whose execute never reaches a database', async () => {
      // `transaction` really does open one, but `execute` is a stub that
      // resolves with nothing. Statement-only probing would pass here: the
      // savepoint "succeeded" because a no-op cannot fail. Requiring the
      // server to echo a token back is what catches it.
      const mute = (inner: DrizzleLikeDB): DrizzleLikeDB => ({
        select: inner.select.bind(inner),
        insert: inner.insert.bind(inner),
        update: inner.update.bind(inner),
        execute: (async () => undefined) as never,
        transaction: ((cb: (tx: DrizzleLikeDB) => Promise<unknown>) =>
          ctx.db.transaction((tx) => cb(mute(tx as unknown as DrizzleLikeDB)))) as never,
      })

      const unsafe = new DrizzleCreditRepository(mute(ctx.db as unknown as DrizzleLikeDB))
      await seedBalance(ctx.pool, userId, { balance: 500 })

      const error = await unsafe
        .reserveCreditsV2({
          userId,
          amount: 40,
          operationType: 'story_generation',
          expiresAt: soon(),
        })
        .catch((e) => e)
      expect(error.code).toBe(CreditErrorCode.UNSUPPORTED_OPERATION)
      expect(error.details?.reason).toBe('probe_not_answered')

      expect(await countReservations(ctx.pool, userId)).toBe(0)
      expect((await readBalance(ctx.pool, userId))?.reserved).toBe(0)
    })

    it('does not blame the handle when the probe fails for another reason', async () => {
      // 25P02 means the transaction is real but already aborted. Calling that
      // "you did not give us a transaction" would send the caller chasing the
      // wrong bug, so only 25P01 gets the UNSUPPORTED_OPERATION reading.
      const aborted = (inner: DrizzleLikeDB): DrizzleLikeDB => ({
        select: inner.select.bind(inner),
        insert: inner.insert.bind(inner),
        update: inner.update.bind(inner),
        execute: (async () => {
          throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' })
        }) as never,
        transaction: ((cb: (tx: DrizzleLikeDB) => Promise<unknown>) =>
          ctx.db.transaction((tx) => cb(aborted(tx as unknown as DrizzleLikeDB)))) as never,
      })

      const unsafe = new DrizzleCreditRepository(aborted(ctx.db as unknown as DrizzleLikeDB))
      await seedBalance(ctx.pool, userId, { balance: 500 })

      const error = await unsafe
        .reserveCreditsV2({
          userId,
          amount: 40,
          operationType: 'story_generation',
          expiresAt: soon(),
        })
        .catch((e) => e)
      expect(error.code).toBe(CreditErrorCode.DATABASE_ERROR)
      expect(error.code).not.toBe(CreditErrorCode.UNSUPPORTED_OPERATION)
      expect(await countReservations(ctx.pool, userId)).toBe(0)
    })

    it('works inside a caller-owned transaction, and rolls back with it', async () => {
      await seedBalance(ctx.pool, userId, { balance: 500 })

      // A pre-opened transaction is supported: `tx.transaction()` opens a
      // SAVEPOINT, so the operation is still atomic within the caller's unit.
      await expect(
        ctx.db.transaction(async (tx) => {
          const scoped = new DrizzleCreditRepository(tx as unknown as DrizzleLikeDB)
          const outcome = await scoped.reserveCreditsV2({
            userId,
            amount: 40,
            operationType: 'story_generation',
            expiresAt: soon(),
          })
          expect(outcome.outcome).toBe('created')
          throw new Error('caller aborts')
        })
      ).rejects.toThrow('caller aborts')

      // The caller's rollback took our writes with it.
      expect(await countReservations(ctx.pool, userId)).toBe(0)
      expect((await readBalance(ctx.pool, userId))?.reserved).toBe(0)
    })
  })

  // ==================== Blocker 6: journal collision ====================

  describe('journal key collision', () => {
    async function seedForeignJournalEntry(
      reservationId: string,
      overrides: string,
      metadata = '{"operationType":"story_generation"}'
    ) {
      await ctx.pool.query(
        `INSERT INTO credit_journal_entries
           (user_id, entry_type, amount, balance_after, source, reference_id,
            reference_type, description, metadata, idempotency_key)
         VALUES ($1, 'debit', ${overrides}, 'operation_commit', $2, 'reservation',
                 'pre-existing', $4::jsonb, $3)`,
        [userId, reservationId, reservationJournalKey(reservationId, 'commit'), metadata]
      )
    }

    it('rolls back rather than accept a journal row with a different amount', async () => {
      await seedBalance(ctx.pool, userId, { balance: 500 })
      const reservation = await hold(60)
      // Same key, same reservation, but records a 5-credit charge, not 60.
      await seedForeignJournalEntry(reservation.id, `5, 495`)

      const error = await repo.commitReservationV2(userId, reservation.id).catch((e) => e)
      expect(isCreditError(error)).toBe(true)
      expect(error.code).toBe(CreditErrorCode.DATABASE_ERROR)
      expect(error.details?.mismatch).toBe('amount')

      // No charge leaked: the balance never moved and the hold is still live.
      const balance = await readBalance(ctx.pool, userId)
      expect(balance).toMatchObject({ balance: 500, reserved: 60, monthly_used: 0 })
      const { rows } = await ctx.pool.query(
        `SELECT status FROM credit_reservations WHERE id = $1`,
        [reservation.id]
      )
      expect(rows[0].status).toBe('reserved')
      expect(await countJournal(ctx.pool, userId)).toBe(1)
    })

    it('rolls back on a mismatched balance_after', async () => {
      await seedBalance(ctx.pool, userId, { balance: 500 })
      const reservation = await hold(60)
      await seedForeignJournalEntry(reservation.id, `60, 999`)

      const error = await repo.commitReservationV2(userId, reservation.id).catch((e) => e)
      expect(error.details?.mismatch).toBe('balance_after')
      expect((await readBalance(ctx.pool, userId))?.balance).toBe(500)
    })

    it('rolls back on metadata the commit does not carry', async () => {
      await seedBalance(ctx.pool, userId, { balance: 500 })
      const reservation = await hold(60)
      // Every compared column matches what the commit is about to write. Only
      // the metadata disagrees: the stored row claims a 999-credit hold. A
      // one-sided comparison ("does the *expected* metadata have an amount?")
      // waves this through, because a commit's metadata carries no amount.
      await seedForeignJournalEntry(
        reservation.id,
        `60, 440`,
        '{"operationType":"story_generation","amount":999}'
      )

      const error = await repo.commitReservationV2(userId, reservation.id).catch((e) => e)
      expect(isCreditError(error)).toBe(true)
      expect(error.code).toBe(CreditErrorCode.DATABASE_ERROR)
      expect(error.details?.mismatch).toBe('metadata.amount')

      const balance = await readBalance(ctx.pool, userId)
      expect(balance).toMatchObject({ balance: 500, reserved: 60 })
    })

    it('accepts an exactly matching row as the idempotent replay it is', async () => {
      await seedBalance(ctx.pool, userId, { balance: 500 })
      const reservation = await hold(60)
      // Exactly what the commit is about to write: amount 60, balance_after 440.
      await seedForeignJournalEntry(reservation.id, `60, 440`)

      const outcome = await repo.commitReservationV2(userId, reservation.id)
      expect(outcome.outcome).toBe('committed')
      expect(await countJournal(ctx.pool, userId)).toBe(1)
      expect((await readBalance(ctx.pool, userId))?.balance).toBe(440)
    })
  })

  // ==================== Blocker 8: balance invariants ====================

  describe('balance invariants', () => {
    it('refuses to commit a hold that reserved no longer covers', async () => {
      await seedBalance(ctx.pool, userId, { balance: 500 })
      const reservation = await hold(60)
      // Two other holds' worth of coverage vanishes from under this one.
      await ctx.pool.query(`UPDATE credit_balances SET reserved = 10 WHERE user_id = $1`, [userId])

      const error = await repo.commitReservationV2(userId, reservation.id).catch((e) => e)
      expect(error.code).toBe(CreditErrorCode.DATABASE_ERROR)
      expect(error.code).not.toBe(CreditErrorCode.INSUFFICIENT_CREDITS)

      const balance = await readBalance(ctx.pool, userId)
      expect(balance).toMatchObject({ balance: 500, reserved: 10, monthly_used: 0 })
      expect(await countJournal(ctx.pool, userId)).toBe(0)
    })

    it('does not floor reserved, which would steal other holds coverage', async () => {
      await seedBalance(ctx.pool, userId, { balance: 500 })
      const big = await hold(300)
      const small = await hold(50)
      expect((await readBalance(ctx.pool, userId))?.reserved).toBe(350)

      // Corrupt `reserved` so it covers the small hold but not the big one.
      await ctx.pool.query(`UPDATE credit_balances SET reserved = 50 WHERE user_id = $1`, [userId])

      await expect(repo.commitReservationV2(userId, big.id)).rejects.toMatchObject({
        code: CreditErrorCode.DATABASE_ERROR,
      })

      // The old `greatest(reserved - 300, 0)` would have written reserved = 0
      // here, silently consuming the small hold's coverage. It survives.
      expect((await readBalance(ctx.pool, userId))?.reserved).toBe(50)
      const outcome = await repo.commitReservationV2(userId, small.id)
      expect(outcome.outcome).toBe('committed')
      expect((await readBalance(ctx.pool, userId))?.reserved).toBe(0)
    })

    it('refuses to release a hold that reserved no longer covers', async () => {
      await seedBalance(ctx.pool, userId, { balance: 500 })
      const reservation = await hold(60)
      await ctx.pool.query(`UPDATE credit_balances SET reserved = 10 WHERE user_id = $1`, [userId])

      await expect(repo.releaseReservationV2(userId, reservation.id)).rejects.toMatchObject({
        code: CreditErrorCode.DATABASE_ERROR,
      })

      const { rows } = await ctx.pool.query(
        `SELECT status FROM credit_reservations WHERE id = $1`,
        [reservation.id]
      )
      expect(rows[0].status).toBe('reserved')
      expect((await readBalance(ctx.pool, userId))?.reserved).toBe(10)
    })
  })

  // ==================== Blocker 4: amount validation ====================

  describe('expiry sweep', () => {
    async function seedExpiredReservation(owner: string, amount: number) {
      const { rows } = await ctx.pool.query(
        `INSERT INTO credit_reservations (user_id, amount, operation_type, status, expires_at)
         VALUES ($1, $2, 'story_generation', 'reserved', now() - interval '1 hour')
         RETURNING id`,
        [owner, String(amount)]
      )
      return rows[0].id as string
    }

    it('keeps sweeping past a batch that is entirely poisoned', async () => {
      // Two corrupt rows first: their owner's `reserved` cannot cover them, so
      // expiring them raises DATABASE_ERROR. Then one healthy row behind them.
      const poisoned = newUserId()
      await seedBalance(ctx.pool, poisoned, { balance: 500, reserved: 0 })
      await seedExpiredReservation(poisoned, 40)
      await seedExpiredReservation(poisoned, 40)

      const healthy = newUserId()
      await seedBalance(ctx.pool, healthy, { balance: 500, reserved: 50 })
      await seedExpiredReservation(healthy, 50)

      // A batch size of 2 means the first batch is nothing but poison. Giving
      // up there is exactly the starvation the skip list is meant to prevent.
      const result = await repo.findAndExpireReservations(2, 10)

      expect(result.errors).toHaveLength(2)
      expect(result.expiredCount).toBe(1)
      expect(result.creditsReleased).toBe(50)
      expect((await readBalance(ctx.pool, healthy))?.reserved).toBe(0)
    })
  })

  describe('numeric(12,2) validation', () => {
    it('rejects out-of-grid amounts before touching the database', async () => {
      await seedBalance(ctx.pool, userId, { balance: 1000 })
      for (const amount of [1.005, 0, -5, NaN, Infinity, 10_000_000_000]) {
        await expect(
          repo.reserveCreditsV2({
            userId,
            amount,
            operationType: 'story_generation',
            expiresAt: soon(),
          })
        ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT })
      }
      expect(await countReservations(ctx.pool, userId)).toBe(0)
      expect((await readBalance(ctx.pool, userId))?.reserved).toBe(0)
    })

    it('accepts the boundary values the column can hold', async () => {
      await seedBalance(ctx.pool, userId, { balance: 1000 })
      const outcome = await repo.reserveCreditsV2({
        userId,
        amount: 0.01,
        operationType: 'story_generation',
        expiresAt: soon(),
      })
      expect(outcome.outcome).toBe('created')
      expect((await readBalance(ctx.pool, userId))?.reserved).toBeCloseTo(0.01, 2)
    })
  })

  // ==================== Blocker 7: error classification ====================

  describe('error classification', () => {
    it('maps a lock timeout (55P03) to TRANSIENT_ERROR', async () => {
      await seedBalance(ctx.pool, userId, { balance: 500 })
      const reservation = await hold(60)

      // A dedicated pool whose connections give up on a lock quickly. Without
      // its own `lock_timeout` the commit below would block until the test
      // timeout instead of producing the SQLSTATE we want to classify.
      const impatientPool = new pg.Pool({
        connectionString: TEST_DATABASE_URL,
        max: 2,
        options: '-c lock_timeout=250ms',
      })
      const impatient = new DrizzleCreditRepository(drizzle(impatientPool))

      // Hold the reservation row from another connection so FOR UPDATE blocks.
      const blocker = await ctx.pool.connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query(`SELECT * FROM credit_reservations WHERE id = $1 FOR UPDATE`, [
          reservation.id,
        ])

        const error = await impatient.commitReservationV2(userId, reservation.id).catch((e) => e)
        expect(isCreditError(error)).toBe(true)
        expect(error.code).toBe(CreditErrorCode.TRANSIENT_ERROR)
        expect(error.details?.sqlState).toBe('55P03')
        expect(error.details?.operation).toBe('commitReservationV2')
      } finally {
        await blocker.query('ROLLBACK')
        blocker.release()
        await impatientPool.end()
      }

      // The blocked attempt changed nothing, and a retry now succeeds.
      expect(await countJournal(ctx.pool, userId)).toBe(0)
      expect((await repo.commitReservationV2(userId, reservation.id)).outcome).toBe('committed')
    })

    it('maps a deterministic constraint failure to DATABASE_ERROR', async () => {
      await seedBalance(ctx.pool, userId, { balance: 500 })
      // A trigger that raises a non-transient, non-CreditError failure mid-commit.
      await ctx.pool.query(`
        CREATE OR REPLACE FUNCTION credits_blocker_boom() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'deterministic failure' USING ERRCODE = '23514'; END;
        $$ LANGUAGE plpgsql`)
      await ctx.pool.query(`
        CREATE TRIGGER credits_blocker_boom_trg BEFORE INSERT ON credit_journal_entries
        FOR EACH ROW EXECUTE FUNCTION credits_blocker_boom()`)

      try {
        const reservation = await hold(60)
        const error = await repo.commitReservationV2(userId, reservation.id).catch((e) => e)
        expect(isCreditError(error)).toBe(true)
        expect(error.code).toBe(CreditErrorCode.DATABASE_ERROR)
        expect(error.details?.operation).toBe('commitReservationV2')
        // Rolled back whole.
        expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: 500, monthly_used: 0 })
      } finally {
        await ctx.pool.query(
          `DROP TRIGGER IF EXISTS credits_blocker_boom_trg ON credit_journal_entries`
        )
      }
    })

    it('passes an existing CreditError through without downgrading it', async () => {
      await seedBalance(ctx.pool, userId, { balance: 100 })
      const reservation = await hold(100)
      // Drain the funds behind a live hold: commit must still say INSUFFICIENT,
      // not be flattened into a generic DATABASE_ERROR by the classifier.
      await ctx.pool.query(`UPDATE credit_balances SET balance = 5 WHERE user_id = $1`, [userId])

      await expect(repo.commitReservationV2(userId, reservation.id)).rejects.toMatchObject({
        code: CreditErrorCode.INSUFFICIENT_CREDITS,
      })
    })
  })
})
