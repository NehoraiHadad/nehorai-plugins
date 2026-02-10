/**
 * Core credit operations - framework agnostic
 *
 * Contains the business logic for credit operations that can be
 * used by any adapter or service implementation.
 */

import type { ICreditRepository } from "../repository/types.js";
import type { PortableReservation } from "./types.js";
import { getOperationLabel } from "../config/index.js";

/**
 * Commit a reservation with journal entry
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
  // Get the reservation to know the amount
  const reservation = await repository.getReservation(userId, reservationId);
  if (!reservation) {
    throw new Error(`Reservation ${reservationId} not found`);
  }

  // Commit the reservation atomically
  await repository.commitReservationAtomic(userId, reservationId);

  // Create journal entry
  const credits = await repository.getUserCredits(userId);
  if (credits) {
    await repository.createJournalEntry({
      userId,
      entryType: "debit",
      amount: reservation.amount,
      balanceAfter: credits.balance,
      source: "operation_commit",
      referenceId: reservationId,
      referenceType: "reservation",
      description: `Committed ${reservation.amount} credits for ${getOperationLabel(reservation.operationType)}`,
      metadata: {
        operationType: reservation.operationType,
      },
    });
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
  // Get the reservation to check its state
  const reservation = await repository.getReservation(userId, reservationId);

  // Release the reservation atomically
  await repository.releaseReservationAtomic(userId, reservationId);

  // Create journal entry only if reservation was in reserved state
  if (reservation?.status === "reserved") {
    const credits = await repository.getUserCredits(userId);
    if (credits) {
      await repository.createJournalEntry({
        userId,
        entryType: "credit",
        amount: 0, // No actual credits returned (they were reserved, not spent)
        balanceAfter: credits.balance,
        source: "operation_release",
        referenceId: reservationId,
        referenceType: "reservation",
        description: `Released ${reservation.amount} reserved credits for ${getOperationLabel(reservation.operationType)}`,
        metadata: {
          operationType: reservation.operationType,
          amount: reservation.amount,
        },
      });
    }
  }
}

/**
 * Reserve credits for an operation
 *
 * @param repository - The credit repository
 * @param userId - User ID
 * @param amount - Credits to reserve
 * @param operationType - Type of operation
 * @param expiryMs - Reservation expiry time in milliseconds
 * @returns The reservation
 */
export async function reserveCreditsForOperation(
  repository: ICreditRepository,
  userId: string,
  amount: number,
  operationType: string,
  expiryMs: number = 5 * 60 * 1000
): Promise<PortableReservation> {
  const expiresAt = new Date(Date.now() + expiryMs);
  return repository.reserveCreditsAtomic(userId, amount, operationType, expiresAt);
}
