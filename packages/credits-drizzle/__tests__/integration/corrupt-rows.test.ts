/**
 * What a real PostgreSQL does when a reservation row cannot be trusted.
 *
 * Every amount here is written with raw SQL, because that is how it would get
 * there: an older version of this library, a data-repair script, a hand-run
 * UPDATE. The `numeric(12, 2)` column will take a negative number quite
 * happily, and `reserved >= -10` is true, and `balance - (-10)` adds — which is
 * exactly how a corrupt hold minted credits before the guard existed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CreditErrorCode, CreditsService, reservationJournalKey } from '@nehorai/credits'
import { DrizzleCreditRepository } from '../../src/repository/index.js'
import { ensureUserCredits } from '../../src/repository/ensure-user.js'
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

describeIntegration('corrupt persisted amounts (PostgreSQL)', () => {
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

  /** Write a reservation row directly, at whatever amount we like. */
  async function plantReservation(amount: string): Promise<string> {
    await seedBalance(ctx.pool, userId, { balance: 100, reserved: 10 })
    const { rows } = await ctx.pool.query(
      `INSERT INTO credit_reservations
         (user_id, amount, operation_type, status, expires_at, hold_placed_at)
       VALUES ($1, $2::numeric, 'story_generation', 'reserved', now() - interval '1 minute', now())
       RETURNING id`,
      [userId, amount]
    )
    return rows[0].id as string
  }

  async function snapshot(reservationId: string) {
    const balance = await readBalance(ctx.pool, userId)
    const { rows } = await ctx.pool.query(
      `SELECT status, completed_at FROM credit_reservations WHERE id = $1`,
      [reservationId]
    )
    return {
      balance,
      status: rows[0]?.status,
      completedAt: rows[0]?.completed_at,
      journal: await countJournal(ctx.pool, userId),
    }
  }

  // `numeric(12, 2)` rounds on write, so '1.005' lands as 1.01 and is not
  // corrupt at all. What it cannot round away is a sign, a zero, or a
  // magnitude — and 'NaN' is a value numeric genuinely accepts.
  const CORRUPT: Array<[string, string]> = [
    ['negative', '-10'],
    ['zero', '0'],
    ['NaN', 'NaN'],
  ]

  for (const [label, amount] of CORRUPT) {
    it(`refuses every transition on a ${label} amount, changing nothing`, async () => {
      const reservationId = await plantReservation(amount)
      const before = await snapshot(reservationId)

      for (const transition of ['commit', 'release', 'expire'] as const) {
        const call =
          transition === 'commit'
            ? repo.commitReservationV2(userId, reservationId)
            : transition === 'release'
              ? repo.releaseReservationV2(userId, reservationId)
              : repo.expireReservationV2(userId, reservationId)

        await expect(call, `${transition} must refuse`).rejects.toMatchObject({
          code: CreditErrorCode.INVALID_AMOUNT,
          details: { reason: 'corrupt_stored_amount' },
        })

        expect(await snapshot(reservationId), `${transition} must not mutate`).toEqual(before)
      }
    })
  }

  it('does not mint credits from a negative hold', async () => {
    // The original reproduction, verbatim: commit returned `committed` while
    // balance went 100 -> 110, reserved 0 -> 10, monthly_used 0 -> -10.
    const reservationId = await plantReservation('-10')

    await expect(repo.commitReservationV2(userId, reservationId)).rejects.toThrow()

    expect(await readBalance(ctx.pool, userId)).toMatchObject({
      balance: 100,
      reserved: 10,
      monthly_used: 0,
    })
    expect(await countJournal(ctx.pool, userId)).toBe(0)
  })

  it('refuses an out-of-range amount the column itself would reject on write', async () => {
    // `numeric(12, 2)` cannot hold 1e12, so the corruption cannot be persisted
    // here at all — which is the constraint doing its job one layer down.
    await seedBalance(ctx.pool, userId, { balance: 100, reserved: 10 })
    await expect(
      ctx.pool.query(
        `INSERT INTO credit_reservations (user_id, amount, operation_type, status, expires_at)
         VALUES ($1, 1000000000000, 'story_generation', 'reserved', now())`,
        [userId]
      )
    ).rejects.toMatchObject({ code: '22003' })
  })

  it('rejects an over-precision amount before it can reach the column', async () => {
    // Through the library the value never gets to be rounded silently.
    await seedBalance(ctx.pool, userId, { balance: 100 })
    await expect(
      repo.createReservation({
        userId,
        amount: 1.005,
        operationType: 'story_generation',
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT })
  })
})

