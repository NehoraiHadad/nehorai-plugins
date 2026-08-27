/**
 * Programmatic migration runner for the V2 indexes.
 *
 * `CREATE UNIQUE INDEX CONCURRENTLY` is not atomic. If the build fails — a
 * duplicate key, a cancelled statement, a backend crash — PostgreSQL leaves the
 * index row behind with `indisvalid = false`. That index is not enforcing
 * uniqueness, but it *does* occupy the name, so a later
 * `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS` sees the name, decides there
 * is nothing to do, and returns success. The migration then reports "applied"
 * while the constraint the V2 boundary depends on does not exist.
 *
 * So the plain SQL is not enough on its own: recovering needs a catalog read,
 * and a catalog read needs code. This runner is that code.
 */

import { sql } from 'drizzle-orm'
import { CreditError, CreditErrorCode } from '@nehorai/credits'
import type { DrizzleLikeDB } from '../repository/db.js'
import { CREDITS_V2_COLUMNS_SQL, V2_INDEXES, type V2IndexSpec } from './index.js'

/** What the catalog says about one target index. */
export interface IndexState {
  name: string
  exists: boolean
  /** True only when the index exists and is usable *and* enforcing. */
  healthy: boolean
  isValid?: boolean
  isReady?: boolean
  isLive?: boolean
  isUnique?: boolean
  /** The table the index is actually attached to — not assumed from the name. */
  table?: string
  definition?: string
}

export interface MigrationStep {
  statement: string
  action: 'column' | 'drop-invalid' | 'create-index' | 'skip'
  note?: string
}

export interface MigrationReport {
  steps: MigrationStep[]
  indexes: IndexState[]
  repaired: string[]
}

type Executor = (statement: string) => Promise<unknown>

/**
 * Read the catalog for one index by name.
 *
 * `indisvalid` alone is not enough. `indisready` says whether the index is
 * receiving new writes, `indislive` whether it is being dropped, and
 * `indisunique` whether it enforces anything at all — a build interrupted at
 * the wrong moment can leave any of them false.
 */
export async function readIndexState(db: DrizzleLikeDB, name: string): Promise<IndexState> {
  const rows = await rowsOf(
    db,
    sql`
      select i.indisvalid, i.indisready, i.indislive, i.indisunique,
             t.relname as table_name,
             pg_get_indexdef(c.oid) as definition
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_index i on i.indexrelid = c.oid
      join pg_catalog.pg_class t on t.oid = i.indrelid
      where c.relkind = 'i' and c.relname = ${name} and n.nspname = current_schema()
    `
  )

  const row = rows[0] as Record<string, unknown> | undefined
  if (!row) return { name, exists: false, healthy: false }

  const isValid = row.indisvalid === true
  const isReady = row.indisready === true
  const isLive = row.indislive === true
  const isUnique = row.indisunique === true
  return {
    name,
    exists: true,
    healthy: isValid && isReady && isLive && isUnique,
    isValid,
    isReady,
    isLive,
    isUnique,
    table: typeof row.table_name === 'string' ? row.table_name : undefined,
    definition: typeof row.definition === 'string' ? row.definition : undefined,
  }
}

/**
 * Does an existing index actually enforce what this spec asks for?
 *
 * An index name is unique per schema across *all* relations, so a healthy
 * unique index carrying the target name may well be attached to a different
 * table, or cover different columns. Trusting the name alone would let the
 * runner skip the build and then pass its own final verification while the
 * table the V2 boundary depends on is left unconstrained — the same silent-gap
 * failure the catalog check exists to prevent, one level up.
 */
function matchesSpec(state: IndexState, index: V2IndexSpec): boolean {
  if (state.table !== index.table) return false
  const definition = (state.definition ?? '').toLowerCase().replace(/\s+/g, ' ')
  return (
    definition.includes('(user_id, idempotency_key)') &&
    definition.includes('idempotency_key is not null')
  )
}

/** The name is taken by an index that is not the one we need. */
function wrongIndexError(state: IndexState, index: V2IndexSpec): CreditError {
  return new CreditError(
    `Index ${index.name} already exists but is not the index the V2 credit boundary needs ` +
      `(attached to ${state.table ?? 'unknown'}, expected ${index.table}). ` +
      'Rename or drop it before enabling V2 — this migration will not touch an index it does not own.',
    CreditErrorCode.CONFIGURATION_ERROR,
    { index: index.name, expectedTable: index.table, state }
  )
}

