/**
 * The indexes and columns the V2 boundary requires, as inspectable descriptors.
 *
 * Kept in their own module so the catalog reader and the runner can both
 * depend on them without importing each other.
 */

export interface V2IndexSpec {
  name: string
  table: string
  /** Key columns in index order. */
  keyColumns: readonly string[]
  /** The column the partial predicate is built on. */
  predicateColumn: string
  /** The predicate as `pg_get_expr` deparses it, lowercased. */
  deparsedPredicate: string
  /** Non-blocking build. Cannot run inside a transaction block. */
  concurrentSql: string
  /** Blocking build. Transactional, but locks writes for the duration. */
  blockingSql: string
}

/**
 * One partial unique index, named after the column whose uniqueness it carries.
 *
 * The predicate column is always the last key column: these indexes exist to
 * make a nullable key unique *when present*, so the column being made unique is
 * the one that must be non-null for the row to be covered.
 */
function indexSpec(table: string, keyColumns: readonly string[]): V2IndexSpec {
  const predicateColumn = keyColumns[keyColumns.length - 1]
  const name = `${table}_${predicateColumn}_unique`
  const body = `${name}
     ON ${table} (${keyColumns.join(', ')})
     WHERE ${predicateColumn} IS NOT NULL`
  return {
    name,
    table,
    keyColumns,
    predicateColumn,
    deparsedPredicate: `(${predicateColumn} is not null)`,
    // No `IF NOT EXISTS` here on purpose. It is what makes a failed concurrent
    // build unrecoverable: the invalid index keeps the name, so the re-run
    // skips it and reports success while nothing is enforced. The runner in
    // `./runner.js` checks the catalog instead, and refuses with the exact
    // statement for an operator to run — it never drops or rebuilds an index
    // itself, because no SQL formulation can provably target the relation it
    // inspected.
    concurrentSql: `CREATE UNIQUE INDEX CONCURRENTLY ${body}`,
    blockingSql: `CREATE UNIQUE INDEX ${body}`,
  }
}

export const V2_INDEXES: readonly V2IndexSpec[] = [
  indexSpec('credit_reservations', ['user_id', 'idempotency_key']),
  indexSpec('credit_journal_entries', ['user_id', 'idempotency_key']),
  // `payment_ref` is a *global* idempotency boundary, not a per-user one: the
  // same provider reference names the same credit event whoever presents it,
  // so the key is the reference alone. `addCreditsV2` inserts through this
  // index with `ON CONFLICT DO NOTHING`, which means a missing or drifted
  // index is not a silent loss of deduplication — PostgreSQL raises 42P10.
  indexSpec('credit_plugin_transactions', ['payment_ref']),
]

/** The spec a target index name belongs to, if it is one of ours. */
export function specForIndex(name: string): V2IndexSpec | undefined {
  return V2_INDEXES.find((index) => index.name === name)
}

/**
 * A column the boundary reads or writes, described exactly enough to verify.
 *
 * Verifying by name alone is how a migration reports "applied" over a column
 * that cannot hold what the code puts in it. A `varchar(20)` `idempotency_key`
 * truncates; a `NOT NULL` one rejects every legacy row; one with a `DEFAULT` or
 * a `GENERATED` expression manufactures values the code never wrote — and for
 * `hold_placed_at`, a manufactured value is a forged hold-origin fact.
 */
export interface V2ColumnSpec {
  table: string
  column: string
  /** `format_type()` output the column must have, exactly. */
  type: string
  /** Every V2 column is nullable: legacy rows predate all of them. */
  nullable: true
}

export const V2_COLUMNS: readonly V2ColumnSpec[] = [
  { table: 'credit_reservations', column: 'idempotency_key', type: 'text', nullable: true },
  {
    table: 'credit_reservations',
    column: 'hold_placed_at',
    type: 'timestamp with time zone',
    nullable: true,
  },
  { table: 'credit_journal_entries', column: 'idempotency_key', type: 'text', nullable: true },
  { table: 'credit_plugin_transactions', column: 'payment_ref', type: 'text', nullable: true },
]

/**
 * The CHECK constraints the migration offers, with the definition each must
 * carry.
 *
 * They are optional — {@link CREDITS_V2_CONSTRAINTS_SQL} is not applied by the
 * runner — but a constraint that exists under one of these names and says
 * something *else* is drift, and drift here is invisible: the name reads as
 * "the amounts are checked" while the definition permits zero or negative ones.
 * The expected text is `pg_get_constraintdef` output, which is normalised by
 * PostgreSQL rather than by us.
 */
export interface V2ConstraintSpec {
  table: string
  name: string
  definition: string
}

export const V2_CONSTRAINTS: readonly V2ConstraintSpec[] = [
  {
    table: 'credit_reservations',
    name: 'credit_reservations_amount_positive',
    definition: 'CHECK ((amount > (0)::numeric))',
  },
  {
    table: 'credit_reservations',
    name: 'credit_reservations_status_valid',
    definition:
      "CHECK ((status = ANY (ARRAY['reserved'::text, 'committed'::text, 'released'::text, 'expired'::text])))",
  },
  {
    table: 'credit_journal_entries',
    name: 'credit_journal_entries_entry_type_valid',
    definition: "CHECK ((entry_type = ANY (ARRAY['debit'::text, 'credit'::text])))",
  },
]
