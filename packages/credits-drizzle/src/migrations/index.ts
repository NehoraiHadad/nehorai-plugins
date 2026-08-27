/**
 * Migration for the V2 idempotency columns and indexes.
 *
 * Apps managing schema with drizzle-kit do not need this — `drizzle-kit
 * generate` picks the changes up from the exported schema. It is here for
 * everyone else, and so integration tests exercise the same DDL production runs.
 *
 * The statements are ordered and individually idempotent, so a partially
 * applied migration can be re-run safely.
 */

/**
 * Add the nullable key columns. Metadata-only in PostgreSQL — adding a
 * nullable column with no default does not rewrite the table, so this is safe
 * on a large live table.
 */
export const CREDITS_V2_COLUMNS_SQL: readonly string[] = [
  `ALTER TABLE credit_reservations ADD COLUMN IF NOT EXISTS idempotency_key text`,
  `ALTER TABLE credit_journal_entries ADD COLUMN IF NOT EXISTS idempotency_key text`,
]

/**
 * The uniqueness contract, as partial indexes.
 *
 * **Prefer `runCreditsV2Migration`** from `./runner.js` over running these by
 * hand. A `CREATE UNIQUE INDEX CONCURRENTLY` that fails leaves an invalid index
 * occupying the name, and no amount of re-running plain SQL repairs that — only
 * a catalog check can detect it. These strings are the building blocks the
 * runner uses, exported for migration tools that want to embed them.
 *
 * Partial (`WHERE idempotency_key IS NOT NULL`) so existing rows — all of
 * which have a NULL key — impose no constraint and cannot make the build fail.
 *
 * These use `CREATE UNIQUE INDEX CONCURRENTLY`, which **cannot run inside a
 * transaction block**. Run them outside your migration transaction (most
 * migration runners need an explicit opt-out), or use
 * {@link CREDITS_V2_INDEXES_BLOCKING_SQL} if a brief write lock is acceptable.
 */
export interface V2IndexSpec {
  name: string
  table: string
  /** Non-blocking build. Cannot run inside a transaction block. */
  concurrentSql: string
  /** Blocking build. Transactional, but locks writes for the duration. */
  blockingSql: string
}

function indexSpec(table: string): V2IndexSpec {
  const name = `${table}_idempotency_key_unique`
  const body = `${name}
     ON ${table} (user_id, idempotency_key)
     WHERE idempotency_key IS NOT NULL`
  return {
    name,
    table,
    // No `IF NOT EXISTS` here on purpose. It is what makes a failed concurrent
    // build unrecoverable: the invalid index keeps the name, so the re-run
    // skips it and reports success while nothing is enforced. The runner in
    // `./runner.js` checks the catalog and drops the broken index instead.
    concurrentSql: `CREATE UNIQUE INDEX CONCURRENTLY ${body}`,
    blockingSql: `CREATE UNIQUE INDEX ${body}`,
  }
}

/** The two indexes the V2 boundary requires, as inspectable descriptors. */
export const V2_INDEXES: readonly V2IndexSpec[] = [
  indexSpec('credit_reservations'),
  indexSpec('credit_journal_entries'),
]

export const CREDITS_V2_INDEXES_SQL: readonly string[] = V2_INDEXES.map(
  (index) => index.concurrentSql
)

/** Same indexes without `CONCURRENTLY` — transactional, but blocks writes. */
export const CREDITS_V2_INDEXES_BLOCKING_SQL: readonly string[] = V2_INDEXES.map(
  (index) => index.blockingSql
)

/**
 * Optional integrity constraints, added `NOT VALID`.
 *
 * `NOT VALID` means PostgreSQL enforces them for new and updated rows but does
 * not scan existing ones, so adding them takes only a brief lock and cannot
 * fail on legacy data. Audit the table, then `VALIDATE CONSTRAINT` separately
 * (see {@link CREDITS_V2_VALIDATE_CONSTRAINTS_SQL}).
 *
 * Deliberately excluded: `balance >= 0` and `bonus_credits >= 0`. Apps that
 * booked corrections or overdrafts may legitimately hold negative rows, and a
 * constraint that rejects those would break their writes.
 */
export const CREDITS_V2_CONSTRAINTS_SQL: readonly string[] = [
  addConstraint(
    'credit_reservations',
    'credit_reservations_amount_positive',
    'amount > 0'
  ),
  addConstraint(
    'credit_reservations',
    'credit_reservations_status_valid',
    "status IN ('reserved', 'committed', 'released', 'expired')"
  ),
  addConstraint(
    'credit_journal_entries',
    'credit_journal_entries_entry_type_valid',
    "entry_type IN ('debit', 'credit')"
  ),
]

/**
 * `ADD CONSTRAINT` has no `IF NOT EXISTS` in PostgreSQL, so wrap it and
 * swallow `duplicate_object` to keep re-running the migration safe.
 */
function addConstraint(table: string, name: string, check: string): string {
  return `DO $$ BEGIN
  ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${check}) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$`
}

/** Promote the `NOT VALID` constraints once existing rows have been audited. */
export const CREDITS_V2_VALIDATE_CONSTRAINTS_SQL: readonly string[] = [
  `ALTER TABLE credit_reservations VALIDATE CONSTRAINT credit_reservations_amount_positive`,
  `ALTER TABLE credit_reservations VALIDATE CONSTRAINT credit_reservations_status_valid`,
  `ALTER TABLE credit_journal_entries VALIDATE CONSTRAINT credit_journal_entries_entry_type_valid`,
]

/**
 * Columns + indexes, in order — the minimum required to run the V2 boundary.
 *
 * Contains `CONCURRENTLY`, so execute the statements one at a time outside a
 * transaction block.
 */
export const CREDITS_V2_MIGRATION_SQL: readonly string[] = [
  ...CREDITS_V2_COLUMNS_SQL,
  ...CREDITS_V2_INDEXES_SQL,
]

/** Everything, as one copy-pasteable script (psql runs each statement separately). */
export function creditsV2MigrationScript(options?: {
  concurrent?: boolean
  includeConstraints?: boolean
}): string {
  const concurrent = options?.concurrent ?? true
  const statements = [
    ...CREDITS_V2_COLUMNS_SQL,
    ...(concurrent ? CREDITS_V2_INDEXES_SQL : CREDITS_V2_INDEXES_BLOCKING_SQL),
    ...(options?.includeConstraints ? CREDITS_V2_CONSTRAINTS_SQL : []),
  ]
  return statements.map((statement) => `${statement};`).join('\n\n')
}

export {
  runCreditsV2Migration,
  readIndexState,
  type IndexState,
  type MigrationReport,
  type MigrationStep,
} from './runner.js'
