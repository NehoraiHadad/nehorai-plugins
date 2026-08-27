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
import { assertValidCreditAmount } from "../core/amount.js";
import {
  createUnsupportedOperationError,
  isInsufficientCreditsError,
} from "../core/errors.js";
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
  const v2 = supportsCreditsV2(repository);

  // The capability check comes first, so a caller who asked for a guarantee
  // this repository cannot give always hears *that*, rather than whichever
  // other complaint the arguments happen to trigger. A legacy adapter has no
  // unique index to enforce the key, so it cannot deduplicate a replay, and
  // reporting `created` for the second delivery would be a lie that costs the
  // user real credits.
  if (!v2 && input.idempotencyKey !== undefined) {
    throw createUnsupportedOperationError(
      "reserveCredits with an idempotencyKey",
      "This repository does not implement the V2 boundary, so it cannot " +
        "enforce idempotency keys. Use a V2 repository (check with " +
        "supportsCreditsV2) or omit the key and accept at-least-once holds."
    );
  }

  assertValidCreditAmount(input.amount, { userId: input.userId });

  if (v2) {
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
    // Only a genuine funds shortfall becomes the `insufficient` outcome. The
    // previous version asked the repository for the balance and called any
    // failure `insufficient` whenever that balance happened to be low — which
    // silently rebranded connection drops and driver faults as "the user is
    // out of credits", and hid real outages behind an upsell.
    if (!isInsufficientCreditsError(error)) throw error;

    const credits = await repository.getUserCredits(input.userId);
    const available = credits
      ? credits.balance + credits.bonusCredits - credits.reserved
      : 0;
    return {
      outcome: "insufficient",
      available,
      required: input.amount,
      shortfall: Math.max(input.amount - available, 0),
    };
  }
}

/**
 * Commit through V2 when available, else the legacy read-then-write path.
 *
 * **The legacy path cannot promise a single winner.** It reads the status and
 * then writes, with no lock and no compare-and-set between the two, so two
 * concurrent commits of the same reservation can both observe `reserved` and
 * both proceed. The typed outcome still describes what *this* call saw, but on
 * a legacy adapter `committed` means "this call did the work", not "this call
 * was the only one that did". Callers needing exactly-once must use a
 * repository for which `supportsCreditsV2` returns `true`.
 */
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

/**
 * Release through V2 when available, else the legacy read-then-write path.
 *
 * Same caveat as {@link commitThroughRepository}: on a legacy adapter the
 * read-then-write sequence is unguarded, so `released` does not exclude a
 * concurrent commit having also run. Only V2 repositories serialise the two.
 */
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
