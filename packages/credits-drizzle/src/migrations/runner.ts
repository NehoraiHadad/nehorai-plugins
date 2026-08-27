/**
 * Programmatic migration runner for the V2 columns and indexes.
 *
 * Two problems make the raw SQL insufficient on its own.
 *
 * `CREATE UNIQUE INDEX CONCURRENTLY` is not atomic: if the build fails —
 * duplicate key, cancelled statement, backend crash — PostgreSQL leaves the
 * index row behind with `indisvalid = false`. It enforces nothing, but it *does*
 * occupy the name, so a later `IF NOT EXISTS` sees the name and reports success
 * over a constraint that does not exist. Recovering needs a catalog read, and a
 * catalog read needs code.
 *
 * And two runners starting at once deadlock. `ALTER TABLE` and `CREATE INDEX`
 * take conflicting locks on two tables in sequence, so a plain re-run raced
 * against itself surfaces a raw SQLSTATE 40P01 to one of the callers.
 *
 * The fix for the second is to serialise: the default path runs the whole
 * migration inside one transaction that first takes a transaction-scoped
 * advisory lock. `db.transaction()` pins a single physical connection, which is
 * what makes the lock meaningful on a pool — a *session* advisory lock taken
 * outside a transaction would be released on whichever connection the pool
 * happened to hand back. Concurrent runners queue on the lock; the loser wakes
 * up, reads the catalog, finds the exact index it wanted, and reports `skip`.
 *
 * Pass a **root database handle**. Handing this an already-open transaction
 * works, but the advisory lock is then held until the caller's outer
 * transaction commits, and if that transaction already holds conflicting table
 * locks the two lock orders can still deadlock. That failure is classified as
 * `TRANSIENT_ERROR` rather than surfacing raw, but the way to not have it is to
 * give the runner its own connection.
 *
 * Everything is resolved through `search_path`, exactly as the DDL is: the
 * runner migrates the schema the connection points at, and verifies the indexes
 * in that same schema. It does not know or check which schema you *meant*.
 *
 * Why it never repairs an unusable index: see `invalidIndexError` in
 * `./errors.js`. In short, `DROP INDEX` re-resolves the name at execution time,
 * so no drop this runner could issue provably targets the relation it
 * inspected. It stops and names what an operator should drop instead.
 *
 * The serialized path cannot use `CONCURRENTLY` (which refuses to run inside a
 * transaction block), so it takes a brief write lock on the affected tables.
 * See {@link runCreditsV2Migration} for the non-blocking alternative and the
 * contract it asks of the operator instead.
 */

import { sql } from 'drizzle-orm'
import { CreditError, CreditErrorCode, classifyDatabaseError } from '@nehorai/credits'
import { assertTransactional, type DrizzleLikeDB } from '../repository/db.js'
import { CREDITS_V2_COLUMNS_SQL } from './statements.js'
import { V2_INDEXES, type V2IndexSpec } from './specs.js'
import { readIndexState, type IndexState } from './catalog.js'
import type { ColumnState, ConstraintState } from './columns.js'
import { explainFailedBuild, invalidIndexError, wrongIndexError } from './errors.js'
import { verifyColumns, verifyConstraints, verifyIndexes } from './verify.js'

export type { IndexState }

/**
 * Advisory lock key for the V2 migration.
 *
 * Arbitrary but fixed: any two runners must pick the same number, and nothing
 * else in the application should pick this one.
 */
const MIGRATION_LOCK_KEY = 8_531_207_461_002_193n

export interface MigrationStep {
  statement: string
  action: 'lock' | 'column' | 'create-index' | 'skip'
  note?: string
}

export interface MigrationReport {
  steps: MigrationStep[]
  indexes: IndexState[]
  /** Verified identity of every column the boundary writes to. */
  columns: ColumnState[]
  /**
   * The optional CHECK constraints, as found. Absent ones are reported, not
   * added; one that exists under our name saying something else stops the run.
   */
  constraints: ConstraintState[]
  /**
   * Always empty.
   *
   * The runner used to drop and rebuild an unusable index and list it here. It
   * no longer repairs anything by itself — see `invalidIndexError` — and the
   * field is kept only so existing readers do not break.
   *
   * @deprecated The runner never repairs; this is always `[]`.
   */
  repaired: string[]
  /** False when the caller opted out of the advisory lock for a concurrent build. */
  serialized: boolean
}

type Executor = (statement: string) => Promise<unknown>

