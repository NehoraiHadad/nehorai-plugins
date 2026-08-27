/**
 * The migration's refusals, with enough detail for an operator to act.
 *
 * Every one of these is a `CONFIGURATION_ERROR` or a classified driver error,
 * never a bare throw: a caller wiring the migration into a deploy has to tell
 * "retry me" apart from "fix your schema", and a raw `undefined_table` off the
 * driver tells it neither.
 */

import { sql } from 'drizzle-orm'
import { CreditError, CreditErrorCode, classifyDatabaseError } from '@nehorai/credits'
import type { DrizzleLikeDB } from '../repository/db.js'
import { rowsOf, type IndexState } from './catalog.js'
import type { V2IndexSpec } from './specs.js'

/** The name is taken by an index that is not the one we need. */
export function wrongIndexError(state: IndexState, index: V2IndexSpec): CreditError {
  return new CreditError(
    `Index ${index.name} already exists but is not the index the V2 credit boundary needs: ` +
      `${state.mismatch ?? 'identity does not match'}. Rename or drop it before enabling V2 — ` +
      'this migration will not touch an index it does not own.',
    CreditErrorCode.CONFIGURATION_ERROR,
    { index: index.name, expectedTable: index.table, mismatch: state.mismatch, state }
  )
}

/**
 * Found a broken build. Report it; do not repair it.
 *
 * Repair means `DROP INDEX <name>`, and PostgreSQL re-resolves that name when
 * the statement runs — not when the catalog was inspected. Between the two, a
 * session that is not cooperating can rename this index away and rename an
 * unrelated one into the freed name, and the drop then destroys that one
 * instead. Locking the parent table does not prevent it: measured against
 * PostgreSQL 14.24, `ALTER INDEX ... RENAME` takes its lock on the index
 * relation and completes while the heap is held `ACCESS EXCLUSIVE`. SQL offers
 * no drop that targets an OID, so there is no formulation of this repair that
 * provably touches only the relation that was inspected.
 *
 * An automatic repair that is *usually* right is the wrong trade for a
 * migration: the failure mode is silently destroying an index that belongs to
 * something else, and then reporting success. So the runner stops and hands the
 * operator the exact identity it found, to drop under whatever quiescence they
 * can arrange.
 */
export function invalidIndexError(state: IndexState, index: V2IndexSpec): CreditError {
  // Schema-qualified and identifier-quoted, from the namespace the catalog read
  // actually found the index in. A bare `DROP INDEX <name>` re-resolves through
  // `search_path`, and in a multi-schema database an earlier schema can hold an
  // unrelated object with the same name — following the hint literally would
  // then drop the wrong one. Embedded quotes are doubled, so a hostile or
  // merely eccentric schema name cannot turn the hint into malformed SQL.
  const ident = (name: string) => `"${name.replace(/"/g, '""')}"`
  const qualified = state.schema ? `${ident(state.schema)}.${ident(index.name)}` : ident(index.name)
  return new CreditError(
    `Index ${index.name} exists but is not usable ` +
      `(valid=${state.isValid} ready=${state.isReady} live=${state.isLive}). ` +
      'This migration will not drop it: `DROP INDEX` resolves the name again when it runs, ' +
      'so a concurrent rename could redirect it onto an unrelated index. Drop it yourself ' +
      `with no other session renaming indexes — \`DROP INDEX ${qualified};\` — then re-run ` +
      'this migration to rebuild it.',
    CreditErrorCode.CONFIGURATION_ERROR,
    {
      index: index.name,
      state,
      hint: `DROP INDEX ${qualified}; then re-run the migration`,
      reason: 'invalid_index_needs_operator_repair',
    }
  )
}

/**
 * Turn a failed unique-index build into an actionable error.
 *
 * The overwhelmingly likely cause is duplicate rows that predate the
 * constraint, and the only useful thing to tell an operator is *which* keys
 * collide — so go and read them. A transient failure (deadlock, serialization,
 * lock timeout, lost connection) is classified as such instead, so a caller can
 * tell "retry me" apart from "fix your data".
 */
export async function explainFailedBuild(
  db: DrizzleLikeDB,
  index: V2IndexSpec,
  error: unknown
): Promise<Error> {
  const classified = classifyDatabaseError(error, { migration: index.name })
  if (classified.code === CreditErrorCode.TRANSIENT_ERROR) return classified

  const keys = index.keyColumns.map((column) => sql.raw(column))
  let duplicates: unknown[] = []
  try {
    duplicates = await rowsOf(
      db,
      sql`
        select ${sql.join(keys, sql`, `)}, count(*) as copies
        from ${sql.raw(index.table)}
        where ${sql.raw(index.predicateColumn)} is not null
        group by ${sql.join(keys, sql`, `)}
        having count(*) > 1
        limit 20
      `
    )
  } catch {
    // The duplicate probe is a courtesy; the build failure is the real news.
  }

  const columns = index.keyColumns.join(', ')
  return new CreditError(
    `Failed to build ${index.name}. ` +
      (duplicates.length
        ? `${duplicates.length} duplicate (${columns}) group(s) must be resolved first.`
        : 'See the underlying error for the cause.') +
      ' A failed concurrent build leaves an invalid index behind; once the duplicates are ' +
      'resolved and the unusable index has been dropped, re-run the migration.',
    CreditErrorCode.CONFIGURATION_ERROR,
    { index: index.name, duplicates, cause: String(error) }
  )
}

/** A column the boundary depends on is missing, or is not what it must be. */
export function columnError(table: string, column: string, mismatch: string): CreditError {
  return new CreditError(
    `Column ${table}.${column} is not what the V2 credit boundary requires: ${mismatch}. ` +
      'This migration adds missing columns but will not alter one that already exists with a ' +
      'different definition — that is a data-losing change only an operator should make.',
    CreditErrorCode.CONFIGURATION_ERROR,
    { table, column, mismatch, reason: 'column_identity_mismatch' }
  )
}

/** A CHECK constraint carries one of our names while checking something else. */
export function constraintError(
  table: string,
  name: string,
  mismatch: string
): CreditError {
  return new CreditError(
    `Constraint ${name} on ${table} does not match the definition this migration owns: ` +
      `${mismatch}. Its name says the rule is enforced while its definition says otherwise; ` +
      'drop or rename it before enabling V2.',
    CreditErrorCode.CONFIGURATION_ERROR,
    { table, constraint: name, mismatch, reason: 'constraint_definition_mismatch' }
  )
}
