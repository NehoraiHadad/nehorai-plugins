/**
 * Migration for the V2 idempotency columns and indexes.
 *
 * Apps managing schema with drizzle-kit do not need this — `drizzle-kit
 * generate` picks the changes up from the exported schema. It is here for
 * everyone else, and so integration tests exercise the same DDL production runs.
 *
 * **Prefer {@link runCreditsV2Migration} over running the SQL by hand.** The
 * raw statements are not individually idempotent and are not safe to run
 * concurrently: a failed `CREATE UNIQUE INDEX CONCURRENTLY` leaves an invalid
 * index occupying the name, which no amount of re-running plain SQL repairs,
 * and two simultaneous runs of the DDL can deadlock. The runner holds an
 * advisory lock, reads the catalog, and repairs what it finds.
 */

export {
  CREDITS_V2_COLUMNS_SQL,
  CREDITS_V2_CONSTRAINTS_SQL,
  CREDITS_V2_INDEXES_BLOCKING_SQL,
  CREDITS_V2_INDEXES_SQL,
  CREDITS_V2_MIGRATION_SQL,
  CREDITS_V2_VALIDATE_CONSTRAINTS_SQL,
  creditsV2MigrationScript,
} from './statements.js'

export {
  V2_COLUMNS,
  V2_CONSTRAINTS,
  V2_INDEXES,
  specForIndex,
  type V2ColumnSpec,
  type V2ConstraintSpec,
  type V2IndexSpec,
} from './specs.js'

export { readIndexState, matchIndex, type IndexState } from './catalog.js'

export {
  readColumnState,
  readConstraintState,
  type ColumnState,
  type ConstraintState,
} from './columns.js'

export { verifyColumns, verifyConstraints, verifyIndexes } from './verify.js'

export {
  runCreditsV2Migration,
  type MigrationReport,
  type MigrationStep,
} from './runner.js'