/**
 * Apply the V2 migration, repairing a half-built index if it finds one.
 *
 * Every statement runs on its own, outside any transaction block — both
 * `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` refuse to run
 * inside one. Pass a `db` that is *not* a transaction.
 *
 * @param options.concurrent - build without locking writes (default `true`).
 *   Set `false` for a small table or an empty database, where the brief
 *   exclusive lock is cheaper than the two-pass concurrent build.
 */
export async function runCreditsV2Migration(
  db: DrizzleLikeDB,
  options?: { concurrent?: boolean }
): Promise<MigrationReport> {
  const concurrent = options?.concurrent ?? true
  const exec = executor(db)
  const steps: MigrationStep[] = []
  const repaired: string[] = []

  for (const statement of CREDITS_V2_COLUMNS_SQL) {
    await exec(statement)
    steps.push({ statement, action: 'column' })
  }

  for (const index of V2_INDEXES) {
    const before = await readIndexState(db, index.name)

    if (before.exists && !matchesSpec(before, index)) throw wrongIndexError(before, index)

    if (before.exists && !before.healthy) {
      // Never try to "fix up" a half-built index — there is no command that
      // does. Drop it and build again from scratch.
      const drop = `DROP INDEX ${concurrent ? 'CONCURRENTLY ' : ''}IF EXISTS ${index.name}`
      await exec(drop)
      repaired.push(index.name)
      steps.push({
        statement: drop,
        action: 'drop-invalid',
        note: `indisvalid=${before.isValid} indisready=${before.isReady} indislive=${before.isLive}`,
      })
    } else if (before.healthy) {
      steps.push({ statement: `-- ${index.name}`, action: 'skip', note: 'already healthy' })
      continue
    }

    const create = concurrent ? index.concurrentSql : index.blockingSql
    try {
      await exec(create)
    } catch (error) {
      throw await explainFailedBuild(db, index, error)
    }
    steps.push({ statement: create, action: 'create-index' })
  }

  const indexes: IndexState[] = []
  for (const index of V2_INDEXES) {
    const state = await readIndexState(db, index.name)
    if (state.exists && !matchesSpec(state, index)) throw wrongIndexError(state, index)
    if (!state.healthy) {
      throw new CreditError(
        `Index ${index.name} is still not usable after migration ` +
          `(valid=${state.isValid} ready=${state.isReady} live=${state.isLive} unique=${state.isUnique}). ` +
          'The V2 credit boundary must not be enabled until it is.',
        CreditErrorCode.CONFIGURATION_ERROR,
        { index: index.name, state }
      )
    }
    indexes.push(state)
  }

  return { steps, indexes, repaired }
}

/**
 * Turn a failed unique-index build into an actionable error.
 *
 * The overwhelmingly likely cause is duplicate rows that predate the
 * constraint, and the only useful thing to tell an operator is *which* keys
 * collide — so go and read them.
 */
async function explainFailedBuild(
  db: DrizzleLikeDB,
  index: (typeof V2_INDEXES)[number],
  error: unknown
): Promise<CreditError> {
  let duplicates: unknown[] = []
  try {
    duplicates = await rowsOf(
      db,
      sql`
        select user_id, idempotency_key, count(*) as copies
        from ${sql.raw(index.table)}
        where idempotency_key is not null
        group by user_id, idempotency_key
        having count(*) > 1
        limit 20
      `
    )
  } catch {
    // The duplicate probe is a courtesy; the build failure is the real news.
  }

  return new CreditError(
    `Failed to build ${index.name}. ` +
      (duplicates.length
        ? `${duplicates.length} duplicate (user_id, idempotency_key) group(s) must be resolved first.`
        : 'See the underlying error for the cause.') +
      ' A failed concurrent build leaves an invalid index behind; re-running this ' +
      'migration drops and rebuilds it once the data is repaired.',
    CreditErrorCode.CONFIGURATION_ERROR,
    { index: index.name, duplicates, cause: String(error) }
  )
}

function executor(db: DrizzleLikeDB): Executor {
  if (typeof db.execute !== 'function') {
    throw new CreditError(
      'The migration runner needs a database handle that can execute raw SQL.',
      CreditErrorCode.UNSUPPORTED_OPERATION,
      { reason: 'missing_execute' }
    )
  }
  return (statement: string) => db.execute!(sql.raw(statement))
}

/** Drivers disagree on whether `execute` returns rows or `{ rows }`. */
async function rowsOf(db: DrizzleLikeDB, statement: unknown): Promise<unknown[]> {
  if (typeof db.execute !== 'function') return []
  const result = (await db.execute(statement)) as unknown
  if (Array.isArray(result)) return result
  const rows = (result as { rows?: unknown }).rows
  return Array.isArray(rows) ? rows : []
}
