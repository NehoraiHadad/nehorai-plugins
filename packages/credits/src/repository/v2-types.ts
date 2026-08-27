/**
 * Inputs for the V2 reservation boundary.
 *
 * V2 is additive: every method is optional on {@link ICreditRepository} so
 * existing adapters keep compiling and keep working through the legacy
 * `*Atomic` methods. Adapters that implement V2 must satisfy the contract
 * documented on {@link ICreditRepositoryV2}.
 */

import type { CreditOperationType } from "../core/types.js";
import type {
  CommitOutcome,
  ExpireOutcome,
  ReleaseOutcome,
  ReserveOutcome,
} from "../core/outcomes.js";

/**
 * Input for `reserveCreditsV2`.
 *
 * `userId`, `amount` and `operationType` form the immutable payload bound to
 * `idempotencyKey`: replaying the same key with the same payload returns the
 * original reservation, replaying it with a different one is a conflict.
 * `expiresAt` is deliberately *not* part of the payload — a retry naturally
 * computes a later deadline and that must not be treated as a conflict.
 */
export interface ReserveCreditsV2Input {
  userId: string;
  amount: number;
  operationType: CreditOperationType;
  expiresAt: Date;
  /**
   * Caller-supplied key, unique per user. Omit it to get legacy
   * (non-idempotent) reserve semantics — every call mints a new hold.
   */
  idempotencyKey?: string;
}

/** Optional journal customisation for a V2 state transition. */
export interface ReservationTransitionOptions {
  /** Overrides the generated journal description. */
  description?: string;
  /** Merged onto the journal entry's metadata. */
  metadata?: Record<string, unknown>;
}

/** Options for `expireReservationV2`. */
export interface ExpireReservationV2Options extends ReservationTransitionOptions {
  /**
   * Sweep timestamp. A reservation only expires when `expiresAt <= asOf`;
   * otherwise the outcome is `not_due`. Defaults to now.
   */
  asOf?: Date;
}

/**
 * The V2 surface. Every method must:
 *
 * 1. run in a single database transaction;
 * 2. take row locks in a consistent order — reservation first, then balance —
 *    so concurrent transitions cannot deadlock;
 * 3. transition status with a compare-and-set (`WHERE status = 'reserved'`)
 *    and report the loser truthfully instead of silently succeeding;
 * 4. mutate balances with column expressions, never with values read earlier
 *    in the transaction;
 * 5. write at most one journal entry, inside the same transaction, keyed so a
 *    retry cannot duplicate it;
 * 6. perform no callbacks and no network I/O inside the transaction.
 */
export interface ICreditRepositoryV2 {
  reserveCreditsV2(input: ReserveCreditsV2Input): Promise<ReserveOutcome>;

  commitReservationV2(
    userId: string,
    reservationId: string,
    options?: ReservationTransitionOptions
  ): Promise<CommitOutcome>;

  releaseReservationV2(
    userId: string,
    reservationId: string,
    options?: ReservationTransitionOptions
  ): Promise<ReleaseOutcome>;

  expireReservationV2(
    userId: string,
    reservationId: string,
    options?: ExpireReservationV2Options
  ): Promise<ExpireOutcome>;
}

/**
 * Deterministic journal key for a reservation transition.
 *
 * Derived purely from the reservation id and the transition, so a retried
 * commit computes the same key and collides with the first entry on the
 * journal's partial unique index instead of writing a second row.
 */
export function reservationJournalKey(
  reservationId: string,
  transition: "commit" | "release" | "expire"
): string {
  return `reservation:${reservationId}:${transition}`;
}
