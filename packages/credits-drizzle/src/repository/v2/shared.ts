import { and, eq, sql, type SQL } from 'drizzle-orm'
import {
  assertHoldPlaced,
  assertKnownReservationStatus,
  assertRepresentableAmount,
  assertValidCreditAmount,
  assertValidStoredAmountRaw,
  classifyDatabaseError,
  CreditError,
  CreditErrorCode,
  getSqlState,
  sameAmount,
  terminalStatusOf as narrowTerminalStatus,
  type CreditSource,
  type PortableReservation,
  sumAmounts,
  type TerminalReservationStatus,
} from '@nehorai/credits'
import { creditBalances, creditJournalEntries, creditReservations } from '../../schema/index.js'
import type { DrizzleLikeDB } from '../db.js'
import { numberValue, toReservation } from '../mappers.js'

/**
 * Bind a credit amount as an exact `numeric` parameter.
 *
 * Sending the value as a text parameter with an explicit cast keeps arithmetic
 * in PostgreSQL's exact `numeric` domain. Binding a JS `number` instead would
 * let the planner resolve the parameter as `double precision` and reintroduce
 * binary-float rounding into a money column.
 */
export function num(amount: number): SQL {
  return sql`${String(amount)}::numeric`
}

/**
 * Reject amounts the ledger cannot represent, before any row is touched.
 *
 * Delegates to the core validator so a `numeric(12, 2)` column, the in-memory
 * adapter, and any third-party repository all agree on what is spendable.
 */
export function assertPositiveAmount(amount: number, context?: Record<string, unknown>): void {
  assertValidCreditAmount(amount, context)
}

/**
 * Re-validate the amount this transition just locked, before it changes anything.
 *
 * The row was written once and is read back on every transition, and nothing
 * stops a direct SQL write or an older client from leaving a value the
 * invariants cannot reason about. A negative amount is the dangerous one:
 * `reserved >= -10` is trivially true and `balance - (-10)` *adds* credits, so
 * a commit that trusts the stored value mints money out of a corrupt row. This
 * runs after the `FOR UPDATE` and before the status CAS, so a refusal leaves
 * the reservation and the balance exactly as they were.
 */
/**
 * A locked reservation, carrying the amount as storage returned it.
 *
 * `PortableReservation.amount` is a JS number, and the conversion that produces
 * it silently rounds anything the column was able to hold but a double is not:
 * an unconstrained `numeric` row of `9999999999.9900001` maps to a valid-looking
 * `9999999999.99`. Validating the mapped value therefore cannot detect the very
 * corruption it exists to catch, so the original travels alongside it.
 */
export type LockedReservation = PortableReservation & {
  /** Exactly what the driver returned for `amount`, before any conversion. */
  readonly rawAmount: unknown
}

/** Drop the internal raw field before a reservation crosses the public API. */
export function publicReservation(locked: LockedReservation): PortableReservation {
  const { rawAmount: _rawAmount, ...reservation } = locked
  return reservation
}

/**
 * Refuse a transition whose stored amount cannot be trusted.
 *
 * Validates the *stored* representation, then pins the mapped number to the
 * exact value that representation denotes — so nothing downstream can be
 * working from a rounded figure that the database will not agree with.
 */
export function assertLockedAmount(
  reservation: LockedReservation,
  transition: string
): asserts reservation is LockedReservation & { amount: number } {
  const exact = assertValidStoredAmountRaw(reservation.rawAmount, {
    userId: reservation.userId,
    reservationId: reservation.id,
    transition,
  })
  ;(reservation as { amount: number }).amount = exact
}

/**
 * Lock a reservation row for the duration of the transaction.
 *
 * This is the *first* lock every V2 transition takes; the balance row is
 * always second. A single global order is what keeps concurrent
 * commit/release/expire on the same user from deadlocking.
 *
 * Under READ COMMITTED a blocked `FOR UPDATE` re-reads the winning
 * transaction's committed row version, so the loser observes the terminal
 * status rather than a stale `reserved`.
 */
export async function lockReservation(
  tx: DrizzleLikeDB,
  userId: string,
  reservationId: string
): Promise<LockedReservation | null> {
  const rows = await tx
    .select()
    .from(creditReservations)
    .where(and(eq(creditReservations.userId, userId), eq(creditReservations.id, reservationId)))
    .limit(1)
    .for('update')
  return rows[0] ? { ...toReservation(rows[0]), rawAmount: rows[0].amount } : null
}

/** Re-read a reservation without locking (already locked in this transaction). */
export async function readReservation(
  tx: DrizzleLikeDB,
  userId: string,
  reservationId: string
): Promise<PortableReservation | null> {
  const rows = await tx
    .select()
    .from(creditReservations)
    .where(and(eq(creditReservations.userId, userId), eq(creditReservations.id, reservationId)))
    .limit(1)
  return rows[0] ? toReservation(rows[0]) : null
}

