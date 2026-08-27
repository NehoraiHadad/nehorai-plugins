import { and, eq, sql } from 'drizzle-orm'
import {
  CreditError,
  CreditErrorCode,
  type PortableReservation,
  type ReserveCreditsV2Input,
  type ReserveOutcome,
} from '@nehorai/credits'
import { creditBalances, creditReservations } from '../../schema/index.js'
import { withTx, type DrizzleLikeDB } from '../db.js'
import { ensureUserCredits } from '../ensure-user.js'
import { numberValue, toReservation } from '../mappers.js'
import { assertPositiveAmount, num } from './shared.js'

/**
 * Carries a non-exceptional outcome out of an aborted transaction.
 *
 * `insufficient` has to roll back (the reservation row was already inserted),
 * but it is a normal business result, not an error. Drizzle's own
 * `tx.rollback()` throws a control-flow exception with no payload, so we throw
 * this sentinel instead and unwrap it outside the transaction.
 */
class ReserveAbort {
  constructor(readonly outcome: ReserveOutcome) {}
}

/**
 * Idempotent, race-safe credit hold.
 *
 * One transaction does all of: create-or-recognise the reservation, and place
 * the guarded hold. The idempotency row and the hold therefore commit
 * together — there is no window where a key is claimed but no credits are
 * held, or vice versa.
 */
export async function reserveCreditsV2(
  db: DrizzleLikeDB,
  input: ReserveCreditsV2Input
): Promise<ReserveOutcome> {
  assertPositiveAmount(input.amount)

  try {
    return await withTx(db, async (tx) => {
      // Balance row first: `FOR UPDATE` cannot lock a row that does not exist,
      // and the guarded hold below needs something to lock.
      await ensureUserCredits(tx, input.userId)

      const insertResult = await insertReservation(tx, input)
      if (insertResult.outcome) return insertResult.outcome

      const reservation = insertResult.reservation
      // Guarded hold. The sufficiency predicate lives in WHERE so the check
      // and the increment are one statement: concurrent callers serialize on
      // the row lock and each re-evaluates against the committed balance.
      const held = await tx
        .update(creditBalances)
        .set({
          reserved: sql`${creditBalances.reserved} + ${num(input.amount)}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(creditBalances.userId, input.userId),
            sql`${creditBalances.balance} + ${creditBalances.bonusCredits} - ${creditBalances.reserved} >= ${num(input.amount)}`
          )
        )
        .returning()

      if (held[0]) {
        return { outcome: 'created', reservation } as const
      }

      // Not enough available: roll the reservation row back too, so a replay
      // of the same key is not permanently poisoned by a failed attempt.
      const current = await tx
        .select()
        .from(creditBalances)
        .where(eq(creditBalances.userId, input.userId))
        .limit(1)
      const row = current[0]
      const available = row
        ? numberValue(row.balance) + numberValue(row.bonusCredits) - numberValue(row.reserved)
        : 0
      throw new ReserveAbort({
        outcome: 'insufficient',
        available,
        required: input.amount,
        shortfall: input.amount - available,
      })
    })
  } catch (error) {
    if (error instanceof ReserveAbort) return error.outcome
    throw error
  }
}

/**
 * Insert the reservation, or resolve the replay/conflict case.
 *
 * `ON CONFLICT ... DO NOTHING` blocks on a concurrent inserter holding the
 * same key and returns no row once that transaction commits; the follow-up
 * SELECT then takes a fresh READ COMMITTED snapshot and sees the winner. That
 * is why this is a plain conflict clause and not a caught `23505` — a unique
 * violation would abort the whole transaction and force savepoint juggling.
 */
async function insertReservation(
  tx: DrizzleLikeDB,
  input: ReserveCreditsV2Input
): Promise<
  | { reservation: PortableReservation; outcome?: undefined }
  | { outcome: ReserveOutcome; reservation?: undefined }
> {
  const inserted = await tx
    .insert(creditReservations)
    .values({
      userId: input.userId,
      amount: String(input.amount),
      operationType: input.operationType,
      expiresAt: input.expiresAt,
      idempotencyKey: input.idempotencyKey ?? null,
    })
    .onConflictDoNothing({
      target: [creditReservations.userId, creditReservations.idempotencyKey],
      where: sql`idempotency_key is not null`,
    })
    .returning()

  if (inserted[0]) return { reservation: toReservation(inserted[0]) }

  const idempotencyKey = input.idempotencyKey
  if (!idempotencyKey) {
    // No key means no arbiter can match, so DO NOTHING cannot have fired.
    throw new CreditError(
      `Reservation insert returned no row for user ${input.userId}`,
      CreditErrorCode.DATABASE_ERROR,
      { userId: input.userId }
    )
  }

  const existingRows = await tx
    .select()
    .from(creditReservations)
    .where(
      and(
        eq(creditReservations.userId, input.userId),
        eq(creditReservations.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1)

  const existing = existingRows[0]
  if (!existing) {
    // The key holder rolled back between our INSERT and this SELECT. Retrying
    // is the correct response, so surface it as transient rather than guessing.
    throw new CreditError(
      `Idempotency key ${idempotencyKey} conflicted but no reservation was found`,
      CreditErrorCode.TRANSIENT_ERROR,
      { userId: input.userId, idempotencyKey }
    )
  }

  const reservation = toReservation(existing)
  // `expiresAt` is deliberately excluded: a retry legitimately computes a
  // later deadline and that must not read as a conflict.
  const samePayload =
    reservation.amount === input.amount && reservation.operationType === input.operationType
  return {
    outcome: samePayload
      ? { outcome: 'replayed', reservation }
      : { outcome: 'idempotency_conflict', idempotencyKey, existing: reservation },
  }
}
