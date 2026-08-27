/**
 * Core credit operations - framework agnostic
 *
 * Contains the business logic for credit operations that can be
 * used by any adapter or service implementation.
 */

import type { ICreditRepository } from "../repository/types.js";
import type { PortableReservation } from "./types.js";
import {
  commitThroughRepository,
  releaseThroughRepository,
  reserveThroughRepository,
} from "../repository/flow.js";
import {
  createReservationAlreadyProcessedError,
  createReservationNotFoundError,
  createInsufficientCreditsError,
} from "./errors.js";

/**
 * Commit a reservation with journal entry
 *
 * On a V2 repository the balance move and the journal entry happen in one
 * transaction and this function adds nothing of its own — the duplicate entry
 * the previous implementation wrote is gone. Legacy adapters keep the old
 * read-then-write path, journal included.
 *
 * @param repository - The credit repository
 * @param userId - User ID
 * @param reservationId - Reservation to commit
 */
export async function commitReservationWithJournal(
  repository: ICreditRepository,
  userId: string,
  reservationId: string
): Promise<void> {
  const outcome = await commitThroughRepository(repository, userId, reservationId);
  if (outcome.outcome === "not_found") {
    throw createReservationNotFoundError(reservationId);
  }
  if (outcome.outcome === "already_terminal" && outcome.terminalStatus !== "committed") {
    throw createReservationAlreadyProcessedError(reservationId, outcome.terminalStatus);
  }
}

/**
 * Release a reservation with journal entry
 *
 * @param repository - The credit repository
 * @param userId - User ID
 * @param reservationId - Reservation to release
 */
export async function releaseReservationWithJournal(
  repository: ICreditRepository,
  userId: string,
  reservationId: string
): Promise<void> {
  await releaseThroughRepository(repository, userId, reservationId);
}

/**
 * Reserve credits for an operation
 *
 * @param repository - The credit repository
 * @param userId - User ID
 * @param amount - Credits to reserve
 * @param operationType - Type of operation
 * @param expiryMs - Reservation expiry time in milliseconds
 * @param idempotencyKey - Optional caller key; a replay with the same
 *   amount/operation returns the original reservation instead of a second hold
 * @returns The reservation
 */
export async function reserveCreditsForOperation(
  repository: ICreditRepository,
  userId: string,
  amount: number,
  operationType: string,
  expiryMs: number = 5 * 60 * 1000,
  idempotencyKey?: string
): Promise<PortableReservation> {
  const expiresAt = new Date(Date.now() + expiryMs);
  const outcome = await reserveThroughRepository(repository, {
    userId,
    amount,
    operationType,
    expiresAt,
    idempotencyKey,
  });

  if (outcome.outcome === "created" || outcome.outcome === "replayed") {
    return outcome.reservation;
  }
  if (outcome.outcome === "insufficient") {
    throw createInsufficientCreditsError(outcome.required, outcome.available);
  }
  throw createReservationAlreadyProcessedError(
    outcome.existing.id,
    outcome.existing.status
  );
}
