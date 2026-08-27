import { sql } from 'drizzle-orm'
import { CreditError, CreditErrorCode } from '@nehorai/credits'

/**
 * Minimal structural type for a Drizzle database or transaction handle.
 *
 * Kept structural (rather than importing a concrete `PgDatabase`) so the
 * adapter works across drizzle-orm minor versions and driver flavours.
 *
 * `transaction` and `execute` are **required** for the V2 boundary: without
 * them there is no way to open a transaction or to prove one is open, and V2's
 * guarantees are exactly the guarantees a transaction provides. They stay
 * optional on the type because the legacy (non-V2) methods do not need them;
 * {@link assertTransactional} is what turns that into an enforced requirement.
 */
export interface DrizzleLikeDB {
  select: (...args: any[]) => any
  insert: (...args: any[]) => any
  update: (...args: any[]) => any
  execute?: (...args: any[]) => any
  transaction?: <T>(callback: (tx: DrizzleLikeDB) => Promise<T>) => Promise<T>
}

/**
 * Reject a handle that cannot open a transaction, before anything is written.
 *
 * Note what this deliberately does *not* do: infer "already inside a
 * transaction" from a missing `transaction` method. A Drizzle transaction
 * handle also exposes `transaction`, where it opens a SAVEPOINT rather than a
 * nested BEGIN — so passing an open `tx` is supported, explicitly and by the
 * same code path, and gets real partial-rollback semantics. A handle with no
 * `transaction` at all is a shim or a mock, and the only honest thing to do
 * with it is refuse.
 */
export function assertTransactional(db: DrizzleLikeDB): void {
  if (typeof db.transaction !== 'function') {
    throw new CreditError(
      'This database handle cannot open a transaction, so the V2 credit ' +
        'boundary cannot run on it. Pass a Drizzle database or an open ' +
        'transaction (which opens a SAVEPOINT).',
      CreditErrorCode.UNSUPPORTED_OPERATION,
      { reason: 'missing_transaction_support' }
    )
  }
  if (typeof db.execute !== 'function') {
    throw new CreditError(
      'This database handle cannot execute raw SQL, so the V2 credit ' +
        'boundary cannot verify it is inside a transaction.',
      CreditErrorCode.UNSUPPORTED_OPERATION,
      { reason: 'missing_execute' }
    )
  }
}

/** Value the probe asks the server to echo back. */
const TX_PROBE_TOKEN = 'credits_v2_tx_probe_ok'

/** SQLSTATE for "SAVEPOINT can only be used in transaction blocks". */
const NO_ACTIVE_TRANSACTION = '25P01'

/** Best-effort SQLSTATE off a driver error, or `undefined` if it carries none. */
function sqlStateOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Did a real server answer the probe?
 *
 * A stub `execute` that resolves with nothing would otherwise sail through
 * every statement-only check. Requiring the echoed token back turns "the call
 * did not throw" into "a database actually ran this", which is the weaker but
 * honest guarantee available here.
 */
function probeAnswered(result: unknown): boolean {
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown } | null)?.rows
  if (!Array.isArray(rows)) return false
  return rows.some(
    (row) =>
      row !== null &&
      typeof row === 'object' &&
      Object.values(row as Record<string, unknown>).some((value) => value === TX_PROBE_TOKEN)
  )
}

/**
 * Prove — not assume — that the handle is inside a transaction block.
 *
 * `SAVEPOINT` is the probe because PostgreSQL rejects it outside a transaction
 * block with SQLSTATE 25P01, and accepts it inside one. Nothing weaker
 * distinguishes the two cases: `transaction_timestamp()`, `SHOW
 * transaction_isolation` and friends all answer identically in autocommit,
 * where each statement is its own implicit transaction. A `transaction()`
 * method that silently degraded to running the callback on the pool — the
 * exact failure this guards against — is caught here, before the first write.
 *
 * The savepoint is released immediately, so no subtransaction is left open and
 * the enclosing transaction keeps its own XID.
 *
 * Two failure modes are deliberately kept apart. Only 25P01 (or an error with
 * no SQLSTATE at all, which is what a hand-rolled shim throws) means "there is
 * no transaction here"; any other SQLSTATE — 25P02 from an already-aborted
 * transaction, a connection drop mid-probe — is a different problem, and is
 * rethrown unchanged so the boundary's error classifier can label it honestly
 * rather than blaming the caller's handle.
 *
 * What this cannot do: a fake handle that faithfully impersonates a PostgreSQL
 * server — accepting the savepoint and echoing the token — passes. No probe
 * distinguishes that from the real thing. The guarantee is "a database ran
 * this, inside a transaction block", not "the object is trustworthy".
 */
export async function assertInTransaction(tx: DrizzleLikeDB): Promise<void> {
  if (typeof tx.execute !== 'function') {
    throw new CreditError(
      'Transaction handle cannot execute raw SQL, so it cannot be verified.',
      CreditErrorCode.UNSUPPORTED_OPERATION,
      { reason: 'missing_execute' }
    )
  }

  let answered: unknown
  try {
    await tx.execute(sql`savepoint credits_v2_tx_probe`)
    answered = await tx.execute(sql`select ${TX_PROBE_TOKEN} as credits_v2_tx_probe`)
    await tx.execute(sql`release savepoint credits_v2_tx_probe`)
  } catch (error) {
    const sqlState = sqlStateOf(error)
    if (sqlState !== undefined && sqlState !== NO_ACTIVE_TRANSACTION) throw error
    throw new CreditError(
      'The V2 credit boundary is not running inside a real transaction. ' +
        'Its atomicity guarantees would not hold, so the operation was ' +
        'refused before any write.',
      CreditErrorCode.UNSUPPORTED_OPERATION,
      { reason: 'no_active_transaction', sqlState, cause: String(error) }
    )
  }

  if (!probeAnswered(answered)) {
    throw new CreditError(
      'The V2 credit boundary could not confirm a database answered its ' +
        'transaction probe, so the operation was refused before any write.',
      CreditErrorCode.UNSUPPORTED_OPERATION,
      { reason: 'probe_not_answered' }
    )
  }
}

/**
 * Run `callback` inside a proven transaction.
 *
 * Always goes through `db.transaction`: on a root database that is a BEGIN, on
 * an already-open transaction it is a SAVEPOINT. The savepoint case is the
 * important one — when the caller owns the outer transaction, a throw from
 * `callback` must still undo this operation's writes, and only a real
 * subtransaction does that. Without it, an adapter error the caller catches
 * would leave a half-applied transition (status flipped, balance untouched) to
 * be committed by the outer transaction.
 */
export async function withTx<T>(
  db: DrizzleLikeDB,
  callback: (tx: DrizzleLikeDB) => Promise<T>
): Promise<T> {
  assertTransactional(db)
  return db.transaction!(async (tx) => {
    await assertInTransaction(tx)
    return callback(tx)
  })
}