/**
 * Narrow a non-`reserved` status for the `already_terminal` outcomes.
 *
 * Validates against the closed set instead of casting. The cast this replaces
 * turned any string the column happened to hold into a
 * `TerminalReservationStatus`, so a row whose `status` had been set to
 * `'gremlin'` by a direct UPDATE came back as `already_terminal` — a *success*
 * outcome asserting the reservation was resolved. `credit_reservations_status_valid`
 * is a `NOT VALID` CHECK that existing rows were never scanned against, so the
 * database does not rule this out either.
 */
export function terminalStatusOf(
  reservation: PortableReservation,
  transition: string
): TerminalReservationStatus {
  return narrowTerminalStatus(reservation, transition)
}

/**
 * Every check a locked reservation must pass before the transition proceeds.
 *
 * Runs after `FOR UPDATE` and before the status CAS, and ahead of the
 * `already_terminal` / `not_due` early exits — those are success outcomes, and
 * reporting one over a corrupt or unbacked row tells the caller the reservation
 * is fine, which is the single thing the quarantine exists to refuse. A refusal
 * here leaves the reservation and the balance exactly as they were.
 */
export function assertTrustworthyReservation(
  locked: LockedReservation,
  transition: string
): asserts locked is LockedReservation & { amount: number } {
  assertKnownReservationStatus(locked, transition)
  assertLockedAmount(locked, transition)
  assertHoldPlaced(locked, transition)
}

export interface BalanceAfter {
  balance: number
  bonusCredits: number
  reserved: number
  /** `balance + bonusCredits` — what the journal records. */
  total: number
}

/**
 * The invariant every transition's balance update must satisfy.
 *
 * `reserved >= amount` is the load-bearing clause. The obvious alternative —
 * `greatest(reserved - amount, 0)` — looks defensive but silently *destroys*
 * other holds: if `reserved` has drifted below this hold's amount, flooring at
 * zero also erases the credits other live reservations were counting on, and
 * those commits then fail or overdraw. Failing this transition and rolling
 * back keeps the corruption contained and visible.
 */
export function reservedCoversHold(amount: number): SQL {
  return sql`${creditBalances.reserved} >= ${num(amount)}`
}

/** Raised when a balance row cannot satisfy a transition's invariants. */
export function invariantViolation(
  userId: string,
  reservationId: string,
  amount: number,
  detail: string
): CreditError {
  return new CreditError(
    `Credit balance invariant violated for user ${userId} while processing ` +
      `reservation ${reservationId}: ${detail}. The transition was rolled back.`,
    CreditErrorCode.DATABASE_ERROR,
    { userId, reservationId, amount, detail }
  )
}

/**
 * Release a hold without spending it (release / expire).
 *
 * Guarded by {@link reservedCoversHold} for the same reason commit is: giving
 * back more than was held would manufacture availability that no reservation
 * ever paid for.
 */
export async function releaseHold(
  tx: DrizzleLikeDB,
  userId: string,
  amount: number
): Promise<BalanceAfter | null> {
  const rows = await tx
    .update(creditBalances)
    .set({
      reserved: sql`${creditBalances.reserved} - ${num(amount)}`,
      updatedAt: new Date(),
    })
    .where(and(eq(creditBalances.userId, userId), reservedCoversHold(amount)))
    .returning()
  return rows[0] ? balanceAfter(rows[0]) : null
}

export function balanceAfter(row: {
  balance: unknown
  bonusCredits: unknown
  reserved: unknown
}): BalanceAfter {
  const balance = numberValue(row.balance)
  const bonusCredits = numberValue(row.bonusCredits)
  return {
    balance,
    bonusCredits,
    reserved: numberValue(row.reserved),
    // `sumAmounts`, not `+`: this total is validated against the cent grid
    // before the journal row is written, and a float sum of two legal
    // balances (0.10 and 0.20) lands off it and refuses a legal transition.
    total: sumAmounts(balance, bonusCredits),
  }
}

export interface JournalWriteInput {
  userId: string
  /** The transition writing this entry, so a refusal names what was refused. */
  operation: string
  entryType: 'debit' | 'credit'
  amount: number
  balanceAfter: number
  source: CreditSource
  reservationId: string
  description: string
  metadata?: Record<string, unknown>
  idempotencyKey: string
}

/**
 * Write the single journal entry for a transition, inside the caller's transaction.
 *
 * The insert is guarded by the journal's partial unique index on
 * `(user_id, idempotency_key)`. Winning the status CAS already guarantees no
 * entry exists for this transition, so a conflict means either a retry that
 * raced before the CAS landed — in which case the existing row describes the
 * *identical* event — or ledger corruption. Anything short of an exact match
 * is treated as corruption and rolls the transition back, because accepting a
 * mismatched row would report a charge that the ledger does not actually
 * record.
 */
