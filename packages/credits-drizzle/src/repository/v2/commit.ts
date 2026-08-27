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
  assertTrustworthyReservation,
  balanceAfter,
  invariantViolation,
  lockReservation,
  publicReservation,
  num,
  rejectOverflowAsAmountError,
  readReservation,
  reservedCoversHold,
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
  // `monthlyUsed + amount` is the one column this transition grows: every other
  // balance write below only shrinks, under a WHERE that already proves the
  // result stays non-negative. A month's usage past what the column holds
  // arrives as SQLSTATE 22003, while the in-memory adapter refuses the identical
  // commit with INVALID_AMOUNT — this makes the two agree, field included.
  return rejectOverflowAsAmountError(userId, 'commitReservation', ['monthlyUsed'], () =>
    commitInTransaction(db, userId, reservationId, options)
  )
}

/** The transaction itself; see {@link commitReservationV2} for the boundary. */
async function commitInTransaction(
  db: DrizzleLikeDB,
  userId: string,
  reservationId: string,
  options?: ReservationTransitionOptions
): Promise<CommitOutcome> {
  return withTx(db, async (tx) => {
    const locked = await lockReservation(tx, userId, reservationId)
    if (!locked) return { outcome: 'not_found', reservationId }

    // Before the CAS, before any balance write, and before the terminal-status
    // exit. A stored amount that is negative, non-finite or off the cent grid
    // must stop the transition dead rather than be arithmetically "honoured"
    // into minted credits; a status outside the closed set must not be reported
    // as terminal; and a row with no hold-origin fact must not be spent at all,
    // because its `reserved >= amount` guard would pass on another hold's
    // coverage. All three run ahead of the early return because
    // `already_terminal` is a *success* outcome — reporting it over a corrupt
    // row tells the caller the reservation is fine, which is the one thing the
    // quarantine exists to refuse.
    assertTrustworthyReservation(locked, 'commit')

    if (locked.status !== 'reserved') {
      return {
        outcome: 'already_terminal',
        reservation: publicReservation(locked),
        terminalStatus: terminalStatusOf(locked, 'commit'),
      }
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
      return {
        outcome: 'already_terminal',
        reservation: current,
        terminalStatus: terminalStatusOf(current, 'commit'),
      }
    }
    const reservation = {
      ...publicReservation(locked),
      status: 'committed' as const,
      completedAt: new Date().toISOString(),
    }

    // Balance mutation is entirely expression-based: every right-hand side
    // reads the row's pre-update values inside PostgreSQL, so two commits for
    // two different reservations cannot overwrite each other with a stale
    // literal. `balance` drains before `bonusCredits`, matching deductCreditsAtomic.
    const moved = await tx
      .update(creditBalances)
      .set({
        balance: sql`greatest(${creditBalances.balance} - ${num(amount)}, 0::numeric)`,
        bonusCredits: sql`${creditBalances.bonusCredits} - greatest(${num(amount)} - ${creditBalances.balance}, 0::numeric)`,
        // No `greatest(..., 0)` floor here. Flooring would quietly absorb a
        // corrupt `reserved` counter by consuming other live holds' coverage;
        // the guard below refuses instead.
        reserved: sql`${creditBalances.reserved} - ${num(amount)}`,
        monthlyUsed: sql`${creditBalances.monthlyUsed} + ${num(amount)}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(creditBalances.userId, userId),
          reservedCoversHold(amount),
          sql`${creditBalances.balance} + ${creditBalances.bonusCredits} >= ${num(amount)}`
        )
      )
      .returning()

    if (!moved[0]) {
      // Either the funds went away under the hold, or `reserved` no longer
      // covers it. Both roll the CAS back, leaving the reservation `reserved`
      // rather than committed-but-unpaid — but they are different bugs, so
      // read the row to say which, and report them as different errors.
      throw await explainFailedDebit(tx, userId, reservationId, amount)
    }

    const after = balanceAfter(moved[0])
    const journalEntryId = await writeTransitionJournal(tx, {
      userId,
      operation: 'commitReservation',
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
      // Caller metadata first: the deterministic fields are what the journal
      // collision check compares on, so they must not be overwritable by a
      // caller who happens to send an `operationType` of their own.
      metadata: { ...options?.metadata, operationType: locked.operationType, amount },
      idempotencyKey: reservationJournalKey(reservationId, 'commit'),
    })

    return { outcome: 'committed', reservation, amount, balanceAfter: after.total, journalEntryId }
  })
}

/**
 * Turn a zero-row balance update into the error that actually describes it.
 *
 * Insufficient funds is a business outcome the caller can act on; a `reserved`
 * counter that no longer covers its own hold is ledger corruption and must not
 * be reported as "the user is short on credits".
 */
async function explainFailedDebit(
  tx: DrizzleLikeDB,
  userId: string,
  reservationId: string,
  amount: number
): Promise<CreditError> {
  const rows = await tx
    .select()
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .limit(1)

  const row = rows[0]
  if (!row) {
    return invariantViolation(userId, reservationId, amount, 'balance row is missing')
  }

  const after = balanceAfter(row)
  if (after.reserved < amount) {
    return invariantViolation(
      userId,
      reservationId,
      amount,
      `reserved (${after.reserved}) is less than the hold being committed (${amount})`
    )
  }
  return new CreditError(
    `Insufficient credits to commit reservation ${reservationId}`,
    CreditErrorCode.INSUFFICIENT_CREDITS,
    { userId, reservationId, required: amount, available: after.total }
  )
}
