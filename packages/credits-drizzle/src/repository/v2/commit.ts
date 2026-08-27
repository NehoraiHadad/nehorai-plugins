import { and, eq, sql } from 'drizzle-orm'
import {
  CreditError,
  CreditErrorCode,
  getOperationLabel,
  reservationJournalKey,
  type CommitOutcome,
  type ReservationTransitionOptions,
} from '@nehorai/credits'
import { creditBalances, creditReservations } from '../../schema/index.js'
import { withTx, type DrizzleLikeDB } from '../db.js'
import {
  balanceAfter,
  lockReservation,
  num,
  readReservation,
  terminalStatusOf,
  writeTransitionJournal,
} from './shared.js'

/**
 * Spend a hold. Exactly one concurrent caller wins.
 *
 * Order inside the single transaction: lock the reservation, compare-and-set
 * its status, mutate the balance with column expressions, write one journal
 * entry. Everything after the CAS only ever runs for the winner, so the
 * balance can move at most once and the ledger gains at most one row.
 *
 * No callback or network call happens in here — the caller fires those after
 * the transaction has committed.
 */
export async function commitReservationV2(
  db: DrizzleLikeDB,
  userId: string,
  reservationId: string,
  options?: ReservationTransitionOptions
): Promise<CommitOutcome> {
  return withTx(db, async (tx) => {
    const locked = await lockReservation(tx, userId, reservationId)
    if (!locked) return { outcome: 'not_found', reservationId }
    if (locked.status !== 'reserved') {
      return { outcome: 'already_terminal', reservation: locked, terminalStatus: terminalStatusOf(locked) }
    }

    const amount = locked.amount
    const casRows = await tx
      .update(creditReservations)
      .set({ status: 'committed', completedAt: new Date() })
      .where(
        and(
          eq(creditReservations.userId, userId),
          eq(creditReservations.id, reservationId),
          eq(creditReservations.status, 'reserved')
        )
      )
      .returning()

    if (!casRows[0]) {
      // Unreachable while we hold FOR UPDATE, but a handle whose `transaction`
      // silently degraded to a no-op would land here. Report the truth.
      const current = await readReservation(tx, userId, reservationId)
      if (!current) return { outcome: 'not_found', reservationId }
      return { outcome: 'already_terminal', reservation: current, terminalStatus: terminalStatusOf(current) }
    }
    const reservation = { ...locked, status: 'committed' as const, completedAt: new Date().toISOString() }

    // Balance mutation is entirely expression-based: every right-hand side
    // reads the row's pre-update values inside PostgreSQL, so two commits for
    // two different reservations cannot overwrite each other with a stale
    // literal. `balance` drains before `bonusCredits`, matching deductCreditsAtomic.
    const moved = await tx
      .update(creditBalances)
      .set({
        balance: sql`greatest(${creditBalances.balance} - ${num(amount)}, 0::numeric)`,
        bonusCredits: sql`${creditBalances.bonusCredits} - greatest(${num(amount)} - ${creditBalances.balance}, 0::numeric)`,
        reserved: sql`greatest(${creditBalances.reserved} - ${num(amount)}, 0::numeric)`,
        monthlyUsed: sql`${creditBalances.monthlyUsed} + ${num(amount)}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(creditBalances.userId, userId),
          sql`${creditBalances.balance} + ${creditBalances.bonusCredits} >= ${num(amount)}`
        )
      )
      .returning()

    if (!moved[0]) {
      // The hold no longer has funds behind it (balance was adjusted out from
      // under it). Throwing rolls back the CAS as well, leaving the
      // reservation reserved rather than committed-but-unpaid.
      throw new CreditError(
        `Insufficient credits to commit reservation ${reservationId}`,
        CreditErrorCode.INSUFFICIENT_CREDITS,
        { userId, reservationId, required: amount }
      )
    }

    const after = balanceAfter(moved[0])
    const journalEntryId = await writeTransitionJournal(tx, {
      userId,
      entryType: 'debit',
      amount,
      // Read from the UPDATE's RETURNING row, never from an earlier SELECT: a
      // SELECT taken before the row lock would record another commit's balance.
      balanceAfter: after.total,
      source: 'operation_commit',
      reservationId,
      description:
        options?.description ??
        `Committed ${amount} credits for ${getOperationLabel(locked.operationType)}`,
      metadata: { operationType: locked.operationType, ...options?.metadata },
      idempotencyKey: reservationJournalKey(reservationId, 'commit'),
    })

    return { outcome: 'committed', reservation, amount, balanceAfter: after.total, journalEntryId }
  })
}
