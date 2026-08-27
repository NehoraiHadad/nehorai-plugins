import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { DrizzleCreditRepository } from '../../src/repository/index.js'
import {
  CREDITS_V2_COLUMNS_SQL,
  CREDITS_V2_CONSTRAINTS_SQL,
  CREDITS_V2_INDEXES_SQL,
  CREDITS_V2_MIGRATION_SQL,
} from '../../src/migrations/index.js'
import { LEGACY_BASE_SCHEMA_SQL } from '../helpers/legacy-schema.js'
import { describeIntegration, newUserId, TEST_DATABASE_URL } from '../helpers/database.js'

describeIntegration('V2 migration (PostgreSQL)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 24 })
  })
  afterAll(async () => {
    await dropAll()
    await pool.end()
  })
  afterEach(async () => {
    await dropAll()
  })

  async function dropAll() {
    await pool.query(`DROP TABLE IF EXISTS
      credit_balances, credit_reservations, credit_plugin_transactions,
      credit_usage_logs, credit_journal_entries CASCADE`)
  }

  async function legacySchemaWithRows() {
    await pool.query(LEGACY_BASE_SCHEMA_SQL)
    const userId = newUserId()
    await pool.query(
      `INSERT INTO credit_balances (user_id, balance, bonus_credits, reserved, tier, monthly_limit, monthly_used, monthly_reset_at)
       VALUES ($1, 500, 0, 0, 'free', 1000, 0, now() + interval '30 days')`,
      [userId]
    )
    // Pre-existing rows, all with no idempotency key — the case the partial
    // index has to tolerate.
    for (let i = 0; i < 5; i += 1) {
      await pool.query(
        `INSERT INTO credit_reservations (user_id, amount, operation_type, status, expires_at)
         VALUES ($1, 5, 'story_generation', 'committed', now())`,
        [userId]
      )
      await pool.query(
        `INSERT INTO credit_journal_entries
           (user_id, entry_type, amount, balance_after, source, reference_id, reference_type, description)
         VALUES ($1, 'debit', 5, 495, 'operation_commit', 'legacy', 'reservation', 'legacy entry')`,
        [userId]
      )
    }
    return userId
  }

  async function applyMigration(statements: readonly string[] = CREDITS_V2_MIGRATION_SQL) {
    for (const statement of statements) await pool.query(statement)
  }

  it('applies cleanly over a populated legacy schema, and is re-runnable', async () => {
    await legacySchemaWithRows()

    await applyMigration()
    // Running the same migration twice must be a no-op, not an error.
    await applyMigration()
    await applyMigration(CREDITS_V2_CONSTRAINTS_SQL)
    await applyMigration(CREDITS_V2_CONSTRAINTS_SQL)

    const { rows } = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN ('credit_reservations_idempotency_key_unique',
                          'credit_journal_entries_idempotency_key_unique')`)
    expect(rows).toHaveLength(2)

    // No index left behind in an invalid state by a failed concurrent build.
    const invalid = await pool.query(`
      SELECT c.relname FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE NOT i.indisvalid AND c.relname LIKE '%idempotency_key_unique'`)
    expect(invalid.rows).toEqual([])
  })

  it('leaves legacy NULL-key rows unconstrained', async () => {
    const userId = await legacySchemaWithRows()
    await applyMigration()

    // The index is partial, so any number of NULL-key rows stays legal.
    for (let i = 0; i < 10; i += 1) {
      await pool.query(
        `INSERT INTO credit_reservations (user_id, amount, operation_type, status, expires_at)
         VALUES ($1, 5, 'story_generation', 'reserved', now() + interval '1 hour')`,
        [userId]
      )
    }
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM credit_reservations WHERE user_id = $1 AND idempotency_key IS NULL`,
      [userId]
    )
    expect(rows[0].n).toBe(15)
  })

  it('rejects a duplicate key for one user but allows it across users', async () => {
    await legacySchemaWithRows()
    await applyMigration()

    const alice = newUserId()
    const bob = newUserId()
    const insert = (userId: string) =>
      pool.query(
        `INSERT INTO credit_reservations (user_id, amount, operation_type, status, expires_at, idempotency_key)
         VALUES ($1, 5, 'story_generation', 'reserved', now() + interval '1 hour', 'k1')`,
        [userId]
      )

    await insert(alice)
    await insert(bob)
    await expect(insert(alice)).rejects.toMatchObject({ code: '23505' })
  })

  it('fails loudly if the app runs V2 before the indexes exist', async () => {
    // A deployment that ships the code but forgets the migration must break on
    // the first idempotent reserve, not silently place duplicate holds.
    await pool.query(LEGACY_BASE_SCHEMA_SQL)
    for (const statement of CREDITS_V2_COLUMNS_SQL) await pool.query(statement)

    const userId = newUserId()
    await pool.query(
      `INSERT INTO credit_balances (user_id, balance, bonus_credits, reserved, tier, monthly_limit, monthly_used, monthly_reset_at)
       VALUES ($1, 500, 0, 0, 'free', 1000, 0, now() + interval '30 days')`,
      [userId]
    )

    const repo = new DrizzleCreditRepository(drizzle(pool))
    await expect(
      repo.reserveCreditsV2({
        userId,
        amount: 10,
        operationType: 'story_generation',
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: 'k1',
      })
    ).rejects.toThrow(/no unique or exclusion constraint/)

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM credit_reservations WHERE user_id = $1`,
      [userId]
    )
    expect(rows[0].n).toBe(0)

    // After the indexes land, the same call succeeds.
    for (const statement of CREDITS_V2_INDEXES_SQL) await pool.query(statement)
    const outcome = await repo.reserveCreditsV2({
      userId,
      amount: 10,
      operationType: 'story_generation',
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: 'k1',
    })
    expect(outcome.outcome).toBe('created')
  })
})
