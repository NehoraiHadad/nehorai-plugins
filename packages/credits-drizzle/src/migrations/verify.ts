/**
 * The migration's exit check: re-read every object and refuse to return until
 * each one is exactly right.
 *
 * Verification is separate from application on purpose. "I ran the DDL" and
 * "the constraint is enforced" are different claims, and the second is the only
 * one a caller can safely enable the V2 boundary on. Everything here reads the
 * catalog after the fact; nothing here writes.
 */

import { CreditError, CreditErrorCode } from '@nehorai/credits'
import type { DrizzleLikeDB } from '../repository/db.js'
import { readIndexState, type IndexState } from './catalog.js'
import { readColumnState, readConstraintState, type ColumnState, type ConstraintState } from './columns.js'
import { columnError, constraintError, wrongIndexError } from './errors.js'
import { V2_COLUMNS, V2_CONSTRAINTS, V2_INDEXES } from './specs.js'

/** Every column must exist with the exact identity the boundary writes to. */
export async function verifyColumns(db: DrizzleLikeDB): Promise<ColumnState[]> {
  const states: ColumnState[] = []
  for (const spec of V2_COLUMNS) {
    const state = await readColumnState(db, spec)
    if (!state.matchesSpec) {
      throw columnError(spec.table, spec.column, state.mismatch ?? 'identity does not match')
    }
    states.push(state)
  }
  return states
}

/**
 * Constraints are optional, but a *wrong* one is not.
 *
 * Absent is fine and reported as such — the runner does not add them. Present
 * under our name with a different definition is drift that reads as safety, so
 * it stops the migration.
 */
export async function verifyConstraints(db: DrizzleLikeDB): Promise<ConstraintState[]> {
  const states: ConstraintState[] = []
  for (const spec of V2_CONSTRAINTS) {
    const state = await readConstraintState(db, spec)
    if (state.exists && !state.matchesSpec) {
      throw constraintError(spec.table, spec.name, state.mismatch ?? 'definition does not match')
    }
    states.push(state)
  }
  return states
}

/** Every index must exist, match its spec, and be usable. */
export async function verifyIndexes(db: DrizzleLikeDB): Promise<IndexState[]> {
  const indexes: IndexState[] = []
  for (const index of V2_INDEXES) {
    const state = await readIndexState(db, index.name, index.table)
    if (state.exists && !state.matchesSpec) throw wrongIndexError(state, index)
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
  return indexes
}
