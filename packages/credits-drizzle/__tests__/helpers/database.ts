import { drizzle } from 'drizzle-orm/node-postgres'
import { describe } from 'vitest'
import pg from 'pg'
import { runCreditsV2Migration } from '../../src/migrations/runner.js'
import { LEGACY_BASE_SCHEMA_SQL } from './legacy-schema.js'

/**
 * Connection string for the disposable integration database.
 *
 * Unset means "no database available" and every integration suite skips, so a
 * checkout without PostgreSQL still runs the fast tests green.
 */
export const TEST_DATABASE_URL = process.env.CREDITS_TEST_DATABASE_URL

export const describeIntegration: typeof describe = TEST_DATABASE_URL
  ? describe
  : describe.skip

/**
 * Build the schema the way a real upgrade does: create the *pre-V2* tables,
 * then apply the published migration on top.
 *
 * Creating the current schema directly would prove nothing about existing
 * deployments — this way the migration itself is under test, against a table
 * whose rows all have a NULL idempotency key.
 */
export async function setupDatabase(): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error('CREDITS_TEST_DATABASE_URL is not set')

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 24 })
  const db = drizzle(pool)

  await pool.query(LEGACY_BASE_SCHEMA_SQL)
  // Use the shipped runner rather than raw SQL: it is the supported path, and
  // it repairs an index left invalid by an earlier crashed run instead of
  // skipping it and pretending the constraint exists.
  await runCreditsV2Migration(db)

  return { pool, db }
}

export interface TestDatabase {
  pool: pg.Pool
  db: ReturnType<typeof drizzle>
}

/** Wipe all credit tables between tests without dropping the schema. */
export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(`TRUNCATE
    credit_balances,
    credit_reservations,
    credit_plugin_transactions,
    credit_usage_logs,
    credit_journal_entries
    RESTART IDENTITY CASCADE`)
}

/** Drop everything this suite created, so the database is reusable. */
export async function teardownDatabase({ pool }: TestDatabase): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS
    credit_balances,
    credit_reservations,
    credit_plugin_transactions,
    credit_usage_logs,
    credit_journal_entries
    CASCADE`)
  await pool.end()
}

/** Seed a balance row directly, bypassing tier config. */
export async function seedBalance(
  pool: pg.Pool,
  userId: string,
  values: { balance?: number; bonusCredits?: number; reserved?: number } = {}
): Promise<void> {
  await pool.query(
    `INSERT INTO credit_balances
       (user_id, balance, bonus_credits, reserved, tier, monthly_limit, monthly_used, monthly_reset_at)
     VALUES ($1, $2, $3, $4, 'free', 1000, 0, now() + interval '30 days')`,
    [userId, values.balance ?? 0, values.bonusCredits ?? 0, values.reserved ?? 0]
  )
}

export async function readBalance(pool: pg.Pool, userId: string) {
  const { rows } = await pool.query(
    `SELECT balance::float8 AS balance,
            bonus_credits::float8 AS bonus,
            reserved::float8 AS reserved,
            monthly_used::float8 AS monthly_used
     FROM credit_balances WHERE user_id = $1`,
    [userId]
  )
  return rows[0] as
    | { balance: number; bonus: number; reserved: number; monthly_used: number }
    | undefined
}

export async function countJournal(
  pool: pg.Pool,
  userId: string,
  source?: string
): Promise<number> {
  const { rows } = source
    ? await pool.query(
        `SELECT count(*)::int AS n FROM credit_journal_entries WHERE user_id = $1 AND source = $2`,
        [userId, source]
      )
    : await pool.query(
        `SELECT count(*)::int AS n FROM credit_journal_entries WHERE user_id = $1`,
        [userId]
      )
  return rows[0].n as number
}

export async function countReservations(pool: pg.Pool, userId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM credit_reservations WHERE user_id = $1`,
    [userId]
  )
  return rows[0].n as number
}

/** A fresh uuid for each test's user, so tests never share a balance row. */
export function newUserId(): string {
  return crypto.randomUUID()
}
