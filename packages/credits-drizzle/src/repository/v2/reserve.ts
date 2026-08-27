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
import { assertPositiveAmount, num, overflowAsAmountError } from './shared.js'
import {
  assertHoldPlaced,
  assertValidIdempotencyKey,
  sameAmount,
  sumAmounts,
} from '@nehorai/credits'

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
  assertPositiveAmount(input.amount, { userId: input.userId })
  // An empty or whitespace-only key would be stored — occupying a slot in the
  // partial unique index — while every `if (key)` check downstream reads it as
  // absent, so it would deduplicate nothing. Refuse instead of storing a key
  // that can never match.
  assertValidIdempotencyKey(input.idempotencyKey, { userId: input.userId })

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
        ? sumAmounts(
            numberValue(row.balance),
            numberValue(row.bonusCredits),
            -numberValue(row.reserved)
          )
        : 0
      throw new ReserveAbort({
        outcome: 'insufficient',
        available,
        required: input.amount,
        shortfall: sumAmounts(input.amount, -available),
      })
    })
  } catch (error) {
    if (error instanceof ReserveAbort) return error.outcome
    // `reserved + amount` is summed by PostgreSQL, so a hold that would push the
    // counter past what the column holds arrives as SQLSTATE 22003. The
    // in-memory adapter refuses the same input with INVALID_AMOUNT naming the
    // field; without this the two adapters disagree on both code and context.
    throw overflowAsAmountError(error, input.userId, 'reserveCredits', ['reserved'])
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
      // The hold-origin fact, written in the same transaction as the guarded
      // `reserved` increment below. Either both are visible or neither is, so
      // a row carrying it is proof that the hold behind it exists. Nothing else
      // in this package ever writes this column — see
      // `core/reservation-integrity.ts` in `@nehorai/credits`.
      holdPlacedAt: new Date(),
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
  // Before the payload comparison and before any outcome is chosen: only a row
  // whose own reserve placed the hold may be adopted as a replay. Without this,
  // a keyed row written by `createReservation` — which never touches
  // `reserved` — comes back as `replayed`, and the caller's commit then passes
  // its `reserved >= amount` guard on coverage belonging to a different,
  // genuine hold: two holds funded once.
  assertHoldPlaced(reservation, 'reserve replay')
  // `expiresAt` is deliberately excluded: a retry legitimately computes a
  // later deadline and that must not read as a conflict.
  //
  // The amount is compared against the *raw* stored `numeric`, not against the
  // mapped `Number`. A row widened by an older schema can hold
  // `9999999999.9900001`, which maps to `9999999999.99` — so a request for
  // that value matched a row that does not actually hold it, and the reserve
  // came back `replayed` against a payload the caller never made.
  // `sameAmount` refuses to equate anything off the cent grid, so the
  // mismatch surfaces as an idempotency conflict instead.
  const samePayload =
    sameAmount(existing.amount, input.amount) &&
    reservation.operationType === input.operationType
  return {
    outcome: samePayload
      ? { outcome: 'replayed', reservation }
      : { outcome: 'idempotency_conflict', idempotencyKey, existing: reservation },
  }
}
