/**
 * Trust checks for a *persisted* reservation row.
 *
 * A reservation is written once and read back on every transition, and nothing
 * between those two moments belongs to this library: a direct `UPDATE`, a
 * half-finished migration, a legacy adapter or a future version can all leave a
 * row this code never wrote. Two of the fields it reads back are load-bearing.
 *
 * **`status`** decides whether a transition runs at all. It used to be cast —
 * `reservation.status as TerminalReservationStatus` — so a row holding
 * `'gremlin'` was reported as `already_terminal` with `terminalStatus:
 * 'gremlin'`: a *success* outcome, telling the caller the reservation had been
 * resolved, over a row nothing in this library can resolve. The cast is a lie
 * the type system cannot catch, so the value is checked against the closed set
 * instead and anything outside it quarantines the row.
 *
 * **`holdPlacedAt`** decides whether the hold behind the row exists. See
 * {@link assertHoldPlaced}.
 *
 * Both refusals happen before any state changes, and neither one repairs
 * anything: a corrupt row stops moving and waits for an operator. Silently
 * reconciling it would need an audit trail and a recovery procedure, and
 * guessing is how a bad row becomes a wrong balance.
 */

import { CreditError, CreditErrorCode } from "./errors.js";
import type { TerminalReservationStatus } from "./outcomes.js";
import type { PortableReservation, ReservationStatus } from "./types.js";

/** Every status this library knows how to reason about. */
export const RESERVATION_STATUSES: readonly ReservationStatus[] = [
  "reserved",
  "committed",
  "released",
  "expired",
];

/** The statuses a reservation can no longer transition out of. */
export const TERMINAL_RESERVATION_STATUSES: readonly TerminalReservationStatus[] = [
  "committed",
  "released",
  "expired",
];

export function isReservationStatus(value: unknown): value is ReservationStatus {
  return RESERVATION_STATUSES.includes(value as ReservationStatus);
}

export function isTerminalReservationStatus(
  value: unknown
): value is TerminalReservationStatus {
  return TERMINAL_RESERVATION_STATUSES.includes(value as TerminalReservationStatus);
}

/** The subset of a reservation these checks read, so callers can pass a row. */
export interface ReservationIntegrityView {
  id: string;
  userId: string;
  status: unknown;
  /** Set by the atomic reserve, in the same transaction as the hold. */
  holdPlacedAt?: string | null;
  idempotencyKey?: string | null;
}

/**
 * Refuse a transition over a status this library does not define.
 *
 * Runs ahead of every early exit, including the `already_terminal` one, for the
 * reason in the module header: `already_terminal` is a success outcome, and a
 * success outcome over an unknown status is the failure mode being prevented.
 */
export function assertKnownReservationStatus(
  reservation: ReservationIntegrityView,
  transition: string
): asserts reservation is ReservationIntegrityView & { status: ReservationStatus } {
  if (isReservationStatus(reservation.status)) return;
  throw new CreditError(
    `Reservation ${reservation.id} holds the status ${JSON.stringify(reservation.status)}, ` +
      `which is not one of ${RESERVATION_STATUSES.join(", ")}. The ${transition} was ` +
      "refused before any state changed; the row must be repaired by an operator.",
    CreditErrorCode.CORRUPT_RESERVATION_STATUS,
    {
      userId: reservation.userId,
      reservationId: reservation.id,
      transition,
      status: typeof reservation.status === "string" ? reservation.status : String(reservation.status),
      allowed: [...RESERVATION_STATUSES],
      reason: "corrupt_reservation_status",
    }
  );
}

/**
 * Narrow a non-`reserved` status for the `already_terminal` outcomes.
 *
 * Validates rather than casts. `assertKnownReservationStatus` has usually run
 * already; this repeats the check because the cast it replaces was the defect,
 * and a second closed-set test costs nothing next to a database round trip.
 */
export function terminalStatusOf(
  reservation: ReservationIntegrityView,
  transition: string
): TerminalReservationStatus {
  assertKnownReservationStatus(reservation, transition);
  if (isTerminalReservationStatus(reservation.status)) return reservation.status;
  throw new CreditError(
    `Reservation ${reservation.id} is ${reservation.status}, which is not a terminal ` +
      `status, but the ${transition} tried to report it as one.`,
    CreditErrorCode.CORRUPT_RESERVATION_STATUS,
    {
      userId: reservation.userId,
      reservationId: reservation.id,
      transition,
      status: reservation.status,
      reason: "not_terminal",
    }
  );
}

/**
 * Refuse a transition over a hold that was never atomically placed.
 *
 * `holdPlacedAt` is the single invariant behind the V2 boundary: **a row is
 * only a reservation if the same atomic operation that wrote it also increased
 * `reserved` by its amount.** The atomic reserve sets the field inside that one
 * transaction, so the fact and the hold commit together or not at all.
 *
 * Without it, `createReservation` — a plain row writer that does not touch
 * `reserved` — could mint a keyed row, and a later `reserveCreditsV2` with that
 * key would adopt it as a `replayed` hold that no credits back. The caller then
 * commits it, and the commit passes its `reserved >= amount` guard by consuming
 * coverage that belongs to a *different*, real hold: two holds, one payment.
 *
 * So this is checked before adopting a replay and before every transition, and
 * `createReservation` refuses a key outright — the two halves of the same rule.
 */
