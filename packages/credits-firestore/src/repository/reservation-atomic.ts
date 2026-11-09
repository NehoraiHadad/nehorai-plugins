import type { Firestore } from "firebase-admin/firestore";
import type { CreditOperationType, LotLedgerOptions, PortableReservation } from "@nehorai/credits";
import {
  createInsufficientCreditsError,
  createReservationAlreadyProcessedError,
  createReservationNotFoundError,
} from "@nehorai/credits";
import type { AccountSeedOptions } from "./credits-doc.js";
import {
  commitReservationV2,
  expireReservationNow,
  releaseReservationV2,
  reserveCreditsV2,
} from "./v2.js";

/**
 * The legacy `*Atomic` signatures, on top of the V2 transitions in `./v2.ts`.
 *
 * There is one implementation of each transition, so a caller on either
 * surface gets the same single-transaction guarantee: the status change, the
 * balance movement and the journal entry commit together or not at all.
 */

/**
 * Atomically reserve credits (check balance, create reservation, update reserved amount)
 */
export async function reserveCreditsAtomic(
  db: Firestore,
  userId: string,
  amount: number,
  operationType: CreditOperationType,
  expiresAt: Date,
  seedOptions?: AccountSeedOptions & LotLedgerOptions
): Promise<PortableReservation> {
  const outcome = await reserveCreditsV2(
    db,
    { userId, amount, operationType, expiresAt },
    seedOptions
  );
  if (outcome.outcome === "created" || outcome.outcome === "replayed") {
    return outcome.reservation;
  }
  if (outcome.outcome === "insufficient") {
    throw createInsufficientCreditsError(outcome.required, outcome.available);
  }
  throw createReservationAlreadyProcessedError(outcome.existing.id, outcome.existing.status);
}

/**
 * Atomically commit a reservation (deduct credits, update reservation status).
 *
 * Re-delivering a commit for an already-committed reservation is a no-op;
 * committing a released or expired one throws.
 */
export async function commitReservationAtomic(
  db: Firestore,
  userId: string,
  reservationId: string,
  lotOptions?: LotLedgerOptions
): Promise<void> {
  const outcome = await commitReservationV2(db, userId, reservationId, undefined, lotOptions);
  if (outcome.outcome === "committed") return;
  if (outcome.outcome === "not_found") throw createReservationNotFoundError(reservationId);
  if (outcome.terminalStatus === "committed") return;
  throw createReservationAlreadyProcessedError(reservationId, outcome.terminalStatus);
}

/**
 * Atomically release a reservation (restore reserved credits, update status).
 *
 * Releasing one that is already terminal is a no-op.
 */
export async function releaseReservationAtomic(
  db: Firestore,
  userId: string,
  reservationId: string,
  lotOptions?: LotLedgerOptions
): Promise<void> {
  const outcome = await releaseReservationV2(db, userId, reservationId, undefined, lotOptions);
  if (outcome.outcome === "not_found") throw createReservationNotFoundError(reservationId);
}

/**
 * Atomically expire a reservation (release reserved credits + mark expired).
 *
 * The primitive the cleanup sweep settles each candidate with: it re-reads the
 * reservation inside the transaction, so one settled between discovery and
 * this call is left alone.
 *
 * Like the 1.x primitive it replaces, it does not check `expiresAt`: the sweep
 * selects due rows, and other callers use it to expire a hold early.
 *
 * @returns `{ expired: true, amount }` if this call performed the expiry, or
 *   `{ expired: false, amount: 0 }` if the reservation was already terminal.
 */
export async function expireReservationAtomic(
  db: Firestore,
  userId: string,
  reservationId: string,
  lotOptions?: LotLedgerOptions
): Promise<{ expired: boolean; amount: number }> {
  const outcome = await expireReservationNow(db, userId, reservationId, lotOptions);
  if (outcome.outcome === "expired") return { expired: true, amount: outcome.amount };
  if (outcome.outcome === "not_found") throw createReservationNotFoundError(reservationId);
  return { expired: false, amount: 0 };
}
