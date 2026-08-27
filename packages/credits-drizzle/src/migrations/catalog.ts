/**
 * What the PostgreSQL catalog actually says about a V2 index.
 *
 * An index name is unique per schema across every relation, so the name proves
 * nothing on its own: a perfectly healthy `UNIQUE INDEX ... (id)` can carry the
 * name the V2 boundary is looking for. Matching on the name — or on a substring
 * of `pg_get_indexdef` — is how a runner ends up reporting "applied" over a
 * table that enforces nothing.
 *
 * So identity is read from the catalog, field by field, and compared exactly.
 */

import { sql } from 'drizzle-orm'
import type { DrizzleLikeDB } from '../repository/db.js'
import { specForIndex, type V2IndexSpec } from './specs.js'

/** What the catalog says about one target index. */
export interface IndexState {
  name: string
  exists: boolean
  /** Exists, is usable, is enforcing, *and* enforces the right thing. */
  healthy: boolean
  /** Identity matches the spec: right table, columns, order, uniqueness, predicate. */
  matchesSpec?: boolean
  /** First identity field that disagrees, for the operator's error message. */
  mismatch?: string
  isValid?: boolean
  isReady?: boolean
  isLive?: boolean
  isUnique?: boolean
  isPrimary?: boolean
  /** True when the index covers an expression rather than plain columns. */
  hasExpressions?: boolean
  /** The table the index is actually attached to — not assumed from the name. */
  table?: string
  /** Key columns in index order, each verified to be a plain default-opclass column. */
  keyColumns?: string[]
  /** Total attributes, so an extra `INCLUDE` column cannot slip through. */
  totalAttributes?: number
  accessMethod?: string
  predicate?: string
  definition?: string
}

/**
 * Read one index by name, in the schema the DDL would create it in.
 *
 * The lookup is scoped to the target table's namespace rather than
 * `current_schema()`: `CREATE INDEX ... ON credit_journal_entries` resolves the
 * table through `search_path`, and the index is created beside it. Resolving
 * the name any other way would inspect one schema and migrate another.
 *
 * Every key column is read through `pg_get_indexdef(oid, n, true)`, which emits
 * the bare column name only when the opclass, collation, sort direction and
 * null ordering are all default — so one exact string comparison per column
 * covers the column, its position, and the four modifiers at once, and anything
 * unusual is rejected rather than glossed over.
 */
export async function readIndexState(
  db: DrizzleLikeDB,
  name: string,
  table?: string
): Promise<IndexState> {
  const spec = specForIndex(name)
  const target = table ?? spec?.table
  const namespace = target
    ? sql`(select relnamespace from pg_catalog.pg_class where oid = to_regclass(${target}))`
    : sql`(select oid from pg_catalog.pg_namespace where nspname = current_schema())`

  const rows = await rowsOf(
    db,
    sql`
      select i.indisvalid, i.indisready, i.indislive, i.indisunique, i.indisprimary,
             i.indnatts, i.indnkeyatts,
             i.indexprs is not null as has_expressions,
             i.indrelid::regclass::text as table_name,
             am.amname as access_method,
             pg_get_expr(i.indpred, i.indrelid) as predicate,
             pg_get_indexdef(c.oid, 1, true) as key_1,
             pg_get_indexdef(c.oid, 2, true) as key_2,
             pg_get_indexdef(c.oid) as definition
      from pg_catalog.pg_class c
      join pg_catalog.pg_index i on i.indexrelid = c.oid
      join pg_catalog.pg_am am on am.oid = c.relam
      where c.relkind = 'i' and c.relname = ${name} and c.relnamespace = ${namespace}
    `
  )

  const row = rows[0] as Record<string, unknown> | undefined
  if (!row) return { name, exists: false, healthy: false }


  const isValid = row.indisvalid === true
  const isReady = row.indisready === true
  const isLive = row.indislive === true
  const isUnique = row.indisunique === true
  const keyCount = Number(row.indnkeyatts)

  const state: IndexState = {
    name,
    exists: true,
    healthy: false, // decided below, once the spec says what this index must be
    isValid,
    isReady,
    isLive,
    isUnique,
    table: str(row.table_name),
    keyColumns: [str(row.key_1), str(row.key_2)]
      .slice(0, Number.isFinite(keyCount) ? keyCount : 2)
      .filter((value): value is string => value !== undefined),
    totalAttributes: Number(row.indnatts),
    accessMethod: str(row.access_method),
    predicate: str(row.predicate),
    definition: str(row.definition),
    isPrimary: row.indisprimary === true,
    hasExpressions: row.has_expressions === true,
  }

  // A caller who asks about one of ours gets the full verdict; anything else
  // gets the raw catalog facts, since only the spec knows what "right" means.
  if (spec) return matchIndex(state, spec)
  return { ...state, healthy: isValid && isReady && isLive && isUnique }
}

/**
 * Compare what is there against what the boundary needs, and say so.
 *
 * Returns the state with `matchesSpec`/`mismatch`/`healthy` filled in. The
 * comparison is deliberately conservative: an index that is semantically
 * equivalent but written differently (`NOT (key IS NULL)` deparses differently
 * from `key IS NOT NULL`) is reported as a mismatch, which makes the runner
 * refuse and tell the operator — never drop, never silently accept.
 */
export function matchIndex(state: IndexState, index: V2IndexSpec): IndexState {
  if (!state.exists) return { ...state, healthy: false }
  const mismatch = firstMismatch(state, index)
  const matchesSpec = mismatch === undefined
  return {
    ...state,
    matchesSpec,
    ...(mismatch ? { mismatch } : {}),
    healthy: matchesSpec && !!state.isValid && !!state.isReady && !!state.isLive,
  }
}

function firstMismatch(state: IndexState, index: V2IndexSpec): string | undefined {
  if (state.table !== index.table) return `attached to ${state.table ?? 'unknown'}`
  if (state.isPrimary) return 'is a primary key index'
  if (state.accessMethod !== 'btree') return `access method is ${state.accessMethod}`
  if (!state.isUnique) return 'is not unique'
  if (state.hasExpressions) return 'indexes an expression, not plain columns'
  const expected = index.keyColumns
  // Total attributes, not just key attributes: an `INCLUDE` column would leave
  // the key list looking right while the index is not the one that was audited.
  if (state.totalAttributes !== expected.length) {
    return `has ${state.totalAttributes} attributes, expected ${expected.length}`
  }
  const keys = state.keyColumns ?? []
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
    return `key columns are (${keys.join(', ')}), expected (${expected.join(', ')})`
  }
  const predicate = (state.predicate ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (predicate !== index.deparsedPredicate) {
    return `predicate is ${state.predicate ?? 'absent'}, expected WHERE ${index.predicateColumn} IS NOT NULL`
  }
  return undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Drivers disagree on whether `execute` returns rows or `{ rows }`. */
export async function rowsOf(db: DrizzleLikeDB, statement: unknown): Promise<unknown[]> {
  if (typeof db.execute !== 'function') return []
  const result = (await db.execute(statement)) as unknown
  if (Array.isArray(result)) return result
  const rows = (result as { rows?: unknown }).rows
  return Array.isArray(rows) ? rows : []
}