export function assertHoldPlaced(
  reservation: ReservationIntegrityView,
  transition: string
): void {
  if (reservation.holdPlacedAt) return;
  throw new CreditError(
    `Reservation ${reservation.id} does not record that its hold was placed atomically ` +
      "(holdPlacedAt is absent), so the credits it claims to hold may never have been " +
      `reserved. The ${transition} was refused before any state changed: honouring it ` +
      "would spend coverage belonging to another reservation. Rows written by " +
      "createReservation are not V2 reservations; place holds with reserveCredits.",
    CreditErrorCode.UNBACKED_RESERVATION,
    {
      userId: reservation.userId,
      reservationId: reservation.id,
      transition,
      idempotencyKey: reservation.idempotencyKey ?? undefined,
      reason: "hold_not_placed",
    }
  );
}

/**
 * Refuse an idempotency key on the direct, non-atomic reservation writer.
 *
 * The other half of {@link assertHoldPlaced}. `createReservation` inserts a row
 * and does not touch `reserved`, so a key registered here would name a hold
 * that does not exist. Rejecting the key at the boundary means the unbacked
 * keyed row cannot be created in the first place, rather than only being
 * refused later by every transition that tries to move it.
 *
 * The amount check that runs alongside this is about a value the ledger cannot
 * honour; this is about a *claim* the writer cannot honour.
 */
export function assertUnkeyedDirectReservation(input: {
  userId: string;
  idempotencyKey?: string;
}): void {
  if (input.idempotencyKey === undefined || input.idempotencyKey === null) return;
  throw new CreditError(
    "createReservation cannot accept an idempotencyKey: it writes the reservation " +
      "row without placing the hold, so the key would name credits that were never " +
      "reserved, and a later reserveCredits with the same key would adopt it as a " +
      "replay. Call reserveCredits (or reserveCreditsV2) with the key instead — it " +
      "claims the key and places the hold in one transaction.",
    CreditErrorCode.UNSUPPORTED_OPERATION,
    {
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      operation: "createReservation",
      reason: "keyed_direct_reservation",
    }
  );
}

/** True when the row records an atomically placed hold. */
export function hasPlacedHold(reservation: Pick<PortableReservation, "holdPlacedAt">): boolean {
  return Boolean(reservation.holdPlacedAt);
}

/**
 * Refuse a direct status write that would bypass the V2 state machine.
 *
 * `updateReservationStatus` assigns a status and nothing else: it does not
 * check the current status, move the balance, adjust `reserved`, or journal.
 * On a row whose hold was atomically placed, that is not an update — it is a
 * bypass. Writing `committed` onto a live hold strands `reserved` forever (the
 * real commit then reports `already_terminal` and never debits), and writing
 * `reserved` onto a terminal row re-arms a settled reservation so it can be
 * settled again.
 *
 * Two refusals, mirroring the createReservation/reserveCredits split:
 *
 * - A row bearing `holdPlacedAt` belongs to the V2 transitions. Every status it
 *   will ever hold is assigned by commit/release/expire, atomically with the
 *   ledger movement that status implies.
 * - No row, V2 or legacy, may be *reopened* — status can never be assigned back
 *   to `reserved`, because nothing here re-places the hold that status claims.
 *
 * Rows written by `createReservation` (no hold, no key) remain freely
 * annotatable with terminal statuses: their statuses never carried ledger
 * meaning, and the V2 transitions refuse them anyway.
 */
export function assertDirectStatusWriteAllowed(
  reservation: ReservationIntegrityView,
  status: ReservationStatus
): void {
  if (status === "reserved") {
    throw new CreditError(
      `Reservation ${reservation.id} cannot have its status set back to "reserved": ` +
        "updateReservationStatus does not place a hold, so the reopened row would claim " +
        "credits nothing reserved. Create a new reservation with reserveCredits instead.",
      CreditErrorCode.UNSUPPORTED_OPERATION,
      {
        userId: reservation.userId,
        reservationId: reservation.id,
        status,
        reason: "reopen_reservation",
      }
    );
  }
  if (!reservation.holdPlacedAt) return;
  throw new CreditError(
    `Reservation ${reservation.id} is backed by an atomically placed hold, so its ` +
      "status may only be assigned by the transition that settles it. Writing " +
      `"${status}" directly would change the status without moving the credits it ` +
      "stands for, stranding the hold. Use commitReservation / releaseReservation / " +
      "expireReservation (or their V2 forms) instead.",
    CreditErrorCode.UNSUPPORTED_OPERATION,
    {
      userId: reservation.userId,
      reservationId: reservation.id,
      status,
      reason: "direct_status_write_on_backed_hold",
    }
  );
}
