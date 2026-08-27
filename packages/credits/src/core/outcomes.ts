/**
 * Typed outcomes for the V2 reservation boundary.
 *
 * The legacy `*Atomic` repository methods signal "you lost the race" by
 * throwing (or, worse, by silently returning). V2 makes every terminal
 * transition an explicit, serialisable value so callers can tell a winner
 * from a duplicate delivery without string-matching an error message.
 *
 * Every outcome is discriminated on `outcome` (never `status`, which is the
 * reservation's own lifecycle field and would collide).
 */

import type {
  PortableReservation,
  PortableTransaction,
  ReservationStatus,
} from "./types.js";

/** Statuses a reservation can no longer transition out of. */
export type TerminalReservationStatus = Exclude<ReservationStatus, "reserved">;

/**
 * Result of `reserveCreditsV2`.
 *
 * - `created` — this caller minted the hold.
 * - `replayed` — same `(userId, idempotencyKey)` with an identical immutable
 *   payload; the original reservation is returned and no new hold was placed.
 * - `insufficient` — the guarded hold could not be placed; nothing was written.
 * - `idempotency_conflict` — the key was reused with a different
 *   amount/operation. Nothing was written; the existing reservation is
 *   returned so the caller can diff it.
 */
export type ReserveOutcome =
  | { outcome: "created"; reservation: PortableReservation }
  | { outcome: "replayed"; reservation: PortableReservation }
  | {
      outcome: "insufficient";
      available: number;
      required: number;
      shortfall: number;
    }
  | {
      outcome: "idempotency_conflict";
      idempotencyKey: string;
      existing: PortableReservation;
    };

/**
 * Result of `commitReservationV2`.
 *
 * Exactly one concurrent caller ever observes `committed`; that call — and
 * only that call — moved the balance and wrote the journal entry.
 */
export type CommitOutcome =
  | {
      outcome: "committed";
      reservation: PortableReservation;
      amount: number;
      /** `balance + bonusCredits` after the deduction, read from the same UPDATE. */
      balanceAfter: number;
      journalEntryId: string;
    }
  | {
      outcome: "already_terminal";
      reservation: PortableReservation;
      terminalStatus: TerminalReservationStatus;
    }
  | { outcome: "not_found"; reservationId: string };

/** Result of `releaseReservationV2`. Mirrors {@link CommitOutcome}. */
export type ReleaseOutcome =
  | {
      outcome: "released";
      reservation: PortableReservation;
      amount: number;
      journalEntryId: string;
    }
  | {
      outcome: "already_terminal";
      reservation: PortableReservation;
      terminalStatus: TerminalReservationStatus;
    }
  | { outcome: "not_found"; reservationId: string };

/**
 * Result of `expireReservationV2`.
 *
 * `not_due` means the reservation is still `reserved` but its `expiresAt` is
 * in the future relative to the sweep's `asOf` — a no-op, not a failure.
 */
export type ExpireOutcome =
  | {
      outcome: "expired";
      reservation: PortableReservation;
      amount: number;
      journalEntryId: string;
    }
  | { outcome: "not_due"; reservation: PortableReservation }
  | {
      outcome: "already_terminal";
      reservation: PortableReservation;
      terminalStatus: TerminalReservationStatus;
    }
  | { outcome: "not_found"; reservationId: string };

/**
 * Result of crediting an account against a `paymentRef`.
 *
 * - `created` — this delivery credited the account.
 * - `replayed` — the reference was already used for the *same* credit event;
 *   nothing was written and the original transaction is returned.
 * - `conflict` — the reference was already used for a *different* event
 *   (another user, another amount, another source). Nothing was written;
 *   `mismatch` names the first field that disagreed.
 *
 * A call with no `paymentRef` is always `created`: without a reference there is
 * nothing to deduplicate on, and every delivery is a distinct credit.
 *
 * **`created` is only a single-delivery guarantee on an adapter that implements
 * `addCreditsV2`.** Routed through a legacy adapter, `created` means "the call
 * was made and did not throw" — there is no global unique index behind it, so a
 * re-delivered reference credits again. `supportsIdempotentCredit` is the probe
 * that tells the two apart, and it is also why `transaction` is optional here:
 * the legacy method returns nothing, and inventing a transaction to fill the
 * field would be a fabricated audit record.
 */
export type AddCreditsOutcome =
  | {
      outcome: "created";
      /** The reference this credit was recorded under, if there was one. */
      paymentRef?: string;
      /** Absent only on the legacy fallback path; see above. */
      transaction?: PortableTransaction;
      /** Absent only on the legacy fallback path; see above. */
      journalEntryId?: string;
    }
  | {
      outcome: "replayed";
      paymentRef: string;
      transaction: PortableTransaction;
    }
  | {
      outcome: "conflict";
      paymentRef: string;
      existing: PortableTransaction;
      /** The first field of the canonical payload that disagreed. */
      mismatch: string;
    };

/** True when this delivery actually moved credits. */
export function isCreditedOutcome(
  outcome: AddCreditsOutcome
): outcome is Extract<AddCreditsOutcome, { outcome: "created" }> {
  return outcome.outcome === "created";
}

/** True when this caller performed the state transition. */
export function isWinningOutcome(
  outcome: CommitOutcome | ReleaseOutcome | ExpireOutcome
): boolean {
  return (
    outcome.outcome === "committed" ||
    outcome.outcome === "released" ||
    outcome.outcome === "expired"
  );
}

/** Narrow a reserve outcome to the two cases that yield a usable reservation. */
export function isReservedOutcome(
  outcome: ReserveOutcome
): outcome is Extract<ReserveOutcome, { reservation: PortableReservation }> {
  return outcome.outcome === "created" || outcome.outcome === "replayed";
}
