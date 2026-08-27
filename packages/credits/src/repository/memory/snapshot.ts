/**
 * Copies at the boundary, so nothing stored is ever handed to a caller.
 *
 * A real adapter maps a database row into a fresh object every time. This one
 * used to return the object it had stored, which made it behave in ways no
 * production adapter does: a caller's earlier read mutated under them when a
 * later write landed, and a caller that adjusted a returned record corrupted
 * the store without going through any write path at all.
 *
 * That is not a theoretical difference. The service's monthly reset compared
 * the post-reset balance against the balance it had read moments earlier, got
 * zero because both were the same object, and silently skipped the reset's
 * journal entry — a bug that could not reproduce against the SQL adapter.
 *
 * `metadata` is copied one level deeper because it is the one field callers
 * routinely pass in and then keep a reference to.
 */

interface WithMetadata {
  metadata?: Record<string, unknown> | null;
}

/** A detached copy of one stored record. */
export function copyRecord<T extends object>(record: T): T;
export function copyRecord<T extends object>(record: T | undefined): T | undefined;
export function copyRecord<T extends object>(record: T | undefined): T | undefined {
  if (!record) return undefined;
  const copy = { ...record };
  const metadata = (record as WithMetadata).metadata;
  if (metadata && typeof metadata === "object") {
    (copy as WithMetadata).metadata = { ...metadata };
  }
  return copy;
}

/** A detached copy of a list of stored records, and of the list itself. */
export function copyRecords<T extends object>(records: readonly T[]): T[] {
  return records.map((record) => copyRecord(record));
}