/**
 * The same guard on the paths that return a *successful* outcome.
 *
 * `already_terminal` and `not_due` both tell the caller the reservation is
 * fine. Over a row whose amount is negative or zero, that is the one claim the
 * quarantine exists to refuse — so the check runs before those exits, not just
 * before the write.
 */
describeIntegration('corrupt amounts on the early-exit paths (PostgreSQL)', () => {
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

  /** A row in any status, at any amount, expiring whenever we say. */
  async function plant(amount: string, status: string, expiry: string): Promise<string> {
    await seedBalance(ctx.pool, userId, { balance: 100, reserved: 10 })
    const { rows } = await ctx.pool.query(
      `INSERT INTO credit_reservations
         (user_id, amount, operation_type, status, expires_at, hold_placed_at)
       VALUES ($1, $2::numeric, 'story_generation', $3, now() ${expiry}, now())
       RETURNING id`,
      [userId, amount, status]
    )
    return rows[0].id as string
  }

  const CORRUPT = ['-10', '0']

  for (const amount of CORRUPT) {
    it(`refuses to commit an already-committed row holding ${amount}`, async () => {
      const id = await plant(amount, 'committed', "- interval '1 minute'")
      await expect(repo.commitReservationV2(userId, id)).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
        details: { reason: 'corrupt_stored_amount' },
      })
    })

    it(`refuses to release an already-released row holding ${amount}`, async () => {
      const id = await plant(amount, 'released', "- interval '1 minute'")
      await expect(repo.releaseReservationV2(userId, id)).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
      })
    })

    it(`refuses to expire a not-yet-due row holding ${amount}`, async () => {
      const id = await plant(amount, 'reserved', "+ interval '1 hour'")
      await expect(repo.expireReservationV2(userId, id)).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
      })
    })
  }

  it('still reports already_terminal for a healthy committed row', async () => {
    const id = await plant('10', 'committed', "- interval '1 minute'")
    expect((await repo.commitReservationV2(userId, id)).outcome).toBe('already_terminal')
  })

  it('still reports not_due for a healthy undue row', async () => {
    const id = await plant('10', 'reserved', "+ interval '1 hour'")
    expect((await repo.expireReservationV2(userId, id)).outcome).toBe('not_due')
  })

  it('leaves the balance untouched when it refuses an early exit', async () => {
    const id = await plant('-10', 'committed', "- interval '1 minute'")
    await expect(repo.commitReservationV2(userId, id)).rejects.toThrow()
    expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: 100, reserved: 10 })
  })
})

