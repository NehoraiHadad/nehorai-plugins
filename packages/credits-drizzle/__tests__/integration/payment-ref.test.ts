/**
 * `paymentRef` against real PostgreSQL: same three outcomes as the in-memory
 * adapter, decided by the unique index instead of by a read-then-write.
 *
 * The SQL side has the harder half of the contract. Two deliveries of the same
 * webhook can land on two connections at the same instant, and the old
 * implementation resolved that with `SELECT ... LIMIT 1` before crediting — so
 * both saw nothing, both credited, and the second insert either duplicated the
 * reference or aborted after the balance had already moved. The arbiter is now
 * `ON CONFLICT (payment_ref) DO NOTHING` on an insert that happens *before* the
 * balance changes.
 *
 * The in-memory parity of every case here lives in
 * `credits/__tests__/unit/payment-ref.test.ts`.
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

const PAYMENT_REF_INDEX = 'credit_plugin_transactions_payment_ref_unique'

describeIntegration('paymentRef (PostgreSQL)', () => {
  let ctx: TestDatabase
  let repo: DrizzleCreditRepository
  let alice: string
  let bob: string

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
    bob = newUserId()
    await seedBalance(ctx.pool, alice, { balance: 100 })
    await seedBalance(ctx.pool, bob, { balance: 100 })
  })

  async function stateOf(userId: string) {
    const balance = await readBalance(ctx.pool, userId)
    const transactions = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM credit_plugin_transactions WHERE user_id = $1`,
      [userId]
    )
    const journal = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM credit_journal_entries WHERE user_id = $1`,
      [userId]
    )
    return {
      balance: balance?.balance,
      bonus: balance?.bonus,
      transactions: transactions.rows[0].n as number,
      journal: journal.rows[0].n as number,
    }
  }

  it('credits once and reports what it created', async () => {
    const outcome = await repo.addCreditsV2({
      userId: alice,
      amount: 25,
      description: 'Purchase',
      paymentRef: 'pi_1',
    })

    expect(outcome.outcome).toBe('created')
    if (outcome.outcome !== 'created') throw new Error('unreachable')
    expect(outcome.paymentRef).toBe('pi_1')
    expect(outcome.transaction?.amount).toBe(25)
    expect(outcome.journalEntryId).toBeDefined()
    expect(await stateOf(alice)).toMatchObject({ bonus: 25, transactions: 1, journal: 1 })
  })

  it('replays an identical redelivery without a second credit', async () => {
    const input = { userId: alice, amount: 25, description: 'Purchase', paymentRef: 'pi_1' }
    await repo.addCreditsV2(input)
    const again = await repo.addCreditsV2({ ...input, description: 'regenerated copy' })

    expect(again.outcome).toBe('replayed')
    if (again.outcome !== 'replayed') throw new Error('unreachable')
    expect(again.transaction.amount).toBe(25)
    expect(await stateOf(alice)).toMatchObject({ bonus: 25, transactions: 1, journal: 1 })
  })

  describe('the same reference for a different event', () => {
    it('conflicts on the amount, and writes nothing', async () => {
      await repo.addCreditsV2({
        userId: alice,
        amount: 25,
        description: 'Purchase',
        paymentRef: 'pi_1',
      })
      const before = await stateOf(alice)

      const outcome = await repo.addCreditsV2({
        userId: alice,
        amount: 50,
        description: 'Purchase',
        paymentRef: 'pi_1',
      })

      expect(outcome.outcome).toBe('conflict')
      if (outcome.outcome !== 'conflict') throw new Error('unreachable')
      expect(outcome.mismatch).toBe('amount')
      expect(outcome.existing.amount).toBe(25)
      expect(await stateOf(alice)).toEqual(before)
    })

    it('conflicts across users, and credits neither', async () => {
      await repo.addCreditsV2({
        userId: alice,
        amount: 25,
        description: 'Purchase',
        paymentRef: 'pi_shared',
      })

      const outcome = await repo.addCreditsV2({
        userId: bob,
        amount: 25,
        description: 'Purchase',
        paymentRef: 'pi_shared',
      })

      expect(outcome.outcome).toBe('conflict')
      if (outcome.outcome !== 'conflict') throw new Error('unreachable')
      expect(outcome.mismatch).toBe('userId')
      expect(outcome.existing.userId).toBe(alice)
      expect(await stateOf(bob)).toMatchObject({ bonus: 0, transactions: 0, journal: 0 })
      expect(await stateOf(alice)).toMatchObject({ bonus: 25, transactions: 1 })
    })

    it('conflicts on the source, which lives on the journal entry', async () => {
      await repo.addCreditsV2({
        userId: alice,
        amount: 25,
        description: 'Purchase',
        paymentRef: 'pi_src',
      })

      const outcome = await repo.addCreditsV2({
        userId: alice,
        amount: 25,
        description: 'Purchase',
        paymentRef: 'pi_src',
        options: { source: 'admin_adjustment' },
      })

      expect(outcome.outcome).toBe('conflict')
      if (outcome.outcome !== 'conflict') throw new Error('unreachable')
      expect(outcome.mismatch).toBe('source')
    })

    it('throws through the legacy signature rather than reporting success', async () => {
      await repo.addCreditsAtomic(alice, 25, 'Purchase', 'pi_1')
      await expect(repo.addCreditsAtomic(bob, 25, 'Purchase', 'pi_1')).rejects.toMatchObject({
        code: CreditErrorCode.IDEMPOTENCY_CONFLICT,
        details: { paymentRef: 'pi_1', mismatch: 'userId' },
      })
      expect(await stateOf(bob)).toMatchObject({ bonus: 0, transactions: 0 })
    })
  })

  describe('a blank reference is not a reference', () => {
    for (const blank of ['', '   ']) {
      it(`credits every time for ${JSON.stringify(blank)}, and stores NULL`, async () => {
        await repo.addCreditsV2({
          userId: alice,
          amount: 10,
          description: 'Purchase',
          paymentRef: blank,
        })
        await repo.addCreditsV2({
          userId: alice,
          amount: 10,
          description: 'Purchase',
          paymentRef: blank,
        })

        expect(await stateOf(alice)).toMatchObject({ bonus: 20, transactions: 2 })
        const { rows } = await ctx.pool.query(
          `SELECT count(*)::int AS n FROM credit_plugin_transactions
           WHERE user_id = $1 AND payment_ref IS NULL`,
          [alice]
        )
        expect(rows[0].n).toBe(2)
      })
    }

    it('trims a padded reference to the same reference', async () => {
      const first = await repo.addCreditsV2({
        userId: alice,
        amount: 10,
        description: 'Purchase',
        paymentRef: '  pi_pad  ',
      })
      const second = await repo.addCreditsV2({
        userId: alice,
        amount: 10,
        description: 'Purchase',
        paymentRef: 'pi_pad',
      })

      expect(first.outcome).toBe('created')
      expect(second.outcome).toBe('replayed')
      expect(await stateOf(alice)).toMatchObject({ bonus: 10, transactions: 1 })
    })
  })

  describe('concurrent deliveries', () => {
    it('credits exactly once when eight identical calls race', async () => {
      const call = () =>
        repo.addCreditsV2({
          userId: alice,
          amount: 25,
          description: 'Purchase',
          paymentRef: 'pi_race',
        })

      const outcomes = await Promise.all(Array.from({ length: 8 }, call))

      expect(outcomes.filter((o) => o.outcome === 'created')).toHaveLength(1)
      expect(outcomes.filter((o) => o.outcome === 'replayed')).toHaveLength(7)
      expect(await stateOf(alice)).toMatchObject({ bonus: 25, transactions: 1, journal: 1 })
    })

    it('lets one user win a cross-user race and credits no one else', async () => {
      // No shared row lock here — the two callers touch different balance rows,
      // so the unique index is the only thing standing between them.
      const users = [alice, bob, newUserId(), newUserId()]
      for (const user of users.slice(2)) await seedBalance(ctx.pool, user, { balance: 100 })

      const outcomes = await Promise.all(
        users.map((userId) =>
          repo.addCreditsV2({
            userId,
            amount: 25,
            description: 'Purchase',
            paymentRef: 'pi_cross',
          })
        )
      )

      expect(outcomes.filter((o) => o.outcome === 'created')).toHaveLength(1)
      expect(outcomes.filter((o) => o.outcome === 'conflict')).toHaveLength(3)

      const { rows } = await ctx.pool.query(
        `SELECT count(*)::int AS n FROM credit_plugin_transactions WHERE payment_ref = 'pi_cross'`
      )
      expect(rows[0].n).toBe(1)
      const credited = await Promise.all(users.map((user) => stateOf(user)))
      expect(credited.filter((state) => state.bonus === 25)).toHaveLength(1)
      expect(credited.filter((state) => state.bonus === 0)).toHaveLength(3)
    })
  })

  describe('when the arbiter is missing', () => {
    it('refuses the credit instead of quietly duplicating the reference', async () => {
      // Deduplication that cannot be performed must be reported. Without the
      // index there is nothing to make the second delivery a replay, and
      // PostgreSQL says so: 42P10, no matching ON CONFLICT specification.
      await ctx.pool.query(`DROP INDEX ${PAYMENT_REF_INDEX}`)
      try {
        await expect(
          repo.addCreditsV2({
            userId: alice,
            amount: 25,
            description: 'Purchase',
            paymentRef: 'pi_noindex',
          })
        ).rejects.toThrow(/no unique or exclusion constraint/)

        expect(await stateOf(alice)).toMatchObject({ bonus: 0, transactions: 0, journal: 0 })

        // An unreferenced credit does not depend on the index and still works.
        const outcome = await repo.addCreditsV2({
          userId: alice,
          amount: 25,
          description: 'Purchase',
        })
        expect(outcome.outcome).toBe('created')
      } finally {
        await ctx.pool.query(
          `CREATE UNIQUE INDEX ${PAYMENT_REF_INDEX}
             ON credit_plugin_transactions (payment_ref)
             WHERE payment_ref IS NOT NULL`
        )
      }
    })
  })
})
