/**
 * What the PostgreSQL catalog says about the V2 columns and CHECK constraints.
 *
 * The index reader in `./catalog.js` answers "is uniqueness enforced, and on
 * what". This answers the question underneath it: does the column the index
 * covers actually hold what the code writes to it, and does nothing else write
 * to it behind the code's back.
 *
 * That distinction matters most for `hold_placed_at`. Its whole value is that
 * only `reserveCreditsV2` writes it, in the transaction that raises `reserved`
 * — so a `DEFAULT now()` or a `GENERATED` expression on that column does not
 * merely differ from the schema, it *forges the hold-origin fact* and hands
 * every unbacked row a passing credential.
 */

import { sql } from 'drizzle-orm'
import type { DrizzleLikeDB } from '../repository/db.js'
import { rowsOf } from './catalog.js'
import type { V2ColumnSpec, V2ConstraintSpec } from './specs.js'

/** What the catalog says about one target column. */
export interface ColumnState {
  table: string
  column: string
  exists: boolean
  /** Exists with exactly the type, nullability and write-origin the spec needs. */
  matchesSpec: boolean
  /** First identity field that disagrees, for the operator's error message. */
  mismatch?: string
  /** `format_type()` output — type *and* modifiers, so `varchar(20)` is visible. */
  type?: string
  nullable?: boolean
  /** The `DEFAULT` expression, if any. Any value here is a value the code did not write. */
  defaultExpression?: string
  /** `s` for stored generated columns, empty otherwise. */
  generated?: string
  /** `a`/`d` for identity columns, empty otherwise. */
  identity?: string
}

/**
 * Read one column's identity, resolved through `search_path` like the DDL.
 *
 * `attisdropped` rows are excluded: a dropped column keeps its `pg_attribute`
 * row under a mangled name, and counting one would be reading a ghost.
 */
export async function readColumnState(
  db: DrizzleLikeDB,
  spec: V2ColumnSpec
): Promise<ColumnState> {
  const rows = await rowsOf(
    db,
    sql`
      select format_type(a.atttypid, a.atttypmod) as type,
             a.attnotnull as not_null,
             a.attgenerated as generated,
             a.attidentity as identity,
             pg_get_expr(d.adbin, d.adrelid) as default_expression
      from pg_catalog.pg_attribute a
      left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = to_regclass(${spec.table})
        and a.attname = ${spec.column}
        and a.attnum > 0
        and not a.attisdropped
    `
  )

  const row = rows[0] as Record<string, unknown> | undefined
  if (!row) {
    return {
      table: spec.table,
      column: spec.column,
      exists: false,
      matchesSpec: false,
      mismatch: 'column does not exist',
    }
  }

  const state: ColumnState = {
    table: spec.table,
    column: spec.column,
    exists: true,
    matchesSpec: false,
    type: str(row.type),
    nullable: row.not_null !== true,
    defaultExpression: str(row.default_expression),
    generated: str(row.generated) ?? '',
    identity: str(row.identity) ?? '',
  }

  const mismatch = columnMismatch(state, spec)
  return { ...state, matchesSpec: mismatch === undefined, ...(mismatch ? { mismatch } : {}) }
}

function columnMismatch(state: ColumnState, spec: V2ColumnSpec): string | undefined {
  if (state.type !== spec.type) return `type is ${state.type ?? 'unknown'}, expected ${spec.type}`
  if (spec.nullable && state.nullable !== true) {
    return 'is NOT NULL, expected nullable so legacy rows remain writable'
  }
  if (state.generated) return `is a generated column (attgenerated=${state.generated})`
  if (state.identity) return `is an identity column (attidentity=${state.identity})`
  if (state.defaultExpression) {
    return `has DEFAULT ${state.defaultExpression}, expected none — only the code may write this column`
  }
  return undefined
}

/** What the catalog says about one named CHECK constraint. */
export interface ConstraintState {
  table: string
  name: string
  exists: boolean
  /** Present *and* saying exactly what the spec says it must say. */
  matchesSpec: boolean
  mismatch?: string
  /** `pg_get_constraintdef` output, normalised by PostgreSQL rather than by us. */
  definition?: string
  /** False for a `NOT VALID` constraint: enforced going forward, unproven for old rows. */
  validated?: boolean
}

/**
 * Read one CHECK constraint by name.
 *
 * A missing constraint is reported, not judged: these are optional additions.
 * A constraint that exists under our name and checks something else is the
 * dangerous case — the name reads as "amounts are positive" while the
 * definition permits zero — and that is what `matchesSpec` is false for.
 */
export async function readConstraintState(
  db: DrizzleLikeDB,
  spec: V2ConstraintSpec
): Promise<ConstraintState> {
  const rows = await rowsOf(
    db,
    sql`
      select pg_get_constraintdef(c.oid) as definition, c.convalidated, c.contype
      from pg_catalog.pg_constraint c
      where c.conrelid = to_regclass(${spec.table}) and c.conname = ${spec.name}
    `
  )

  const row = rows[0] as Record<string, unknown> | undefined
  if (!row) {
    return { table: spec.table, name: spec.name, exists: false, matchesSpec: false }
  }

  const definition = str(row.definition)
  const contype = str(row.contype)
  const mismatch =
    contype !== 'c'
      ? `is not a CHECK constraint (contype=${contype ?? 'unknown'})`
      : checkBody(definition) !== checkBody(spec.definition)
        ? `definition is ${definition ?? 'unreadable'}, expected ${spec.definition}`
        : undefined

  return {
    table: spec.table,
    name: spec.name,
    exists: true,
    matchesSpec: mismatch === undefined,
    ...(mismatch ? { mismatch } : {}),
    definition,
    validated: row.convalidated === true,
  }
}

/**
 * The rule a CHECK enforces, without the `NOT VALID` marker.
 *
 * `pg_get_constraintdef` appends `NOT VALID` while existing rows are unproven.
 * That is a fact about the *scan*, not about the rule, and it is reported
 * separately as `validated` — comparing it as part of the definition would make
 * a correctly-added constraint read as drift the moment it was validated.
 */
function checkBody(value: string | undefined): string {
  return (value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+NOT VALID$/i, '')
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