/**
 * Apply the V2 migration.
 *
 * It never drops anything, and it never alters an object that already exists
 * with a different definition. A column, index or constraint that owns one of
 * our names without being the thing we need stops the migration with a
 * `CONFIGURATION_ERROR` naming what was found.
 *
 * @param options.concurrent - build the *indexes* with `CONCURRENTLY`.
 *
 *   Default `false`, which is the safe mode: everything runs inside one
 *   transaction under an advisory lock, so any number of callers holding root
 *   database handles may run this at the same time and all of them return
 *   successfully. The cost is an `ACCESS EXCLUSIVE` lock on the affected tables
 *   for the duration, index builds included.
 *
 *   `true` makes only the index builds lock-free. **The column phase is not
 *   affected by this flag**: adding `hold_placed_at` and stamping the terminal
 *   rows run as one atomic statement that takes an `ACCESS EXCLUSIVE` lock on
 *   `credit_reservations` and holds it through the whole backfill scan — on a
 *   large table, plan for that as a write-blocking window in either mode. A
 *   refusal (open reservations found) rolls that one statement back; the two
 *   idempotency-key `ADD COLUMN IF NOT EXISTS` statements before it may
 *   already have committed in this mode — they are idempotent and harmless,
 *   and a re-run picks up where it left off.
 *
 *   Concurrent mode also gives up the coordination: `CREATE INDEX
 *   CONCURRENTLY` cannot run inside a transaction, and there is no way to pin
 *   a pool connection outside one, so **the operator must ensure only one
 *   runner executes at a time**. This mode never drops an index; if it finds
 *   an invalid one it refuses and asks for a serialized run, because dropping
 *   while another runner might be building is how two runners take turns
 *   destroying each other's work.
 */
export async function runCreditsV2Migration(
  db: DrizzleLikeDB,
  options?: { concurrent?: boolean }
): Promise<MigrationReport> {
  // Every failure leaves through here classified. A caller wiring this into a
  // deploy needs to tell "retry me" from "fix your schema", and a raw
  // `undefined_table` or `deadlock_detected` off the driver tells it neither.
  try {
    if (options?.concurrent) {
      const report = await applyMigration(db, { concurrent: true })
      return { ...report, serialized: false }
    }

    assertTransactional(db)
    return await db.transaction!(async (tx) => {
      await tx.execute!(sql`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY.toString()}::bigint)`)
      const report = await applyMigration(tx, { concurrent: false })
      return { ...report, serialized: true }
    })
  } catch (error) {
    throw classifyDatabaseError(error, { migration: 'credits_v2' })
  }
}

interface ApplyOptions {
  /** Build with `CONCURRENTLY`, outside a transaction and without the lock. */
  concurrent: boolean
}

async function applyMigration(
  db: DrizzleLikeDB,
  options: ApplyOptions
): Promise<Omit<MigrationReport, 'serialized'>> {
  const exec = executor(db)
  const steps: MigrationStep[] = []

  if (!options.concurrent) {
    steps.push({ statement: 'pg_advisory_xact_lock', action: 'lock', note: 'serialized' })
  }

  for (const statement of CREDITS_V2_COLUMNS_SQL) {
    await exec(statement)
    steps.push({ statement, action: 'column' })
  }

  // Before any index is built: a partial unique index over a column of the
  // wrong type, or one PostgreSQL fills in by default, enforces uniqueness over
  // values the code never wrote. Verifying the columns first means such a
  // database is refused rather than indexed.
  const columns = await verifyColumns(db)
  const constraints = await verifyConstraints(db)

  for (const index of V2_INDEXES) {
    await ensureIndex(db, exec, index, options, steps)
  }

  return { steps, indexes: await verifyIndexes(db), columns, constraints, repaired: [] }
}

/** Bring one index to the exact healthy shape, or explain why we will not. */
async function ensureIndex(
  db: DrizzleLikeDB,
  exec: Executor,
  index: V2IndexSpec,
  options: ApplyOptions,
  steps: MigrationStep[]
): Promise<void> {
  const before = await readIndexState(db, index.name, index.table)

  if (before.exists && !before.matchesSpec) throw wrongIndexError(before, index)
  if (before.healthy) {
    steps.push({ statement: `-- ${index.name}`, action: 'skip', note: 'already healthy' })
    return
  }

  // Right shape, unusable state — a build that died partway. There is no
  // command that repairs one in place, so it would have to be dropped and
  // rebuilt. This runner will not do that itself: see `invalidIndexError`.
  if (before.exists) throw invalidIndexError(before, index)

  const create = options.concurrent ? index.concurrentSql : index.blockingSql
  // Inside the serialized transaction, a failed build aborts the whole
  // transaction (25P02) and every follow-up query with it — including the
  // catalog re-read and the duplicate-key probe that make the error useful. A
  // savepoint scopes the failure to this one statement.
  const savepoint = options.concurrent ? undefined : `credits_v2_build_${steps.length}`
  try {
    if (savepoint) await exec(`SAVEPOINT ${savepoint}`)
    await exec(create)
    if (savepoint) await exec(`RELEASE SAVEPOINT ${savepoint}`)
  } catch (error) {
    if (savepoint) await exec(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined)
    // Only the unserialized path can lose a race to another runner; the
    // serialized one holds the lock. Accept the winner's work if — and only
    // if — the catalog now holds exactly the index we were about to build.
    const after = await readIndexState(db, index.name, index.table).catch(() => undefined)
    if (after?.healthy) {
      steps.push({
        statement: `-- ${index.name}`,
        action: 'skip',
        note: 'another runner built it first',
      })
      return
    }
    throw await explainFailedBuild(db, index, error)
  }
  steps.push({ statement: create, action: 'create-index' })
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
