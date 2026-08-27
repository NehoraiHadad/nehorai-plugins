/**
 * Minimal structural type for a Drizzle database or transaction handle.
 *
 * Kept structural (rather than importing a concrete `PgDatabase`) so the
 * adapter works across drizzle-orm minor versions and driver flavours.
 */
export interface DrizzleLikeDB {
  select: (...args: any[]) => any
  insert: (...args: any[]) => any
  update: (...args: any[]) => any
  execute?: (...args: any[]) => any
  transaction?: <T>(callback: (tx: DrizzleLikeDB) => Promise<T>) => Promise<T>
}

/**
 * Run `callback` inside a transaction when the handle supports one.
 *
 * A handle without `transaction` (already a `tx`, or a driver shim) runs the
 * callback directly — the caller is then responsible for the surrounding
 * transaction. V2 correctness depends on a real transaction being present:
 * see {@link assertTransactional}.
 */
export async function withTx<T>(
  db: DrizzleLikeDB,
  callback: (tx: DrizzleLikeDB) => Promise<T>
): Promise<T> {
  if (db.transaction) {
    return db.transaction(callback)
  }
  return callback(db)
}
