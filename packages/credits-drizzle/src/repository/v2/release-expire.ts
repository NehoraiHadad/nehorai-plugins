import { and, eq, lte } from 'drizzle-orm'
import {
  getOperationLabel,
  reservationJournalKey,
  type ExpireOutcome,
  type ExpireReservationV2Options,
  type ReleaseOutcome,
  type ReservationTransitionOptions,
} from '@nehorai/credits'
import { creditBalances, creditReservations } from '../../schema/index.js'
import { withTx, type DrizzleLikeDB } from '../db.js'
import {
  balanceAfter,
  invariantViolation,
  lockReservation,
  readReservation,
  releaseHold,
  terminalStatusOf,
  writeTransitionJournal,
} from './shared.js'

/**
 * Hand a hold back unspent. Same shape as commit: lock, CAS, balance, journal.
 *
 * A release that loses to a concurrent commit reports `already_terminal` with
 * `terminalStatus: 'committed'` — it does not undo the commit and does not
 * pretend to have succeeded.
 */
export async function releaseReservationV2(
  db: DrizzleLikeDB,
  userId: string,
  reservationId: string,
  options?: ReservationTransitionOptions
): Promise<ReleaseOutcome> {
  return withTx(db, async (tx) => {
    const locked = await lockReservation(tx, userId, reservationId)
    if (!locked) return { outcome: 'not_found', reservationId }
    if (locked.status !== 'reserved') {
      return { outcome: 'already_terminal', reservation: locked, terminalStatus: terminalStatusOf(locked) }
    }

    const casRows = await tx
      .update(creditReservations)
      .set({ status: 'released', completedAt: new Date() })
      .where(
        and(
          eq(creditReservations.userId, userId),
          eq(creditReservations.id, reservationId),
          eq(creditReservations.status, 'reserved')
        )
      )
      .returning()

    if (!casRows[0]) return terminalFallback(tx, userId, reservationId)

    const journalEntryId = await finishUnspentTransition(tx, {
      userId,
      reservationId,
      amount: locked.amount,
      operationType: locked.operationType,
      source: 'operation_release',
      transition: 'release',
      verb: 'Released',
      options,
    })

    return {
      outcome: 'released',
      reservation: { ...locked, status: 'released', completedAt: new Date().toISOString() },
      amount: locked.amount,
      journalEntryId,
    }
  })
}

/**
 * Expire a hold whose deadline has passed.
 *
 * The deadline is part of the CAS predicate, so the sweep can never expire a
 * reservation that is still legitimately in flight, and it is one transaction
 * end to end — never "release, then overwrite the status to expired".
 */
export async function expireReservationV2(
  db: DrizzleLikeDB,
  userId: string,
  reservationId: string,
  options?: ExpireReservationV2Options
): Promise<ExpireOutcome> {
  const asOf = options?.asOf ?? new Date()
  return withTx(db, async (tx) => {
    const locked = await lockReservation(tx, userId, reservationId)
    if (!locked) return { outcome: 'not_found', reservationId }
    if (locked.status !== 'reserved') {
      return { outcome: 'already_terminal', reservation: locked, terminalStatus: terminalStatusOf(locked) }
    }
    if (new Date(locked.expiresAt) > asOf) return { outcome: 'not_due', reservation: locked }

    const casRows = await tx
      .update(creditReservations)
      .set({ status: 'expired', completedAt: new Date() })
      .where(
        and(
          eq(creditReservations.userId, userId),
          eq(creditReservations.id, reservationId),
          eq(creditReservations.status, 'reserved'),
          lte(creditReservations.expiresAt, asOf)
        )
      )
      .returning()

    if (!casRows[0]) {
      const current = await readReservation(tx, userId, reservationId)
      if (!current) return { outcome: 'not_found', reservationId }
      if (current.status === 'reserved') return { outcome: 'not_due', reservation: current }
      return { outcome: 'already_terminal', reservation: current, terminalStatus: terminalStatusOf(current) }
    }

    const journalEntryId = await finishUnspentTransition(tx, {
      userId,
      reservationId,
      amount: locked.amount,
      operationType: locked.operationType,
      source: 'reservation_expired',
      transition: 'expire',
      verb: 'Expired',
      options,
    })

    return {
      outcome: 'expired',
      reservation: { ...locked, status: 'expired', completedAt: new Date().toISOString() },
      amount: locked.amount,
      journalEntryId,
    }
  })
}

async function terminalFallback(
  tx: DrizzleLikeDB,
  userId: string,
  reservationId: string
): Promise<ReleaseOutcome> {
  const current = await readReservation(tx, userId, reservationId)
  if (!current) return { outcome: 'not_found', reservationId }
  return { outcome: 'already_terminal', reservation: current, terminalStatus: terminalStatusOf(current) }
}

interface UnspentTransition {
  userId: string
  reservationId: string
  amount: number
  operationType: string
  source: 'operation_release' | 'reservation_expired'
  transition: 'release' | 'expire'
  verb: string
  options?: ReservationTransitionOptions
}

/**
 * Drop the hold and journal it.
 *
 * The journal `amount` is 0 because no credits changed hands — the reserved
 * amount only moves back into "available". The original hold size is kept in
 * metadata, matching the legacy release entry's shape.
 */
async function finishUnspentTransition(
  tx: DrizzleLikeDB,
  input: UnspentTransition
): Promise<string> {
  const after = await releaseHold(tx, input.userId, input.amount)
  if (!after) {
    // `releaseHold` refuses when `reserved` does not cover the hold, so that
    // handing this one back cannot manufacture availability other holds never
    // paid for. Distinguish that from a missing user before reporting.
    throw await explainFailedRelease(tx, input.userId, input.reservationId, input.amount)
  }
  return writeTransitionJournal(tx, {
    userId: input.userId,
    entryType: 'credit',
    amount: 0,
    balanceAfter: after.total,
    source: input.source,
    reservationId: input.reservationId,
    description:
      input.options?.description ??
      `${input.verb} ${input.amount} reserved credits for ${getOperationLabel(input.operationType)}`,
    metadata: {
      operationType: input.operationType,
      amount: input.amount,
      ...input.options?.metadata,
    },
    idempotencyKey: reservationJournalKey(input.reservationId, input.transition),
  })
}

/** Say whether a refused hand-back was a missing row or a broken invariant. */
async function explainFailedRelease(
  tx: DrizzleLikeDB,
  userId: string,
  reservationId: string,
  amount: number
): Promise<Error> {
  const rows = await tx
    .select()
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .limit(1)

  const row = rows[0]
  if (!row) {
    return invariantViolation(userId, reservationId, amount, 'balance row is missing')
  }
  return invariantViolation(
    userId,
    reservationId,
    amount,
    `reserved (${balanceAfter(row).reserved}) is less than the hold being returned (${amount})`
  )
}
