/**
 * One reservation flow for both repository generations.
 *
 * Adapters that implement the V2 boundary get the idempotent, race-safe path
 * and own their journal entry. Adapters that do not (Firestore, custom
 * implementations) keep the legacy read-then-write path, with the service
 * writing the journal exactly as it always did — so upgrading this package
 * does not change their behaviour, and does not double-write anyone's ledger.
 */

import { getOperationLabel } from "../config/index.js";
import type {
  CommitOutcome,
  ReleaseOutcome,
  ReserveOutcome,
} from "../core/outcomes.js";
import type { ICreditRepository } from "./types.js";
import { supportsCreditsV2 } from "./types.js";
import type {
  ReservationTransitionOptions,
  ReserveCreditsV2Input,
} from "./v2-types.js";

/**
 * Reserve credits through V2 when available.
 *
 * A legacy adapter cannot honour an idempotency key — it has no unique index
 * to enforce it — so asking for one there is a caller error rather than a
 * silently ignored option.
 */
export async function reserveThroughRepository(
  repository: ICreditRepository,
  input: ReserveCreditsV2Input
): Promise<ReserveOutcome> {
  if (supportsCreditsV2(repository)) {
    return repository.reserveCreditsV2(input);
  }

  try {
    const reservation = await repository.reserveCreditsAtomic(
      input.userId,
      input.amount,
      input.operationType,
      input.expiresAt
    );
    return { outcome: "created", reservation };
  } catch (error) {
    const credits = await repository.getUserCredits(input.userId);
    const available = credits
      ? credits.balance + credits.bonusCredits - credits.reserved
      : 0;
    if (available >= input.amount) throw error;
    return {
      outcome: "insufficient",
      available,
      required: input.amount,
      shortfall: input.amount - available,
    };
  }
}

/** Commit through V2 when available, else the legacy read-then-write path. */
export async function commitThroughRepository(
  repository: ICreditRepository,
  userId: string,
  reservationId: string,
  options?: ReservationTransitionOptions
): Promise<CommitOutcome> {
  if (supportsCreditsV2(repository)) {
    return repository.commitReservationV2(userId, reservationId, options);
  }

  const reservation = await repository.getReservation(userId, reservationId);
  if (!reservation) return { outcome: "not_found", reservationId };
  if (reservation.status !== "reserved") {
    return {
      outcome: "already_terminal",
      reservation,
      terminalStatus: reservation.status,
    };
  }

  await repository.commitReservationAtomic(userId, reservationId);

  const credits = await repository.getUserCredits(userId);
  const balanceAfter = credits?.balance ?? 0;
  const entry = await repository.createJournalEntry({
    userId,
    entryType: "debit",
    amount: reservation.amount,
    balanceAfter,
    source: "operation_commit",
    referenceId: reservationId,
    referenceType: "reservation",
    description:
      options?.description ??
      `Committed ${reservation.amount} credits for ${getOperationLabel(reservation.operationType)}`,
    metadata: { operationType: reservation.operationType, ...options?.metadata },
  });

  return {
    outcome: "committed",
    reservation: { ...reservation, status: "committed" },
    amount: reservation.amount,
    balanceAfter,
    journalEntryId: entry.id,
  };
}

/** Release through V2 when available, else the legacy read-then-write path. */
export async function releaseThroughRepository(
  repository: ICreditRepository,
  userId: string,
  reservationId: string,
  options?: ReservationTransitionOptions
): Promise<ReleaseOutcome> {
  if (supportsCreditsV2(repository)) {
    return repository.releaseReservationV2(userId, reservationId, options);
  }

  const reservation = await repository.getReservation(userId, reservationId);
  if (!reservation) {
    // Legacy adapters vary on whether releasing an unknown reservation throws;
    // ask them anyway so that behaviour is preserved, then report not_found.
    await repository.releaseReservationAtomic(userId, reservationId);
    return { outcome: "not_found", reservationId };
  }
  if (reservation.status !== "reserved") {
    await repository.releaseReservationAtomic(userId, reservationId);
    return {
      outcome: "already_terminal",
      reservation,
      terminalStatus: reservation.status,
    };
  }

  await repository.releaseReservationAtomic(userId, reservationId);

  const credits = await repository.getUserCredits(userId);
  const entry = await repository.createJournalEntry({
    userId,
    entryType: "credit",
    // No credits changed hands — the hold just moved back into "available".
    amount: 0,
    balanceAfter: credits?.balance ?? 0,
    source: "operation_release",
    referenceId: reservationId,
    referenceType: "reservation",
    description:
      options?.description ??
      `Released ${reservation.amount} reserved credits for ${getOperationLabel(reservation.operationType)}`,
    metadata: {
      operationType: reservation.operationType,
      amount: reservation.amount,
      ...options?.metadata,
    },
  });

  return {
    outcome: "released",
    reservation: { ...reservation, status: "released" },
    amount: reservation.amount,
    journalEntryId: entry.id,
  };
}
