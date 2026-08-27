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
 * Add `hold_placed_at` — refusing to run while any open reservation exists.
 *
 * The column is the hold-origin fact: `reserveCreditsV2` writes it in the same
 * transaction that raises `credit_balances.reserved`, and every V2 transition
 * refuses to move a reservation without it. A backfill turns pre-column rows
 * into trusted credentials, and no query can prove *per row* whether a legacy
 * `status = 'reserved'` row was a genuine hold or a record `createReservation`
 * wrote without touching `reserved` — aggregate arithmetic passes offsetting
 * corruption, and any check that runs before the table is locked can be
 * outrun by a live legacy writer. So open rows are not certified at all: the
 * migration requires there to be none.
 *
 * Order matters, and it is the whole fix for the check-then-certify race: the
 * `ADD COLUMN` runs *first* and takes its ACCESS EXCLUSIVE lock, and the
 * open-row check runs under that lock — nothing can insert a row between the
 * check and the backfill. The lock is held through the backfill scan, so plan
 * a write-blocking window for a large table (the `concurrent` runner flag does
 * not change this phase — only the index builds). A refusal (`RAISE
 * EXCEPTION`) rolls this whole statement back, `ADD COLUMN` included; on the
 * concurrent runner path the two idempotency-key columns added by the earlier
 * statements may already have committed — idempotent, harmless, picked up by
 * the re-run. The operator releases or expires the open reservations (they
 * are short-lived by design — every row carries `expires_at`), decrementing
 * `credit_balances.reserved` by each released row's amount as the legacy
 * release path would have, and re-runs.
 *
 * What the backfill then stamps is provably only terminal rows — committed,
 * released, expired — which no transition will ever move again; the stamp is
 * inert bookkeeping, never authority. The one-shot property is unchanged: the
 * whole branch runs only when it introduces the column, so a NULL that appears
 * later (a post-migration `createReservation` record) is never blessed by a
 * re-run.
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
    EXECUTE 'ALTER TABLE credit_reservations ADD COLUMN hold_placed_at timestamptz';
    IF EXISTS (SELECT 1 FROM credit_reservations WHERE status = 'reserved') THEN
      RAISE EXCEPTION 'hold_placed_at migration refused: open (status = ''reserved'') credit_reservations rows exist, and no backfill can prove which of them are genuine holds. Release or expire every open reservation (adjusting credit_balances.reserved as the release path would), then re-run this migration. This statement rolled back; it changed nothing.';
    END IF;
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
