import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { DrizzleCreditRepository } from '../../src/repository/index.js'
import {
  countReservations,
  describeIntegration,
  newUserId,
  readBalance,
  seedBalance,
  setupDatabase,
  teardownDatabase,
  truncateAll,
  type TestDatabase,
} from '../helpers/database.js'

describeIntegration('reserveCreditsV2 (PostgreSQL)', () => {
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

  const expiresAt = () => new Date(Date.now() + 60_000)

  it('places exactly one hold for 50 concurrent reserves sharing an idempotency key', async () => {
    const userId = newUserId()
    await seedBalance(ctx.pool, userId, { balance: 1000 })

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () =>
        repo.reserveCreditsV2({
          userId,
          amount: 10,
          operationType: 'story_generation',
          expiresAt: expiresAt(),
          idempotencyKey: 'job-42',
        })
      )
    )

    const created = outcomes.filter((o) => o.outcome === 'created')
    const replayed = outcomes.filter((o) => o.outcome === 'replayed')
    expect(created).toHaveLength(1)
    expect(replayed).toHaveLength(49)

    // Every caller must be handed the same reservation id.
    const ids = new Set(
      outcomes.flatMap((o) => (o.outcome === 'created' || o.outcome === 'replayed' ? [o.reservation.id] : []))
    )
    expect(ids.size).toBe(1)

    expect(await countReservations(ctx.pool, userId)).toBe(1)
    const balance = await readBalance(ctx.pool, userId)
    expect(balance).toMatchObject({ balance: 1000, reserved: 10 })
  })

  it('lets competing keys race for limited funds without over-reserving', async () => {
    const userId = newUserId()
    // Room for exactly 4 holds of 25.
    await seedBalance(ctx.pool, userId, { balance: 100 })

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        repo.reserveCreditsV2({
          userId,
          amount: 25,
          operationType: 'story_generation',
          expiresAt: expiresAt(),
          idempotencyKey: `job-${i}`,
        })
      )
    )

    const created = outcomes.filter((o) => o.outcome === 'created')
    const insufficient = outcomes.filter((o) => o.outcome === 'insufficient')
    expect(created).toHaveLength(4)
    expect(insufficient).toHaveLength(16)

    const balance = await readBalance(ctx.pool, userId)
    expect(balance).toMatchObject({ balance: 100, reserved: 100 })
    // A failed attempt must leave no reservation row behind, or replaying its
    // key would be permanently poisoned.
    expect(await countReservations(ctx.pool, userId)).toBe(4)
  })

  it('reports a conflict when a key is reused with a different payload', async () => {
    const userId = newUserId()
    await seedBalance(ctx.pool, userId, { balance: 1000 })

    const first = await repo.reserveCreditsV2({
      userId,
      amount: 10,
      operationType: 'story_generation',
      expiresAt: expiresAt(),
      idempotencyKey: 'job-1',
    })
    expect(first.outcome).toBe('created')

    const conflict = await repo.reserveCreditsV2({
      userId,
      amount: 25,
      operationType: 'story_generation',
      expiresAt: expiresAt(),
      idempotencyKey: 'job-1',
    })
    expect(conflict.outcome).toBe('idempotency_conflict')

    // No second hold was taken.
    const balance = await readBalance(ctx.pool, userId)
    expect(balance?.reserved).toBe(10)
  })

  it('scopes idempotency keys per user', async () => {
    const alice = newUserId()
    const bob = newUserId()
    await seedBalance(ctx.pool, alice, { balance: 100 })
    await seedBalance(ctx.pool, bob, { balance: 100 })

    const a = await repo.reserveCreditsV2({
      userId: alice,
      amount: 10,
      operationType: 'story_generation',
      expiresAt: expiresAt(),
      idempotencyKey: 'shared-key',
    })
    const b = await repo.reserveCreditsV2({
      userId: bob,
      amount: 10,
      operationType: 'story_generation',
      expiresAt: expiresAt(),
      idempotencyKey: 'shared-key',
    })

    expect(a.outcome).toBe('created')
    expect(b.outcome).toBe('created')
  })

  it('still allows unlimited legacy reserves with no key', async () => {
    const userId = newUserId()
    await seedBalance(ctx.pool, userId, { balance: 100 })

    for (let i = 0; i < 3; i += 1) {
      const outcome = await repo.reserveCreditsV2({
        userId,
        amount: 10,
        operationType: 'story_generation',
        expiresAt: expiresAt(),
      })
      expect(outcome.outcome).toBe('created')
    }
    expect(await countReservations(ctx.pool, userId)).toBe(3)
  })
})
