/**
 * The raw DDL the V2 boundary needs.
 *
 * **These statements are not individually idempotent.** The `ALTER TABLE ... ADD
 * COLUMN IF NOT EXISTS` pair is; the index builds deliberately are not. They
 * carry no `IF NOT EXISTS`, because that clause is exactly what makes a failed
 * `CONCURRENTLY` build unrecoverable — the invalid index keeps the name, the
 * re-run sees the name and skips, and the migration reports success over a
 * constraint that enforces nothing.
 *
 * Re-running this SQL by hand against a database that already has the indexes
 * therefore fails with `42P07 duplicate_table`, and running two copies at once
 * can deadlock (`40P01`). Reconciliation and coordination live in
 * {@link runCreditsV2Migration}, not in the strings. These are exported for
 * migration tools that want to embed the DDL and manage that themselves.
 */

import { V2_INDEXES } from './specs.js'

/**
 * Add the nullable key columns. Metadata-only in PostgreSQL — adding a
 * nullable column with no default does not rewrite the table, so this is safe
 * on a large live table.
 */
export const CREDITS_V2_COLUMNS_SQL: readonly string[] = [
  `ALTER TABLE credit_reservations ADD COLUMN IF NOT EXISTS idempotency_key text`,
  `ALTER TABLE credit_journal_entries ADD COLUMN IF NOT EXISTS idempotency_key text`,
  addHoldPlacedAt(),
]

/**
 * Add `hold_placed_at`, grandfathering the rows that predate it — exactly once,
 * and only on evidence.
 *
 * The column is the hold-origin fact: `reserveCreditsV2` writes it in the same
 * transaction that raises `credit_balances.reserved`, and every V2 transition
 * refuses to move a reservation without it. Rows written before the column
 * existed carry NULL, and the backfill turns them into trusted credentials — so
 * it must not certify on faith. Before 1.8.0, `createReservation` could write a
 * `status = 'reserved'` row that never touched `reserved`, and such a record is
 * indistinguishable *by row* from a genuine hold.
 *
 * The arithmetic tells them apart in aggregate: every genuine hold added its
 * amount to `credit_balances.reserved` and every record added nothing, so for
 * each user, sum(open rows) = reserved exactly when no record-rows are open.
 * The backfill therefore *reconciles first*: if any user's open rows do not sum
 * to their `reserved`, the whole migration is refused (`RAISE EXCEPTION`, which
 * also rolls back the `ADD COLUMN`) and the operator releases or repairs the
 * mismatched rows before re-running. No ambiguous row is ever certified.
 *
 * The backfill is inside the same `IF NOT EXISTS` branch as the `ADD COLUMN`,
 * which is what makes it one-shot: it runs in the transaction that introduces
 * the column and never again. A re-run — or a run against a database where V2
 * has been live and has legitimately left NULLs on rows written by
 * `createReservation` — takes the other branch and writes nothing.
 *
 * `EXECUTE` rather than a plain `UPDATE`: PL/pgSQL plans a static statement
 * against the catalog as it was, and the column being written did not exist
 * when the block was entered.
 */
function addHoldPlacedAt(): string {
  return `DO $$
DECLARE
  target oid := to_regclass('credit_reservations');
BEGIN
  IF target IS NULL THEN
    RAISE EXCEPTION 'credit_reservations does not exist in the current search_path';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = target AND attname = 'hold_placed_at' AND attnum > 0 AND NOT attisdropped
  ) THEN
    IF EXISTS (SELECT 1 FROM credit_reservations WHERE status = 'reserved') THEN
      IF to_regclass('credit_balances') IS NULL THEN
        RAISE EXCEPTION 'hold_placed_at backfill refused: credit_reservations has open rows but credit_balances does not exist in the current search_path, so they cannot be reconciled';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM (
          SELECT user_id, sum(amount) AS held
          FROM credit_reservations
          WHERE status = 'reserved'
          GROUP BY user_id
        ) open_rows
        LEFT JOIN credit_balances b ON b.user_id = open_rows.user_id
        WHERE open_rows.held IS DISTINCT FROM coalesce(b.reserved, 0)
      ) THEN
        RAISE EXCEPTION 'hold_placed_at backfill refused: open credit_reservations rows do not reconcile with credit_balances.reserved for at least one user. Such rows are records, not holds, and certifying them would let a commit spend coverage no hold ever placed. Release or repair the mismatched rows, then re-run the migration.';
      END IF;
    END IF;
    EXECUTE 'ALTER TABLE credit_reservations ADD COLUMN hold_placed_at timestamptz';
    EXECUTE 'UPDATE credit_reservations SET hold_placed_at = created_at';
  END IF;
END $$`
}

/**
 * The uniqueness contract, as partial indexes.
 *
 * Partial (`WHERE idempotency_key IS NOT NULL`) so existing rows — all of
 * which have a NULL key — impose no constraint and cannot make the build fail.
 *
 * These use `CREATE UNIQUE INDEX CONCURRENTLY`, which **cannot run inside a
 * transaction block**. Run them outside your migration transaction (most
 * migration runners need an explicit opt-out), or use
 * {@link CREDITS_V2_INDEXES_BLOCKING_SQL} if a brief write lock is acceptable.
 */
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
 * `amount > 0` is worth applying: the V2 transitions refuse to move a
 * reservation whose stored amount is not a valid movable amount, so a row that
 * violates it is stuck until an operator fixes it. The database check stops it
 * being written in the first place, including by callers that bypass this
 * library entirely.
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
 * swallow `duplicate_object` to keep re-running these safe.
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
 * transaction block, and only once.
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
