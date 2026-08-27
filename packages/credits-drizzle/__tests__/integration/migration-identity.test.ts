/**
 * The migration verifies *identity*, not names.
 *
 * An index name proves nothing on its own, and neither does a column name. A
 * `varchar(20)` `idempotency_key` truncates the key that uniqueness is supposed
 * to be enforced on; a `DEFAULT now()` on `hold_placed_at` forges the
 * hold-origin fact for every row that never had a hold; a CHECK constraint
 * called `..._amount_positive` that permits zero reads as safety while
 * enforcing nothing. Each of those leaves a schema that passes a name-based
 * check and fails at runtime, in the direction that moves money.
 *
 * So the runner reads the catalog for every column, index and named constraint
 * it depends on, and refuses to report success over any of them being wrong.
 */

import { afterAll, afterEach, beforeAll, expect, it, describe } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import {
  CREDITS_V2_CONSTRAINTS_SQL,
  V2_COLUMNS,
  V2_INDEXES,
  readColumnState,
  runCreditsV2Migration,
} from '../../src/migrations/index.js'
import { LEGACY_BASE_SCHEMA_SQL } from '../helpers/legacy-schema.js'
import { describeIntegration, newUserId, TEST_DATABASE_URL } from '../helpers/database.js'

describeIntegration('migration identity (PostgreSQL)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 8 })
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

  const migrate = () => runCreditsV2Migration(drizzle(pool))

  describe('a healthy run', () => {
    it('verifies every column, index and constraint it depends on', async () => {
      await pool.query(LEGACY_BASE_SCHEMA_SQL)
      const report = await migrate()

      // Non-vacuous: the report names the objects, and the counts come from the
      // specs rather than from a literal that could drift away from them.
      expect(report.indexes.map((index) => index.name).sort()).toEqual(
        V2_INDEXES.map((index) => index.name).sort()
      )
      expect(report.indexes.every((index) => index.healthy && index.matchesSpec)).toBe(true)
      expect(report.columns.map((column) => `${column.table}.${column.column}`).sort()).toEqual(
        V2_COLUMNS.map((column) => `${column.table}.${column.column}`).sort()
      )
      expect(report.columns.every((column) => column.exists && column.matchesSpec)).toBe(true)

      // The `payment_ref` index is one of them: `addCreditsV2` inserts through
      // it, so a run that did not verify it would bless a schema where every
      // redelivery is a fresh credit.
      const paymentRef = report.indexes.find((index) => index.name.includes('payment_ref'))
      expect(paymentRef).toMatchObject({
        table: 'credit_plugin_transactions',
        keyColumns: ['payment_ref'],
        isUnique: true,
        healthy: true,
      })

      // Absent constraints are reported, not invented: the runner does not add
      // them, and says so rather than claiming they are enforced.
      expect(report.constraints.every((constraint) => constraint.exists === false)).toBe(true)
    })

    it('accepts the optional constraints once they are applied, exactly as written', async () => {
      await pool.query(LEGACY_BASE_SCHEMA_SQL)
      await migrate()
      for (const statement of CREDITS_V2_CONSTRAINTS_SQL) await pool.query(statement)

      const report = await migrate()
      expect(report.constraints.every((constraint) => constraint.exists)).toBe(true)
      expect(report.constraints.every((constraint) => constraint.matchesSpec)).toBe(true)
      // Added `NOT VALID`, so existing rows are unproven — reported honestly
      // rather than presented as a validated constraint.
      expect(report.constraints.every((constraint) => constraint.validated === false)).toBe(true)
    })
  })

  describe('column drift fails closed', () => {
    const DRIFT = [
      {
        label: 'a narrowed key column that would truncate the key',
        sql: `ALTER TABLE credit_reservations ALTER COLUMN idempotency_key TYPE varchar(20)`,
        mismatch: /type is character varying\(20\)/,
      },
      {
        label: 'a NOT NULL key column that rejects every legacy row',
        sql: `ALTER TABLE credit_journal_entries ALTER COLUMN idempotency_key SET NOT NULL`,
        mismatch: /NOT NULL/,
      },
      {
        label: 'a DEFAULT that forges the hold-origin fact',
        sql: `ALTER TABLE credit_reservations ALTER COLUMN hold_placed_at SET DEFAULT now()`,
        mismatch: /has DEFAULT now\(\)/,
      },
      {
        label: 'a payment_ref column of the wrong type',
        sql: `ALTER TABLE credit_plugin_transactions ALTER COLUMN payment_ref TYPE varchar(64)`,
        mismatch: /type is character varying\(64\)/,
      },
    ]

    for (const { label, sql, mismatch } of DRIFT) {
      it(`refuses ${label}`, async () => {
        await pool.query(LEGACY_BASE_SCHEMA_SQL)
        await migrate()
        await pool.query(sql)

        const error = await migrate().catch((e) => e)
        expect(error).toMatchObject({
          code: 'CONFIGURATION_ERROR',
          details: { reason: 'column_identity_mismatch' },
        })
        expect(String(error.message)).toMatch(mismatch)
      })
    }

    it('refuses a generated column, which no code path ever wrote', async () => {
      await pool.query(LEGACY_BASE_SCHEMA_SQL)
      await migrate()
      await pool.query(`ALTER TABLE credit_reservations DROP COLUMN hold_placed_at`)
      await pool.query(
        `ALTER TABLE credit_reservations
           ADD COLUMN hold_placed_at timestamptz GENERATED ALWAYS AS (created_at) STORED`
      )

      const error = await migrate().catch((e) => e)
      expect(error).toMatchObject({
        code: 'CONFIGURATION_ERROR',
        details: { reason: 'column_identity_mismatch' },
      })
      expect(String(error.message)).toMatch(/generated column/)
    })

    it('is not vacuous: the healthy schema passes the same check', async () => {
      await pool.query(LEGACY_BASE_SCHEMA_SQL)
      await migrate()
      const state = await readColumnState(drizzle(pool), {
        table: 'credit_reservations',
        column: 'hold_placed_at',
        type: 'timestamp with time zone',
        nullable: true,
      })
      expect(state).toMatchObject({ exists: true, matchesSpec: true, nullable: true })
      expect(state.mismatch).toBeUndefined()
    })
  })

  describe('constraint drift fails closed', () => {
    it('refuses a CHECK that carries our name while permitting zero', async () => {
      await pool.query(LEGACY_BASE_SCHEMA_SQL)
      await migrate()
      await pool.query(
        `ALTER TABLE credit_reservations
           ADD CONSTRAINT credit_reservations_amount_positive CHECK (amount >= 0) NOT VALID`
      )

      const error = await migrate().catch((e) => e)
      expect(error).toMatchObject({
        code: 'CONFIGURATION_ERROR',
        details: {
          reason: 'constraint_definition_mismatch',
          constraint: 'credit_reservations_amount_positive',
        },
      })
    })

    it('refuses a status CHECK that admits a status the code cannot read', async () => {
      await pool.query(LEGACY_BASE_SCHEMA_SQL)
      await migrate()
      await pool.query(
        `ALTER TABLE credit_reservations
           ADD CONSTRAINT credit_reservations_status_valid
           CHECK (status IN ('reserved', 'committed', 'released', 'expired', 'weird')) NOT VALID`
      )

      await expect(migrate()).rejects.toMatchObject({
        code: 'CONFIGURATION_ERROR',
        details: { reason: 'constraint_definition_mismatch' },
      })
    })
  })

  describe('the hold_placed_at backfill', () => {
    async function legacyRowsWithoutTheColumn() {
      await pool.query(LEGACY_BASE_SCHEMA_SQL)
      const userId = newUserId()
      await pool.query(
        `INSERT INTO credit_balances
           (user_id, balance, bonus_credits, reserved, tier, monthly_limit, monthly_used, monthly_reset_at)
         VALUES ($1, 500, 0, 30, 'free', 1000, 0, now() + interval '30 days')`,
        [userId]
      )
      for (let i = 0; i < 3; i += 1) {
        await pool.query(
          `INSERT INTO credit_reservations (user_id, amount, operation_type, status, expires_at, created_at)
           VALUES ($1, 10, 'story_generation', 'reserved', now() + interval '1 hour', now() - interval '2 days')`,
          [userId]
        )
      }
      return userId
    }

    it('grandfathers the rows that predate the column, from their own created_at', async () => {
      const userId = await legacyRowsWithoutTheColumn()
      await migrate()

      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM credit_reservations
         WHERE user_id = $1 AND hold_placed_at = created_at`,
        [userId]
      )
      // Without this, every reservation a deployment already holds becomes
      // untransitionable the moment the code ships.
      expect(rows[0].n).toBe(3)
    })

    it('runs once: a row that is NULL after the column exists stays NULL', async () => {
      const userId = await legacyRowsWithoutTheColumn()
      await migrate()

      // A row written *after* the migration with no hold behind it — which is
      // precisely what the guard exists to catch. A re-run must not bless it.
      await pool.query(
        `INSERT INTO credit_reservations (user_id, amount, operation_type, status, expires_at)
         VALUES ($1, 10, 'story_generation', 'reserved', now() + interval '1 hour')`,
        [userId]
      )
      await migrate()
      await migrate()

      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM credit_reservations
         WHERE user_id = $1 AND hold_placed_at IS NULL`,
        [userId]
      )
      expect(rows[0].n).toBe(1)
    })
  })
})