describeIntegration('public write validation (PostgreSQL)', () => {
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

  it('rejects an idempotency key on the direct writer instead of storing one', async () => {
    // `createReservation` inserts a row and never touches `reserved`, so a key
    // it stored would name a hold it did not place — and `reserveCreditsV2`
    // would then adopt that row as a replay. Every key is refused here now, so
    // a blank one is refused as `UNSUPPORTED_OPERATION` rather than as an
    // invalid key: the problem is the method, not the value.
    await expect(
      repo.createReservation({
        userId,
        amount: 5,
        operationType: 'story_generation',
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: '   ',
      })
    ).rejects.toMatchObject({ code: CreditErrorCode.UNSUPPORTED_OPERATION })

    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM credit_reservations WHERE user_id = $1`,
      [userId]
    )
    expect(rows[0].n).toBe(0)
  })

  it('refuses a public journal write in the transitions’ namespace', async () => {
    await expect(
      repo.createJournalEntry({
        userId,
        entryType: 'debit',
        amount: 10,
        balanceAfter: 90,
        source: 'operation_commit',
        description: 'planted',
        idempotencyKey: reservationJournalKey('some-reservation', 'commit'),
      })
    ).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_IDEMPOTENCY_KEY,
      details: { reason: 'reserved_namespace' },
    })
    expect(await countJournal(ctx.pool, userId)).toBe(0)
  })

  it('rejects unspendable amounts at the legacy atomic methods', async () => {
    for (const amount of [0, -5, 1.005, Number.POSITIVE_INFINITY, 1e12]) {
      await expect(repo.deductCreditsAtomic(userId, amount)).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
      })
      await expect(repo.addCreditsAtomic(userId, amount, 'top-up')).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
      })
    }
    expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: 100 })
  })

  it('reports a numeric overflow as an amount problem naming the derived total', async () => {
    // Valid operands, impossible result. `bonus_credits + 100` fits perfectly
    // well; what does not fit is the *total* the transaction and journal rows
    // record. Naming `bonusCredits` here — which the expression-based update
    // used to do, because SQLSTATE 22003 does not say which expression failed —
    // would send an operator to inspect a column that is entirely fine.
    await ctx.pool.query(`UPDATE credit_balances SET balance = 9999999999.99 WHERE user_id = $1`, [
      userId,
    ])
    await expect(repo.addCreditsAtomic(userId, 100, 'overflow')).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
      details: { field: 'newBalance', operation: 'addCredits', userId },
    })
    expect(await readBalance(ctx.pool, userId)).toMatchObject({
      balance: 9999999999.99,
      bonus: 0,
    })
  })
})

/**
 * Precision the mapped JS number cannot represent.
 *
 * `credit_reservations.amount` is `numeric(12, 2)` in the shipped schema, but a
 * legacy or hand-migrated deployment can have an unconstrained `numeric` — and
 * that column holds digits a double cannot. `Number('9999999999.9900001')` is
 * `9999999999.99`, a perfectly valid amount, so a guard that inspects the
 * mapped value sees nothing wrong while PostgreSQL keeps doing exact arithmetic
 * with the digits JavaScript dropped.
 */
describeIntegration('lossy stored precision (PostgreSQL)', () => {
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
    // Exactly the legacy shape: no scale constraint on the money column.
    await ctx.pool.query('ALTER TABLE credit_reservations ALTER COLUMN amount TYPE numeric')
  })
  afterEach(async () => {
    // Truncate first: a planted row that the constrained type cannot hold would
    // make the ALTER fail and leak the widened column into the next test.
    await truncateAll(ctx.pool)
    await ctx.pool.query(
      'ALTER TABLE credit_reservations ALTER COLUMN amount TYPE numeric(12,2)'
    )
  })

  async function plant(amount: string, status = 'reserved', expiry = "- interval '1 minute'") {
    await seedBalance(ctx.pool, userId, { balance: 100, reserved: 10 })
    const { rows } = await ctx.pool.query(
      `INSERT INTO credit_reservations
         (user_id, amount, operation_type, status, expires_at, hold_placed_at)
       VALUES ($1, $2::numeric, 'story_generation', $3, now() ${expiry}, now())
       RETURNING id, amount::text AS stored`,
      [userId, amount, status]
    )
    return rows[0]
  }

  /** Values a double either rounds into the valid band or destroys outright. */
  const LOSSY = [
    ['one digit past the cent grid, at the ceiling', '9999999999.9900001'],
    ['a third of a cent', '1.005'],
    ['far past the column range', '99999999999999.99'],
    ['not a number at all', 'NaN'],
  ] as const

  for (const [label, amount] of LOSSY) {
    it(`refuses to commit ${label}`, async () => {
      const row = await plant(amount)
      await expect(repo.commitReservationV2(userId, row.id)).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
        details: { reason: 'corrupt_stored_amount' },
      })
      // Nothing moved, and the row still holds exactly what was planted.
      expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: 100, reserved: 10 })
      const { rows } = await ctx.pool.query(
        'SELECT status, amount::text AS stored FROM credit_reservations WHERE id = $1',
        [row.id]
      )
      expect(rows[0]).toMatchObject({ status: 'reserved', stored: row.stored })
    })

    it(`refuses to release ${label}`, async () => {
      const row = await plant(amount)
      await expect(repo.releaseReservationV2(userId, row.id)).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
        details: { reason: 'corrupt_stored_amount' },
      })
      expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: 100, reserved: 10 })
    })

    it(`refuses to expire ${label}`, async () => {
      const row = await plant(amount)
      await expect(repo.expireReservationV2(userId, row.id)).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
        details: { reason: 'corrupt_stored_amount' },
      })
      expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: 100, reserved: 10 })
    })

    it(`refuses ${label} on the terminal path too`, async () => {
      const row = await plant(amount, 'committed')
      await expect(repo.commitReservationV2(userId, row.id)).rejects.toMatchObject({
        code: CreditErrorCode.INVALID_AMOUNT,
      })
    })
  }

  it('does not replay an idempotency key onto a lossily-equal stored amount', async () => {
    // The replay check used to compare the *mapped* `Number`, and
    // `9999999999.9900001` maps to `9999999999.99`. A retry for the latter
    // therefore came back `replayed` against a row that does not hold it, and
    // the caller was handed a reservation whose payload it never asked for.
    await ctx.pool.query(
      `INSERT INTO credit_reservations
         (user_id, amount, operation_type, status, expires_at, idempotency_key, hold_placed_at)
       VALUES ($1, '9999999999.9900001'::numeric, 'story_generation', 'reserved',
               now() + interval '10 minutes', 'key-lossy', now())`,
      [userId]
    )

    const outcome = await repo.reserveCreditsV2({
      userId,
      amount: 9999999999.99,
      operationType: 'story_generation',
      expiresAt: new Date(Date.now() + 600_000),
      idempotencyKey: 'key-lossy',
    })

    expect(outcome.outcome).toBe('idempotency_conflict')
    expect(outcome).toMatchObject({ idempotencyKey: 'key-lossy' })
  })

  it('still replays a key whose stored amount matches exactly', async () => {
    // The other half of the contract: an exact match must still be a replay,
    // or the fix above would have turned every legitimate retry into a
    // conflict.
    await ctx.pool.query(
      `INSERT INTO credit_reservations
         (user_id, amount, operation_type, status, expires_at, idempotency_key, hold_placed_at)
       VALUES ($1, '12.34'::numeric, 'story_generation', 'reserved',
               now() + interval '10 minutes', 'key-exact', now())`,
      [userId]
    )

    const outcome = await repo.reserveCreditsV2({
      userId,
      amount: 12.34,
      operationType: 'story_generation',
      expiresAt: new Date(Date.now() + 600_000),
      idempotencyKey: 'key-exact',
    })

    expect(outcome.outcome).toBe('replayed')
    expect(outcome).toMatchObject({ reservation: { amount: 12.34 } })
  })

  it('reports the stored digits, not the rounded ones', async () => {
    const row = await plant('9999999999.9900001')
    const error = await repo.commitReservationV2(userId, row.id).catch((e) => e)
    expect(error.details.amount).toBe('9999999999.9900001')
  })

  it('still commits an amount the column and a double both hold exactly', async () => {
    const row = await plant('9999999999.99')
    await ctx.pool.query('UPDATE credit_balances SET balance = 9999999999.99, reserved = 9999999999.99 WHERE user_id = $1', [userId])
    const outcome = await repo.commitReservationV2(userId, row.id)
    expect(outcome.outcome).toBe('committed')
  })
})

/**
 * The same derived-overflow boundaries the in-memory adapter is tested at, so
 * the two agree on what fails and with what context. The SQL adapter has a
 * transaction to roll back, but a caller must still get `INVALID_AMOUNT` naming
 * the field rather than a bare SQLSTATE 22003 off the driver.
 */
describeIntegration('derived numeric writes (PostgreSQL)', () => {
  const CEILING = 9999999999.99
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

  it('refuses an increment that overflows, naming the field and operation', async () => {
    await seedBalance(ctx.pool, userId, { balance: CEILING })
    await expect(
      repo.updateUserCredits(userId, { balanceIncrement: 0.01 })
    ).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
      details: {
        field: 'balance',
        operation: 'updateUserCredits',
        userId,
        // This path still sums in PostgreSQL, so it is also the regression that
        // keeps the SQLSTATE 22003 classifier honest.
        reason: 'amount_out_of_range',
        sqlState: '22003',
      },
    })
    expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: CEILING })
  })

  it('refuses addCredits at the ceiling and rolls back', async () => {
    await seedBalance(ctx.pool, userId, { balance: CEILING })
    await expect(repo.addCreditsAtomic(userId, 0.01, 'top-up')).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
      // `bonusCredits` becomes 0.01, which is fine; the total is what overflows.
      details: { field: 'newBalance', operation: 'addCredits', userId },
    })
    expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: CEILING })
  })

  async function storedLimit(id: string) {
    const { rows } = await ctx.pool.query(
      'SELECT monthly_limit::text AS limit FROM credit_balances WHERE user_id = $1',
      [id]
    )
    return Number(rows[0].limit)
  }

  it('stores the exact canonical unlimited-tier limit, not zero', async () => {
    // The `unlimited` tier, not `free`: only an actually-unlimited tier produces
    // the `Infinity` sentinel this contract is about.
    const credits = await repo.initializeUserCredits(userId, 'unlimited', 0)

    // The literal canonical value on both sides. Comparing the column against
    // whatever the adapter returned would pass even if both reverted to 0.
    expect(credits.monthlyLimit).toBe(CEILING)
    expect(await storedLimit(userId)).toBe(CEILING)
    expect(await storedLimit(userId)).not.toBe(0)
  })

  it('stores the same limit on the implicit auto-create path', async () => {
    // `ensureUserCredits` had its own `isFinite ? x : 0`, so a user created
    // implicitly on an unlimited tier got a zero allowance and zero credits.
    await ensureUserCredits(ctx.db, userId, 'unlimited')
    expect(await storedLimit(userId)).toBe(CEILING)
    expect(await storedLimit(userId)).not.toBe(0)
  })

  it('stores the canonical limit when a tier upgrade goes through the service', async () => {
    // The public upgrade path, against the real column. `CreditsService.updateTier`
    // wrote a literal 0 for an unlimited tier under a convention no read path
    // implements, so an upgraded user was persisted with a zero allowance.
    await repo.initializeUserCredits(userId, 'free', 10)

    await new CreditsService(repo).updateTier(userId, 'unlimited')

    expect(await storedLimit(userId)).toBe(CEILING)
    expect(await storedLimit(userId)).not.toBe(0)
  })

  it('refuses a deduction whose derived total cannot be represented', async () => {
    // Each column legal on its own; `previousBalance` is their sum.
    await seedBalance(ctx.pool, userId, { balance: CEILING, bonusCredits: CEILING })

    await expect(repo.deductCreditsAtomic(userId, 1)).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
      details: { field: 'previousBalance', operation: 'deductCredits', userId },
    })

    expect(await readBalance(ctx.pool, userId)).toMatchObject({
      balance: CEILING,
      bonus: CEILING,
    })
  })

  /**
   * The journal's `balanceAfter` is a total, not one of the balance columns, so
   * per-column validation says nothing about it — and the error has to name the
   * transition, or an operator reading it cannot tell which of the three
   * refused.
   */
  it.each([
    ['commit', 'commitReservation'],
    ['release', 'releaseReservation'],
    ['expire', 'expireReservation'],
  ])('refuses %s when the recorded total cannot be represented', async (transition, operation) => {
    await seedBalance(ctx.pool, userId, { balance: CEILING, bonusCredits: CEILING })
    const held = await repo.reserveCreditsV2({
      userId,
      amount: 1,
      operationType: 'story_generation',
      expiresAt: new Date(Date.now() + 60_000),
    })
    const reservationId = held.reservation!.id

    const run = () => {
      if (transition === 'commit') return repo.commitReservationV2(userId, reservationId)
      if (transition === 'release') return repo.releaseReservationV2(userId, reservationId)
      return repo.expireReservationV2(userId, reservationId, {
        asOf: new Date(Date.now() + 600_000),
      })
    }

    await expect(run()).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
      details: { field: 'journal balanceAfter', operation, userId, reservationId },
    })

    // The transaction rolled back: the hold is still a hold and no entry exists.
    expect(await readBalance(ctx.pool, userId)).toMatchObject({
      balance: CEILING,
      bonus: CEILING,
      reserved: 1,
    })
    const { rows } = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM credit_journal_entries WHERE reference_id = $1',
      [reservationId]
    )
    expect(rows[0].n).toBe(0)

    // And the reservation itself is untouched, not half-completed: a rollback
    // that left `status` terminal would strand the hold with the credits still
    // held, which a `reserved` check alone would not notice.
    const { rows: held2 } = await ctx.pool.query(
      'SELECT status, completed_at FROM credit_reservations WHERE id = $1',
      [reservationId]
    )
    expect(held2[0]).toMatchObject({ status: 'reserved', completed_at: null })
  })

  /**
   * The V2 transitions mutate with column expressions on purpose, so their
   * derived sums are computed by PostgreSQL and a total that will not fit
   * arrives as SQLSTATE 22003 rather than as a JS guard. Left unhandled that
   * surfaces as `DATABASE_ERROR`, while the in-memory adapter refuses the same
   * transition with `INVALID_AMOUNT` and names the column. These pin the two
   * adapters to the same code *and* the same context.
   */
  /**
   * `paymentRef` is the idempotency key for a purchase, and the guard reads it
   * inside the same transaction that now takes a row lock. Neither the lock nor
   * the derived-value validation may weaken it: a replayed webhook must credit
   * the account exactly once, and the concurrent case must not double-credit.
   */
  describe('paymentRef replay', () => {
    async function purchases(id: string) {
      const { rows } = await ctx.pool.query(
        `SELECT amount::text AS amount, new_balance::text AS new_balance
           FROM credit_plugin_transactions WHERE user_id = $1 ORDER BY created_at`,
        [id]
      )
      return rows
    }

    it('credits once when the same reference is delivered twice', async () => {
      await seedBalance(ctx.pool, userId, { balance: 10 })

      await repo.addCreditsAtomic(userId, 25, 'top-up', 'pay_replay_1')
      await repo.addCreditsAtomic(userId, 25, 'top-up', 'pay_replay_1')

      expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: 10, bonus: 25 })
      expect(await purchases(userId)).toHaveLength(1)
      expect(await countJournal(ctx.pool, userId)).toBe(1)
    })

    it('credits each distinct reference', async () => {
      await seedBalance(ctx.pool, userId, { balance: 10 })

      await repo.addCreditsAtomic(userId, 25, 'top-up', 'pay_distinct_a')
      await repo.addCreditsAtomic(userId, 5, 'top-up', 'pay_distinct_b')

      expect(await readBalance(ctx.pool, userId)).toMatchObject({ bonus: 30 })
      // The second purchase's `previousBalance` sees the first. These calls are
      // sequential, so this shows the derivation reads committed state — not
      // that the row lock works; nothing here contends for it.
      expect(await purchases(userId)).toEqual([
        { amount: '25.00', new_balance: '35.00' },
        { amount: '5.00', new_balance: '40.00' },
      ])
    })

    it('does not double-credit when the same reference races itself', async () => {
      await seedBalance(ctx.pool, userId, { balance: 10 })

      // The duplicate guard is a plain read, so both transactions *can* miss
      // it. Nothing here forces them to — there is no barrier holding both past
      // the read — so this asserts the invariant, not the interleaving: however
      // the two are scheduled, the account ends up credited exactly once. The
      // partial unique index on `payment_ref` is what makes that hold when the
      // read does miss, by rolling the loser's whole transaction back.
      const settled = await Promise.allSettled([
        repo.addCreditsAtomic(userId, 25, 'top-up', 'pay_race'),
        repo.addCreditsAtomic(userId, 25, 'top-up', 'pay_race'),
      ])
      expect(settled.some((r) => r.status === 'fulfilled')).toBe(true)

      expect(await readBalance(ctx.pool, userId)).toMatchObject({ balance: 10, bonus: 25 })
      expect(await purchases(userId)).toHaveLength(1)
      expect(await countJournal(ctx.pool, userId)).toBe(1)
    })

    it('still refuses an unrepresentable total before consuming the reference', async () => {
      await seedBalance(ctx.pool, userId, { balance: CEILING })

      await expect(
        repo.addCreditsAtomic(userId, 0.01, 'top-up', 'pay_overflow')
      ).rejects.toMatchObject({ details: { field: 'newBalance', operation: 'addCredits' } })

      // The refusal rolled back, so the reference was never recorded and the
      // payment can be retried once the balance allows it.
      expect(await purchases(userId)).toHaveLength(0)
    })
  })

  it('refuses a hold that overflows reserved, naming the field', async () => {
    // Every column legal on its own, and enough available that the sufficiency
    // predicate does not reject first; only `reserved + amount` overflows.
    await seedBalance(ctx.pool, userId, {
      balance: CEILING,
      bonusCredits: CEILING,
      reserved: CEILING,
    })

    await expect(
      repo.reserveCreditsV2({
        userId,
        amount: 0.01,
        operationType: 'story_generation',
        expiresAt: new Date(Date.now() + 60_000),
      })
    ).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
      details: { field: 'reserved', operation: 'reserveCredits', userId },
    })

    expect(await readBalance(ctx.pool, userId)).toMatchObject({ reserved: CEILING })
  })

  it('refuses a commit that overflows monthlyUsed, naming the field', async () => {
    await seedBalance(ctx.pool, userId, { balance: 100 })
    await ctx.pool.query(
      'UPDATE credit_balances SET monthly_used = $2 WHERE user_id = $1',
      [userId, String(CEILING)]
    )
    const held = await repo.reserveCreditsV2({
      userId,
      amount: 1,
      operationType: 'story_generation',
      expiresAt: new Date(Date.now() + 60_000),
    })

    await expect(
      repo.commitReservationV2(userId, held.reservation!.id)
    ).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
      details: { field: 'monthlyUsed', operation: 'commitReservation', userId },
    })

    // The whole transaction rolled back: the hold is still a hold, and no
    // credits were spent.
    expect(await readBalance(ctx.pool, userId)).toMatchObject({
      balance: 100,
      reserved: 1,
      monthly_used: CEILING,
    })
  })
})
