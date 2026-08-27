/**
 * Two things the migration runner has to get right against a real catalog.
 *
 * **Identity.** An index name is unique per schema across every relation, so a
 * healthy `UNIQUE INDEX ... (id)` can occupy the name the boundary wants. A
 * runner that matches on the name — or on a substring of `pg_get_indexdef` —
 * skips the build and then passes its own final check, over a table that
 * enforces nothing. Each case below plants a *plausible* wrong index and
 * expects a refusal, with the planted index still there afterwards.
 *
 * **Concurrency.** Two runners starting together used to produce one success
 * and one raw SQLSTATE 40P01. Nothing in a deploy is going to catch a raw
 * deadlock and do the right thing with it.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import {
  CREDITS_V2_COLUMNS_SQL,
  readIndexState,
  runCreditsV2Migration,
} from '../../src/migrations/index.js'
import { LEGACY_BASE_SCHEMA_SQL } from '../helpers/legacy-schema.js'
import { describeIntegration, TEST_DATABASE_URL } from '../helpers/database.js'

const TARGET = 'credit_reservations_idempotency_key_unique'

describeIntegration('migration safety (PostgreSQL)', () => {
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

  /** Legacy tables plus the V2 columns, but no V2 indexes yet. */
  async function schemaWithColumns() {
    await pool.query(LEGACY_BASE_SCHEMA_SQL)
    for (const statement of CREDITS_V2_COLUMNS_SQL) await pool.query(statement)
  }

  async function countIndexes(name: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM pg_catalog.pg_class WHERE relkind = 'i' AND relname = $1`,
      [name]
    )
    return rows[0].n as number
  }

  /** Leave a correctly shaped but unusable index behind, as a dead build does. */
  async function strandInvalidIndex() {
    await pool.query(
      `INSERT INTO credit_reservations
         (user_id, amount, operation_type, status, expires_at, idempotency_key)
       VALUES ($1, 1, 'story_generation', 'reserved', now(), 'dupe'),
              ($1, 1, 'story_generation', 'reserved', now(), 'dupe')`,
      [crypto.randomUUID()]
    )
    await runCreditsV2Migration(drizzle(pool), { concurrent: true }).catch(() => undefined)
    await pool.query(`DELETE FROM credit_reservations`)
    const state = await readIndexState(drizzle(pool), TARGET, 'credit_reservations')
    if (state.healthy) throw new Error('setup failed to strand an invalid index')
  }

  // ==================== identity ====================

  /**
   * Each of these is healthy, valid, and wrong. The reviewer that reproduced
   * this blocker used the first one — a unique index on `(id)` — and the old
   * runner accepted it.
   */
  const IMPOSTORS: Array<[string, string]> = [
    ['a unique index on (id)', `CREATE UNIQUE INDEX ${TARGET} ON credit_reservations (id)`],
    [
      'the right columns on the wrong table',
      `CREATE UNIQUE INDEX ${TARGET} ON credit_journal_entries (user_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL`,
    ],
    [
      'the right columns in the wrong order',
      `CREATE UNIQUE INDEX ${TARGET} ON credit_reservations (idempotency_key, user_id)
         WHERE idempotency_key IS NOT NULL`,
    ],
    [
      'the right columns but not unique',
      `CREATE INDEX ${TARGET} ON credit_reservations (user_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL`,
    ],
    [
      'the right columns with no predicate',
      `CREATE UNIQUE INDEX ${TARGET} ON credit_reservations (user_id, idempotency_key)`,
    ],
    [
      'a predicate that constrains the wrong rows',
      `CREATE UNIQUE INDEX ${TARGET} ON credit_reservations (user_id, idempotency_key)
         WHERE status = 'reserved'`,
    ],
    [
      'an extra INCLUDE column',
      `CREATE UNIQUE INDEX ${TARGET} ON credit_reservations (user_id, idempotency_key)
         INCLUDE (status) WHERE idempotency_key IS NOT NULL`,
    ],
    [
      'a lower() expression instead of the column',
      `CREATE UNIQUE INDEX ${TARGET} ON credit_reservations (user_id, lower(idempotency_key))
         WHERE idempotency_key IS NOT NULL`,
    ],
  ]

  for (const [label, ddl] of IMPOSTORS) {
    it(`refuses ${label}, and leaves it alone`, async () => {
      await schemaWithColumns()
      await pool.query(ddl)

      const error = await runCreditsV2Migration(drizzle(pool)).catch((e) => e)
      expect(error.code, `${label} was accepted`).toBe('CONFIGURATION_ERROR')
      expect(error.details?.mismatch).toBeTruthy()

      // Refusing must not mean destroying: the index we did not recognise is
      // somebody else's, and it is still here.
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_class WHERE relkind = 'i' AND relname = $1`,
        [TARGET]
      )
      expect(rows[0].n).toBe(1)
    })
  }

  it('accepts the index it actually asked for', async () => {
    await schemaWithColumns()
    await pool.query(
      `CREATE UNIQUE INDEX ${TARGET} ON credit_reservations (user_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL`
    )

    const report = await runCreditsV2Migration(drizzle(pool))
    const skipped = report.steps.filter((step) => step.action === 'skip')
    expect(skipped.map((step) => step.statement)).toContain(`-- ${TARGET}`)

    const state = await readIndexState(drizzle(pool), TARGET)
    expect(state).toMatchObject({
      healthy: true,
      matchesSpec: true,
      table: 'credit_reservations',
      keyColumns: ['user_id', 'idempotency_key'],
      totalAttributes: 2,
      accessMethod: 'btree',
      isUnique: true,
    })
  })

  // ==================== concurrency ====================

  it('lets six simultaneous runners all finish', async () => {
    await pool.query(LEGACY_BASE_SCHEMA_SQL)

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => runCreditsV2Migration(drizzle(pool)))
    )

    const rejected = results.filter((r) => r.status === 'rejected')
    expect(
      rejected.map((r) => (r as PromiseRejectedResult).reason?.message ?? String(r)),
      'no runner may see a raw deadlock'
    ).toEqual([])

    // Exactly one of them did the work; the rest found it already done.
    const built = results.filter(
      (r) =>
        r.status === 'fulfilled' &&
        r.value.steps.some((step) => step.action === 'create-index')
    )
    expect(built).toHaveLength(1)
    for (const result of results) {
      expect(result.status === 'fulfilled' && result.value.serialized).toBe(true)
    }

    for (const name of [TARGET, 'credit_journal_entries_idempotency_key_unique']) {
      expect(await readIndexState(drizzle(pool), name)).toMatchObject({
        healthy: true,
        matchesSpec: true,
        keyColumns: ['user_id', 'idempotency_key'],
      })
    }
  })

  /**
   * A deploy step that catches an error off this runner has to be able to tell
   * "retry me" from "fix your schema". A raw driver error carrying SQLSTATE
   * 42P01 and nothing else tells it neither, so nothing leaves unclassified —
   * not the DDL, not the catalog reads, not opening the transaction.
   */
  it('classifies a missing base table instead of leaking a raw SQLSTATE', async () => {
    await dropAll()

    const error = await runCreditsV2Migration(drizzle(pool)).catch((e) => e)
    expect(error.name, 'a raw driver error escaped').toBe('CreditError')
    expect(error.code).toBe('DATABASE_ERROR')
    expect(error.details?.migration).toBe('credits_v2')
  })

  it('classifies a missing base table on the concurrent path too', async () => {
    await dropAll()

    const error = await runCreditsV2Migration(drizzle(pool), { concurrent: true }).catch((e) => e)
    expect(error.name).toBe('CreditError')
    expect(error.code).toBe('DATABASE_ERROR')
  })

  /**
   * The runner's docs tell operators not to rename indexes during a migration,
   * because the read-then-drop window cannot be closed from SQL. An earlier fix
   * claimed an `ACCESS EXCLUSIVE` lock on the parent tables closed it. It does
   * not, and this pins the reason: `ALTER INDEX ... RENAME` locks the index
   * relation, not the heap. If a future PostgreSQL changes that, this fails and
   * the documented precondition can be revisited.
   */
  it('confirms a heap lock does not block ALTER INDEX RENAME', async () => {
    await pool.query(LEGACY_BASE_SCHEMA_SQL)
    await runCreditsV2Migration(drizzle(pool))

    const holder = await pool.connect()
    const renamer = await pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('LOCK TABLE credit_reservations IN ACCESS EXCLUSIVE MODE')

      await renamer.query("SET lock_timeout = '2s'")
      const renamed = await renamer
        .query(`ALTER INDEX ${TARGET} RENAME TO ${TARGET}_moved`)
        .then(() => true)
        .catch(() => false)

      expect(renamed, 'the heap lock now blocks renames — revisit the docs').toBe(true)
      await renamer.query(`ALTER INDEX ${TARGET}_moved RENAME TO ${TARGET}`)
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      holder.release()
      renamer.release()
    }
  })

  /**
   * The runner used to repair an unusable index by dropping it. That is a
   * read-then-drop by name, and `DROP INDEX` re-resolves the name when it runs
   * — so a session that renames the inspected index away and renames an
   * unrelated one into the freed name redirects the drop onto somebody else's
   * index. This proves the runner no longer has a path that can do that.
   */
  it('refuses an unusable index instead of dropping it', async () => {
    await schemaWithColumns()
    await strandInvalidIndex()

    const error = await runCreditsV2Migration(drizzle(pool)).catch((e) => e)
    expect(error.code).toBe('CONFIGURATION_ERROR')
    expect(error.details?.reason).toBe('invalid_index_needs_operator_repair')
    expect(error.details?.hint).toContain(`DROP INDEX ${TARGET}`)

    // Still there: refusing means leaving it for the operator, not removing it.
    expect(await countIndexes(TARGET)).toBe(1)
  })

  /**
   * Note what this does and does not prove. Performing the swap up front means
   * the runner inspects the *bystander* and refuses it on identity, so this
   * passes even against the old dropping code — it is coverage for the
   * wrong-identity guard, not for the removal of the drop. The real race window
   * is between inspection and execution and cannot be hit deterministically
   * from SQL. The property that closes it is structural, and the test below
   * asserts that structure directly.
   */
  it('leaves an unrelated index alone when one occupies the target name', async () => {
    await schemaWithColumns()
    await strandInvalidIndex()

    // The swap the old repair path was vulnerable to, performed before the
    // runner starts so the outcome does not depend on winning a race.
    await pool.query(`ALTER INDEX ${TARGET} RENAME TO ${TARGET}_stranded`)
    await pool.query(`CREATE UNIQUE INDEX bystander ON credit_usage_logs (id)`)
    await pool.query(`ALTER INDEX bystander RENAME TO ${TARGET}`)

    await runCreditsV2Migration(drizzle(pool)).catch((e) => e)

    // The bystander is intact, whatever the runner decided about the name.
    const { rows } = await pool.query(
      `SELECT i.indrelid::regclass::text AS tbl
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = $1`,
      [TARGET]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].tbl, 'the runner destroyed an index it did not own').toBe(
      'credit_usage_logs'
    )
  })

  /**
   * The guarantee is that the runner never issues a drop, so the window between
   * inspecting a name and executing `DROP INDEX <name>` is never opened. The
   * race itself cannot be scheduled from SQL, so instead of trying to win it,
   * record every statement the runner actually sends while it is looking at an
   * index it would previously have dropped, and assert none of them is a drop.
   */
  it('sends no DROP statement, even facing an index it would once have repaired', async () => {
    await schemaWithColumns()
    await strandInvalidIndex()

    const sent: string[] = []
    const record = (config: unknown) => {
      const text = typeof config === 'string' ? config : (config as { text?: string })?.text
      if (text) sent.push(text)
    }
    // The serialized path runs inside `db.transaction()`, which pins a client
    // from `connect()` and issues everything on it — so wrapping `query` alone
    // would miss precisely the statements this test is about.
    const recording = {
      end: pool.end.bind(pool),
      query: (config: unknown, values?: unknown) => {
        record(config)
        return (pool.query as (c: unknown, v?: unknown) => Promise<unknown>)(config, values)
      },
      connect: async () => {
        const client = await pool.connect()
        const query = client.query.bind(client)
        ;(client as { query: unknown }).query = (config: unknown, values?: unknown) => {
          record(config)
          return (query as (c: unknown, v?: unknown) => Promise<unknown>)(config, values)
        }
        return client
      },
    }

    await runCreditsV2Migration(drizzle(recording as unknown as pg.Pool)).catch(() => undefined)

    expect(sent.length, 'nothing was recorded — the spy did not work').toBeGreaterThan(0)
    // A destructive statement, not the substring "drop": the catalog reads
    // legitimately mention `attisdropped`, and a filter that trips on those
    // passes for the wrong reason and would keep passing if the runner started
    // dropping. Proven below to still catch a real one.
    const isDrop = (text: string) => /\bdrop\s+(index|table|column|constraint|schema)\b/i.test(text)
    expect(
      isDrop(`DROP INDEX ${TARGET}`),
      'the detector cannot see a drop, so its silence means nothing'
    ).toBe(true)
    expect(sent.filter(isDrop), 'the runner issued a drop').toEqual([])

    // And the index it refused is still there.
    expect(await countIndexes(TARGET)).toBe(1)
  })

  it('enforces uniqueness once the concurrent runners are done', async () => {
    await pool.query(LEGACY_BASE_SCHEMA_SQL)
    await Promise.all(Array.from({ length: 4 }, () => runCreditsV2Migration(drizzle(pool))))

    const userId = crypto.randomUUID()
    const insert = () =>
      pool.query(
        `INSERT INTO credit_reservations (user_id, amount, operation_type, status, expires_at, idempotency_key)
         VALUES ($1, 1, 'story_generation', 'reserved', now(), 'same-key')`,
        [userId]
      )
    await insert()
    await expect(insert()).rejects.toMatchObject({ code: '23505' })
  })
})
