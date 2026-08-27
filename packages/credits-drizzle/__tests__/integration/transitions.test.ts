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

describeIntegration('commit / release / expire races (PostgreSQL)', () => {
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

  async function hold(userId: string, amount: number, ttlMs = 60_000) {
    const outcome = await repo.reserveCreditsV2({
      userId,
      amount,
      operationType: 'story_generation',
      expiresAt: new Date(Date.now() + ttlMs),
    })
    if (outcome.outcome !== 'created') throw new Error(`expected created, got ${outcome.outcome}`)
    return outcome.reservation
  }

  it('deducts once for 50 concurrent commits of one reservation', async () => {
    const userId = newUserId()
    await seedBalance(ctx.pool, userId, { balance: 1000 })
    const reservation = await hold(userId, 40)

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => repo.commitReservationV2(userId, reservation.id))
    )

    const winners = outcomes.filter((o) => o.outcome === 'committed')
    expect(winners).toHaveLength(1)
    expect(outcomes.filter((o) => o.outcome === 'already_terminal')).toHaveLength(49)

    const balance = await readBalance(ctx.pool, userId)
    expect(balance).toMatchObject({
      balance: 960,
      reserved: 0,
      monthly_used: 40,
    })
    expect(await countJournal(ctx.pool, userId, 'operation_commit')).toBe(1)
    // Every loser must report the winning terminal state, not a fake success.
    for (const outcome of outcomes) {
      if (outcome.outcome === 'already_terminal') {
        expect(outcome.terminalStatus).toBe('committed')
      }
    }
  })

  it('preserves both deductions when two reservations commit concurrently', async () => {
    const userId = newUserId()
    await seedBalance(ctx.pool, userId, { balance: 1000 })
    const first = await hold(userId, 30)
    const second = await hold(userId, 45)

    const [a, b] = await Promise.all([
      repo.commitReservationV2(userId, first.id),
      repo.commitReservationV2(userId, second.id),
    ])
    expect(a.outcome).toBe('committed')
    expect(b.outcome).toBe('committed')

    // This is the literal-stale-write bug: 1000 - 30 - 45, never 1000 - 45.
    const balance = await readBalance(ctx.pool, userId)
    expect(balance).toMatchObject({
      balance: 925,
      reserved: 0,
      monthly_used: 75,
    })
    expect(await countJournal(ctx.pool, userId, 'operation_commit')).toBe(2)
  })

  it('spends balance before bonus credits', async () => {
    const userId = newUserId()
    await seedBalance(ctx.pool, userId, { balance: 10, bonusCredits: 100 })
    const reservation = await hold(userId, 30)

    const outcome = await repo.commitReservationV2(userId, reservation.id)
    expect(outcome.outcome).toBe('committed')
    if (outcome.outcome !== 'committed') return
    expect(outcome.balanceAfter).toBe(80)

    const balance = await readBalance(ctx.pool, userId)
    expect(balance).toMatchObject({ balance: 0, bonus: 80, reserved: 0 })
  })

  it('picks exactly one winner between commit and release', async () => {
    const userId = newUserId()
    await seedBalance(ctx.pool, userId, { balance: 1000 })

    for (let round = 0; round < 15; round += 1) {
      const reservation = await hold(userId, 10)
      const [commit, release] = await Promise.all([
        repo.commitReservationV2(userId, reservation.id),
        repo.releaseReservationV2(userId, reservation.id),
      ])

      const winners = [commit.outcome, release.outcome].filter(
        (o) => o === 'committed' || o === 'released'
      )
      expect(winners).toHaveLength(1)

      const { rows } = await ctx.pool.query(
        `SELECT status FROM credit_reservations WHERE id = $1`,
        [reservation.id]
      )
      expect(['committed', 'released']).toContain(rows[0].status)
      // Whichever won, the hold is fully unwound.
      const balance = await readBalance(ctx.pool, userId)
      expect(balance?.reserved).toBe(0)
    }
  })

  it('picks exactly one winner between commit and expire', async () => {
    const userId = newUserId()
    await seedBalance(ctx.pool, userId, { balance: 1000 })

    for (let round = 0; round < 15; round += 1) {
      // Already expired, so expire is eligible the moment it runs.
      const reservation = await hold(userId, 10, -1_000)
      const [commit, expire] = await Promise.all([
        repo.commitReservationV2(userId, reservation.id),
        repo.expireReservationV2(userId, reservation.id),
      ])

      const winners = [commit.outcome, expire.outcome].filter(
        (o) => o === 'committed' || o === 'expired'
      )
      expect(winners).toHaveLength(1)
      const balance = await readBalance(ctx.pool, userId)
      expect(balance?.reserved).toBe(0)
    }
  })

  it('refuses to expire a reservation that is not due', async () => {
    const userId = newUserId()
    await seedBalance(ctx.pool, userId, { balance: 100 })
    const reservation = await hold(userId, 10, 60_000)

    const outcome = await repo.expireReservationV2(userId, reservation.id)
    expect(outcome.outcome).toBe('not_due')
    const balance = await readBalance(ctx.pool, userId)
    expect(balance?.reserved).toBe(10)
  })

  it('reports not_found for an unknown reservation', async () => {
    const userId = newUserId()
    await seedBalance(ctx.pool, userId, { balance: 100 })
    const missing = crypto.randomUUID()

    expect((await repo.commitReservationV2(userId, missing)).outcome).toBe('not_found')
    expect((await repo.releaseReservationV2(userId, missing)).outcome).toBe('not_found')
    expect((await repo.expireReservationV2(userId, missing)).outcome).toBe('not_found')
  })

  it('sweeps only due reservations and counts each once', async () => {
    const userId = newUserId()
    await seedBalance(ctx.pool, userId, { balance: 1000 })
    const stale = await hold(userId, 10, -1_000)
    const live = await hold(userId, 20, 60_000)

    const result = await repo.findAndExpireReservations()
    expect(result.expiredCount).toBe(1)
    expect(result.creditsReleased).toBe(10)
    expect(result.errors).toEqual([])

    const { rows } = await ctx.pool.query(
      `SELECT id, status FROM credit_reservations WHERE user_id = $1 ORDER BY created_at`,
      [userId]
    )
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]))
    expect(byId[stale.id]).toBe('expired')
    expect(byId[live.id]).toBe('reserved')

    const balance = await readBalance(ctx.pool, userId)
    expect(balance?.reserved).toBe(20)
    expect(await countJournal(ctx.pool, userId, 'reservation_expired')).toBe(1)
  })
})
