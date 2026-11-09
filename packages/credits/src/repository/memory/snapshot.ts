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
 * The copy is deep. Records nest objects (`metadata`, a commit's `lotDraws` and
 * `lotTotals`, a lot event's `reversal`), and a shallow copy handed the caller the
 * stored nested object: changing `result.reservation.lotTotals` changed what the
 * next read returned. Values are copied on the way in too ({@link detach}), so
 * nothing a caller passed or received is shared with the store, nor are two
 * stored records with each other. Stored values are plain data, as a database
 * row is, so `structuredClone` copies them exactly.
 */

/** A deep copy of a value crossing the storage boundary, in either direction. */
export function detach<T>(value: T): T {
  return structuredClone(value);
}

/** A detached copy of one stored record. */
export function copyRecord<T extends object>(record: T): T;
export function copyRecord<T extends object>(record: T | undefined): T | undefined;
export function copyRecord<T extends object>(record: T | undefined): T | undefined {
  if (!record) return undefined;
  return detach(record);
}

/** A detached copy of a list of stored records, and of the list itself. */
export function copyRecords<T extends object>(records: readonly T[]): T[] {
  return records.map((record) => copyRecord(record));
}
