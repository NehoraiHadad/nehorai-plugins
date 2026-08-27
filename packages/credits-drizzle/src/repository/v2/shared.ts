import { and, eq, sql, type SQL } from 'drizzle-orm'
import {
  CreditError,
  CreditErrorCode,
  createInvalidAmountError,
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

/** Reject amounts that would corrupt the ledger before any row is touched. */
export function assertPositiveAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw createInvalidAmountError(amount)
  }
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
 * Release a hold without spending it (release / expire).
 *
 * `greatest(..., 0)` is a floor against legacy rows whose `reserved` counter
 * already drifted below the hold; it must never make the column negative.
 */
export async function releaseHold(
  tx: DrizzleLikeDB,
  userId: string,
  amount: number
): Promise<BalanceAfter | null> {
  const rows = await tx
    .update(creditBalances)
    .set({
      reserved: sql`greatest(${creditBalances.reserved} - ${num(amount)}, 0::numeric)`,
      updatedAt: new Date(),
    })
    .where(eq(creditBalances.userId, userId))
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
 * `(user_id, idempotency_key)`. Winning the status CAS should already
 * guarantee no entry exists, so a conflict means either a retry that raced
 * before the CAS landed or ledger corruption — we re-read and only accept the
 * existing row when it describes the same event.
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
  if (!row || row.referenceId !== input.reservationId || row.source !== input.source) {
    throw new CreditError(
      `Journal key ${input.idempotencyKey} is already used by a different entry`,
      CreditErrorCode.DATABASE_ERROR,
      { idempotencyKey: input.idempotencyKey, reservationId: input.reservationId }
    )
  }
  return row.id
}
