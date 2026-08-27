import { and, eq, sql, type SQL } from 'drizzle-orm'
import {
  assertValidCreditAmount,
  CreditError,
  CreditErrorCode,
  sameAmount,
  type CreditSource,
  type PortableReservation,
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
): Promise<PortableReservation | null> {
  const rows = await tx
    .select()
    .from(creditReservations)
    .where(and(eq(creditReservations.userId, userId), eq(creditReservations.id, reservationId)))
    .limit(1)
    .for('update')
  return rows[0] ? toReservation(rows[0]) : null
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

/** Narrow a non-`reserved` status for the `already_terminal` outcomes. */
export function terminalStatusOf(reservation: PortableReservation): TerminalReservationStatus {
  return reservation.status as TerminalReservationStatus
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
    total: balance + bonusCredits,
  }
}

export interface JournalWriteInput {
  userId: string
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