export async function writeTransitionJournal(
  tx: DrizzleLikeDB,
  input: JournalWriteInput
): Promise<string> {
  // Both are `numeric(12, 2)`. `amount` is legitimately 0 for a release entry
  // and `balanceAfter` is legitimately negative for a corrected account, so
  // these are checked for representability, not for spendability.
  const context = {
    userId: input.userId,
    reservationId: input.reservationId,
    operation: input.operation,
  }
  assertRepresentableAmount(input.amount, 'journal amount', context)
  assertRepresentableAmount(input.balanceAfter, 'journal balanceAfter', context)

  const inserted = await tx
    .insert(creditJournalEntries)
    .values({
      userId: input.userId,
      entryType: input.entryType,
      amount: String(input.amount),
      balanceAfter: String(input.balanceAfter),
      source: input.source,
      referenceId: input.reservationId,
      referenceType: 'reservation',
      description: input.description,
      metadata: input.metadata,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({
      target: [creditJournalEntries.userId, creditJournalEntries.idempotencyKey],
      where: sql`idempotency_key is not null`,
    })
    .returning()

  if (inserted[0]) return inserted[0].id

  const existing = await tx
    .select()
    .from(creditJournalEntries)
    .where(
      and(
        eq(creditJournalEntries.userId, input.userId),
        eq(creditJournalEntries.idempotencyKey, input.idempotencyKey)
      )
    )
    .limit(1)

  const row = existing[0]
  const mismatch = row ? describeJournalMismatch(row, input) : 'no row found for the key'
  if (mismatch) {
    throw new CreditError(
      `Journal key ${input.idempotencyKey} is already used by a different entry ` +
        `(${mismatch}). The transition was rolled back rather than reported as applied.`,
      CreditErrorCode.DATABASE_ERROR,
      { idempotencyKey: input.idempotencyKey, reservationId: input.reservationId, mismatch }
    )
  }
  return row!.id
}

/**
 * Name the first field on which an existing journal row disagrees, or `null`.
 *
 * Amounts are compared as exact cents rather than as floats: the row comes back
 * from `numeric` as a string, and parsing both sides to an integer number of
 * cents is the only comparison that neither loses precision nor invents a
 * mismatch out of representation noise.
 */
function describeJournalMismatch(
  row: Record<string, unknown>,
  input: JournalWriteInput
): string | null {
  if (row.userId !== input.userId) return 'user_id'
  if (row.entryType !== input.entryType) return 'entry_type'
  if (!sameAmount(row.amount, input.amount)) return 'amount'
  if (!sameAmount(row.balanceAfter, input.balanceAfter)) return 'balance_after'
  if (row.source !== input.source) return 'source'
  if (row.referenceId !== input.reservationId) return 'reference_id'
  if (row.referenceType !== 'reservation') return 'reference_type'

  // Metadata is compared only on the fields this adapter sets deterministically.
  // Caller-supplied extras are free-form and may legitimately differ between a
  // request and its retry, so they are not part of the identity of the event.
  const existingMeta = (row.metadata ?? {}) as Record<string, unknown>
  const expectedMeta = (input.metadata ?? {}) as Record<string, unknown>
  if (existingMeta.operationType !== expectedMeta.operationType) return 'metadata.operationType'

  // Presence is compared before value, in both directions. Checking only the
  // expected side would accept a stored row that records a hold size this
  // transition does not — exactly the mismatch that must not be waved through.
  const hadAmount = existingMeta.amount !== undefined
  const wantsAmount = expectedMeta.amount !== undefined
  if (hadAmount !== wantsAmount) return 'metadata.amount'
  if (wantsAmount && !sameAmount(existingMeta.amount, expectedMeta.amount)) return 'metadata.amount'
  return null
}

/**
 * Report a derived numeric overflow the way the in-memory adapter reports it.
 *
 * The balance mutations are expression-based on purpose — every right-hand side
 * reads the row's pre-update value inside PostgreSQL, so two concurrent
 * transitions cannot overwrite each other with a stale literal. The cost is
 * that a sum which does not fit `numeric(12, 2)` is discovered by PostgreSQL,
 * not by a JS guard, and arrives as SQLSTATE 22003. Left alone it surfaces as a
 * `DATABASE_ERROR`, while the in-memory adapter refuses the same transition
 * with `INVALID_AMOUNT` — the same ledger, two different error codes.
 *
 * `classifyDatabaseError` already maps 22003 to `INVALID_AMOUNT`; this adds the
 * context the caller needs to act. PostgreSQL does not name the expression that
 * overflowed, so this names the derived columns the statement writes: `field`
 * when the operation has exactly one, `fields` when it has several. Only 22003
 * is intercepted, so every other failure keeps the shape its own handler gave
 * it.
 */
export function overflowAsAmountError(
  error: unknown,
  userId: string,
  operation: string,
  fields: readonly string[]
): unknown {
  if (getSqlState(error) !== '22003') return error
  return classifyDatabaseError(error, {
    userId,
    operation,
    ...(fields.length === 1 ? { field: fields[0] } : { fields }),
  })
}

/** The `try`/`catch` form of {@link overflowAsAmountError}. */
export async function rejectOverflowAsAmountError<T>(
  userId: string,
  operation: string,
  fields: readonly string[],
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw overflowAsAmountError(error, userId, operation, fields)
  }
}
