/**
 * V2 reservation transitions for the in-memory repository.
 *
 * These mirror the SQL adapter's guarantees rather than its mechanics: every
 * transition runs inside the user's lock (standing in for the row locks),
 * re-reads state *after* acquiring it, compares-and-sets the status, and
 * writes at most one journal entry keyed so a retry cannot duplicate it.
 *
 * Modelling that here is what makes the shared contract tests meaningful — a
 * naive implementation would pass them by accident because nothing interleaves.
 */

import {
  assertValidCreditAmount,
  assertValidStoredAmount,
  allocateExpiredBacking,
  expiredBackingPatch,
  heldExpiredBacking,
  holdExpiredBacking,
  holdPlacedAtAfter,
  planHoldCommit,
  type ExpiredBackingAllocation,
  settleExpiredHoldBacking,
  sumAmounts,
} from "../../core/amount.js";
import { assertValidIdempotencyKey } from "../../core/idempotency.js";
import {
  assertHoldPlaced,
  assertKnownReservationStatus,
  terminalStatusOf as narrowTerminalStatus,
} from "../../core/reservation-integrity.js";
import { copyRecord, detach } from "./snapshot.js";
import { assertRepresentableFields } from "../../core/amount.js";
import { CreditError, CreditErrorCode } from "../../core/errors.js";
import type {
  CommitOutcome,
  ExpireOutcome,
  ReleaseOutcome,
  ReserveOutcome,
  TerminalReservationStatus,
} from "../../core/outcomes.js";
import type {
  CreditSource,
  PortableReservation,
  PortableUserCredits,
} from "../../core/types.js";
import { getOperationLabel } from "../../config/index.js";
import { generateId } from "../utils.js";
import {
  commitTransitionJournal,
  planTransitionJournal,
  type JournalWriteInput,
} from "./transition-journal.js";
import type {
  ExpireReservationV2Options,
  ReservationTransitionOptions,
  ReserveCreditsV2Input,
} from "../v2-types.js";
import { reservationJournalKey } from "../v2-types.js";
import { MemoryStore, scopedKey } from "./store.js";
import { applyMemoryLots, bucketsAfter, bucketsOf, planMemoryLots } from "./lots.js";
import { lotTotalsOf, planLotDraws, planLotRemoval } from "../../core/lots.js";

/** Yield at the read/write seam so tests can force real interleaving. */
async function yieldPoint(store: MemoryStore): Promise<void> {
  if (store.schedulingHook) await store.schedulingHook();
}

/**
 * Refuse a transition whose hold is no longer covered by `reserved`.
 *
 * The SQL adapter enforces this as `reserved >= amount` in the UPDATE's WHERE.
 * Clamping with `Math.max(reserved - amount, 0)` instead would look harmless
 * and quietly consume the coverage of *other* live holds, so those commits
 * would later fail or overdraw. Failing here keeps the damage contained and
 * visible, and — because the caller sees `DATABASE_ERROR` rather than
 * `INSUFFICIENT_CREDITS` — correctly reads as corruption, not as a user who
 * ran out of money.
 */
function assertReservedCoversHold(
  credits: PortableUserCredits,
  userId: string,
  reservationId: string,
  amount: number
): void {
  if (credits.reserved >= amount) return;
  throw new CreditError(
    `Credit balance invariant violated for user ${userId} while processing ` +
      `reservation ${reservationId}: reserved (${credits.reserved}) is less ` +
      `than the hold (${amount}). The transition was rolled back.`,
    CreditErrorCode.DATABASE_ERROR,
    { userId, reservationId, amount, reserved: credits.reserved }
  );
}

/**
 * Re-validate a persisted amount before the transition touches anything.
 *
 * Mirrors the SQL adapter: the reservation row was written once and is read
 * back on every transition, and a value that is negative, non-finite or off the
 * cent grid makes every downstream invariant meaningless — `reserved >= -10` is
 * trivially true, and subtracting a negative *adds* credits.
 */
function assertLockedAmount(reservation: PortableReservation, transition: string): void {
  assertValidStoredAmount(reservation.amount, {
    userId: reservation.userId,
    reservationId: reservation.id,
    transition,
  });
}

/**
 * Narrow a non-`reserved` status, validating instead of casting.
 *
 * The cast this replaces reported `already_terminal` — a *success* outcome —
 * over a row holding any string at all, so a corrupt status read to the caller
 * as "this reservation is resolved". See `core/reservation-integrity.ts`.
 */
function terminalStatusOf(
  reservation: PortableReservation,
  transition: string
): TerminalReservationStatus {
  return narrowTerminalStatus(reservation, transition);
}

/**
 * Every check a persisted reservation must pass before a transition touches it.
 *
 * Ordered ahead of the `already_terminal` and `not_due` early exits on purpose:
 * both are success outcomes, and reporting one over a row that is corrupt or
 * unbacked tells the caller the reservation is fine.
 */
function assertTrustworthy(reservation: PortableReservation, transition: string): void {
  assertKnownReservationStatus(reservation, transition);
  assertLockedAmount(reservation, transition);
  assertHoldPlaced(reservation, transition);
}

function openHolds(store: MemoryStore, userId: string): PortableReservation[] {
  return [...(store.reservations.get(userId)?.values() ?? [])].filter(
    (reservation) => reservation.status === "reserved"
  );
}

/**
 * The marked credits in force. A total stored without a frontier (written by 2.2.0, or
 * never allocated) is allocated across the open holds now, ahead of whatever is about
 * to happen, so a hold placed or closed next cannot take what belongs to an older one.
 */
function expiredBackingInForce(
  store: MemoryStore,
  credits: PortableUserCredits
): ExpiredBackingAllocation {
  const total = heldExpiredBacking(credits.balance, credits.expiredHoldBacking);
  if (total > 0 && (!credits.expiredBackingFrontier || credits.expiredHoldBacking !== total)) {
    return allocateExpiredBacking(openHolds(store, credits.userId), total);
  }
  return { total, frontier: credits.expiredBackingFrontier ?? null };
}

/** Write the stored shares an allocation changed. Empty on all but a 2.2.0 account. */
function writeRecordedShares(
  store: MemoryStore,
  userId: string,
  allocation: ExpiredBackingAllocation
): void {
  for (const { id, expiredBacking } of allocation.rewrites ?? []) {
    const hold = getReservation(store, userId, id);
    if (hold) hold.expiredBacking = expiredBacking;
  }
}

/**
 * Set the marked credits on an account, which also repairs a stored value that was never
 * within the balance. A hold's share follows from the frontier, or from its own record. An
 * account that never had any, or whose total does not change, reads no holds.
 */
export function writeExpiredHoldBacking(
  store: MemoryStore,
  credits: PortableUserCredits,
  next: number
): void {
  if (next <= 0) {
    Object.assign(credits, expiredBackingPatch({ total: 0 }, credits));
    return;
  }
  if (next === credits.expiredHoldBacking) return;
  const allocation = allocateExpiredBacking(openHolds(store, credits.userId), next);
  writeRecordedShares(store, credits.userId, allocation);
  Object.assign(credits, expiredBackingPatch(allocation, credits));
}

function getReservation(
  store: MemoryStore,
  userId: string,
  reservationId: string
): PortableReservation | undefined {
  return store.reservations.get(userId)?.get(reservationId);
}

/**
 * The *live* stored record, deliberately — the transitions in this module write
 * through it. Everything that crosses the repository's public surface goes
 * through `copyRecord` instead; see `./snapshot.js`.
 */
function requireUser(store: MemoryStore, userId: string): PortableUserCredits {
  const credits = store.users.get(userId);
  if (!credits) {
    throw new CreditError(
      `User credits not found for user ${userId}`,
      CreditErrorCode.USER_NOT_FOUND,
      { userId }
    );
  }
  return credits;
}

export async function reserveCreditsV2(
  store: MemoryStore,
  input: ReserveCreditsV2Input
): Promise<ReserveOutcome> {
  assertValidCreditAmount(input.amount, { userId: input.userId });
  assertValidIdempotencyKey(input.idempotencyKey, { userId: input.userId });

  return store.locks.run(input.userId, async () => {
    if (input.idempotencyKey) {
      const existingId = store.reservationKeys.get(
        scopedKey(input.userId, input.idempotencyKey)
      );
      if (existingId) {
        const existing = getReservation(store, input.userId, existingId);
        if (existing) {
          // Before the payload comparison, and before any outcome is chosen: a
          // row is only adoptable as a replay if *its own* reserve placed the
          // hold. Adopting an unbacked row would report `replayed` over credits
          // nothing ever held. Mirrors the SQL adapter.
          assertHoldPlaced(existing, "reserve replay");
          // `expiresAt` is excluded on purpose: a retry legitimately computes a
          // later deadline and that must not read as a conflict.
          const samePayload =
            existing.amount === input.amount &&
            existing.operationType === input.operationType;
          return samePayload
            ? { outcome: "replayed", reservation: copyRecord(existing) }
            : {
                outcome: "idempotency_conflict",
                idempotencyKey: input.idempotencyKey,
                existing: copyRecord(existing),
              };
        }
      }
    }

    const credits = requireUser(store, input.userId);
    const available = sumAmounts(credits.balance, credits.bonusCredits, -credits.reserved);
    await yieldPoint(store);
    if (available < input.amount) {
      return {
        outcome: "insufficient",
        available,
        required: input.amount,
        shortfall: sumAmounts(input.amount, -available),
      };
    }

    const now = new Date().toISOString();
    const backing = expiredBackingInForce(store, credits);
    const reservation: PortableReservation = {
      id: generateId(),
      userId: input.userId,
      amount: input.amount,
      operationType: input.operationType,
      status: "reserved",
      createdAt: now,
      expiresAt: input.expiresAt.toISOString(),
      idempotencyKey: input.idempotencyKey,
      // The hold-origin fact. Written here and nowhere else, in the same
      // critical section that raises `reserved` below, so the row and the hold
      // become visible together. `createReservation` cannot set it.
      holdPlacedAt: holdPlacedAtAfter(now, backing.total > 0 ? backing.frontier : null),
    };

    if (!store.reservations.has(input.userId)) {
      store.reservations.set(input.userId, new Map());
    }
    // The derived hold is checked before the reservation row exists, not after:
    // a refusal here must leave no reservation, no key registration and no
    // counter change behind.
    const nextReserved = sumAmounts(credits.reserved, input.amount);
    assertRepresentableFields(
      { reserved: nextReserved },
      { userId: input.userId, operation: "reserveCredits" }
    );

    // A reserve moves no credit, but it is a write: an account without a ledger gets one,
    // and one another writer left behind is reconciled.
    const lots = planMemoryLots(store, {
      userId: input.userId,
      before: bucketsOf(credits),
      after: bucketsOf(credits),
      opRef: `reserve:${reservation.id}`,
      createdAt: credits.createdAt,
    });

    store.reservations.get(input.userId)!.set(reservation.id, reservation);
    if (input.idempotencyKey) {
      store.reservationKeys.set(
        scopedKey(input.userId, input.idempotencyKey),
        reservation.id
      );
    }

    credits.reserved = nextReserved;
    writeRecordedShares(store, input.userId, backing);
    Object.assign(credits, expiredBackingPatch(backing, credits));
    credits.updatedAt = now;
    applyMemoryLots(store, input.userId, "reserveCredits", lots);

    return { outcome: "created", reservation: copyRecord(reservation) };
  });
}

export async function commitReservationV2(
  store: MemoryStore,
  userId: string,
  reservationId: string,
  options?: ReservationTransitionOptions
): Promise<CommitOutcome> {
  return store.locks.run(userId, async () => {
    const reservation = getReservation(store, userId, reservationId);
    if (!reservation) return { outcome: "not_found", reservationId };
    // Ahead of the early exits: `already_terminal` and `not_due` are success
    // outcomes, and reporting one over a row that is unusable tells the caller
    // the reservation is fine. Mirrors the SQL adapter.
    assertTrustworthy(reservation, "commit");

    if (reservation.status !== "reserved") {
      return {
        outcome: "already_terminal",
        reservation: copyRecord(reservation),
        terminalStatus: terminalStatusOf(reservation, "commit"),
      };
    }

    const credits = requireUser(store, userId);
    const amount = reservation.amount;
    await yieldPoint(store);
    assertReservedCoversHold(credits, userId, reservationId, amount);
    const backing = expiredBackingInForce(store, credits);
    const paid = planHoldCommit(
      credits.balance,
      credits.bonusCredits,
      backing.total,
      holdExpiredBacking(reservation, backing.frontier, backing.rewrites),
      amount
    );
    if (!paid.covered) {
      throw new CreditError(
        `Insufficient credits to commit reservation ${reservationId}`,
        CreditErrorCode.INSUFFICIENT_CREDITS,
        { userId, reservationId, required: amount }
      );
    }

    // Project the post-transition balances before applying them. The store has
    // no transaction to roll back, so everything that can refuse — the journal
    // key check below — has to refuse while the ledger is still untouched. The
    // projected values are then assigned verbatim, so the number the journal
    // records and the number the balance ends up holding cannot drift apart.
    const nextBalance = paid.balance;
    const nextBonusCredits = paid.bonusCredits;
    const balanceAfter = sumAmounts(nextBalance, nextBonusCredits);

    // The lots that paid: the hold's backing share, then spendable balance, then bonus,
    // each in draw order.
    const fromBacking = sumAmounts(backing.total, -paid.expiredHoldBacking);
    const lots = planMemoryLots(store, {
      userId,
      before: bucketsOf(credits),
      after: bucketsAfter(nextBalance, paid.expiredHoldBacking, nextBonusCredits),
      opRef: `commit:${reservationId}`,
      createdAt: credits.createdAt,
      apply: (plan) =>
        planLotDraws(plan, {
          backing: fromBacking,
          spendable: sumAmounts(credits.balance, -nextBalance, -fromBacking),
          bonus: sumAmounts(credits.bonusCredits, -nextBonusCredits),
        }),
    });
    const lotFields = lots
      ? { lotDraws: lots.draws, lotTotals: lotTotalsOf(lots.draws) }
      : null;

    const journal: JournalWriteInput = {
      userId,
      operation: "commitReservation",
      entryType: "debit",
      amount,
      balanceBefore: sumAmounts(credits.balance, credits.bonusCredits),
      balanceAfter,
      source: "operation_commit",
      reservationId,
      description:
        options?.description ??
        `Committed ${amount} credits for ${getOperationLabel(reservation.operationType)}`,
      // Caller metadata first: the deterministic fields carry the identity of
      // the event that the collision check compares on.
      metadata: {
        ...options?.metadata,
        ...lotFields,
        operationType: reservation.operationType,
        amount,
      },
      idempotencyKey: reservationJournalKey(reservationId, "commit"),
    };
    const nextReserved = sumAmounts(credits.reserved, -amount);
    const nextMonthlyUsed = sumAmounts(credits.monthlyUsed, amount);
    assertRepresentableFields(
      {
        balance: nextBalance,
        bonusCredits: nextBonusCredits,
        reserved: nextReserved,
        monthlyUsed: nextMonthlyUsed,
      },
      { userId, operation: "commitReservation" }
    );

    const existingEntryId = planTransitionJournal(store, journal);

    reservation.status = "committed";
    reservation.completedAt = new Date().toISOString();
    if (lotFields) Object.assign(reservation, detach(lotFields));

    // Drain `balance` before `bonusCredits`, matching the SQL adapter.
    credits.balance = nextBalance;
    credits.bonusCredits = nextBonusCredits;
    credits.reserved = nextReserved;
    credits.monthlyUsed = nextMonthlyUsed;
    writeRecordedShares(store, userId, backing);
    Object.assign(
      credits,
      expiredBackingPatch({ total: paid.expiredHoldBacking, frontier: backing.frontier }, credits)
    );
    credits.updatedAt = new Date().toISOString();
    applyMemoryLots(store, userId, "commitReservation", lots);

    const journalEntryId = commitTransitionJournal(store, journal, existingEntryId);

    return {
      outcome: "committed",
      reservation: copyRecord(reservation),
      amount,
      balanceAfter,
      journalEntryId,
    };
  });
}

export async function releaseReservationV2(
  store: MemoryStore,
  userId: string,
  reservationId: string,
  options?: ReservationTransitionOptions
): Promise<ReleaseOutcome> {
  return store.locks.run(userId, async () => {
    const reservation = getReservation(store, userId, reservationId);
    if (!reservation) return { outcome: "not_found", reservationId };
    // Ahead of the early exits: `already_terminal` and `not_due` are success
    // outcomes, and reporting one over a row that is unusable tells the caller
    // the reservation is fine. Mirrors the SQL adapter.
    assertTrustworthy(reservation, "release");

    if (reservation.status !== "reserved") {
      return {
        outcome: "already_terminal",
        reservation: copyRecord(reservation),
        terminalStatus: terminalStatusOf(reservation, "release"),
      };
    }

    await yieldPoint(store);
    const journalEntryId = finishUnspent(store, reservation, {
      status: "released",
      source: "operation_release",
      transition: "release",
      verb: "Released",
      options,
    });

    return {
      outcome: "released",
      reservation: copyRecord(reservation),
      amount: reservation.amount,
      journalEntryId,
    };
  });
}

export async function expireReservationV2(
  store: MemoryStore,
  userId: string,
  reservationId: string,
  options?: ExpireReservationV2Options
): Promise<ExpireOutcome> {
  const asOf = options?.asOf ?? new Date();
  return store.locks.run(userId, async () => {
    const reservation = getReservation(store, userId, reservationId);
    if (!reservation) return { outcome: "not_found", reservationId };
    // Ahead of the early exits: `already_terminal` and `not_due` are success
    // outcomes, and reporting one over a row that is unusable tells the caller
    // the reservation is fine. Mirrors the SQL adapter.
    assertTrustworthy(reservation, "expire");

    if (reservation.status !== "reserved") {
      return {
        outcome: "already_terminal",
        reservation: copyRecord(reservation),
        terminalStatus: terminalStatusOf(reservation, "expire"),
      };
    }
    if (new Date(reservation.expiresAt).getTime() > asOf.getTime()) {
      return { outcome: "not_due", reservation: copyRecord(reservation) };
    }

    await yieldPoint(store);
    const journalEntryId = finishUnspent(store, reservation, {
      status: "expired",
      source: "reservation_expired",
      transition: "expire",
      verb: "Expired",
      options,
    });

    return {
      outcome: "expired",
      reservation: copyRecord(reservation),
      amount: reservation.amount,
      journalEntryId,
    };
  });
}

interface UnspentTransition {
  status: "released" | "expired";
  source: CreditSource;
  transition: "release" | "expire";
  verb: string;
  options?: ReservationTransitionOptions;
}

/**
 * Hand a hold back unspent and journal it.
 *
 * `amount` is 0 because no credits changed hands — the hold only moves back
 * into "available". The hold size stays in metadata, matching the SQL adapter.
 */
function finishUnspent(
  store: MemoryStore,
  reservation: PortableReservation,
  transition: UnspentTransition
): string {
  const credits = requireUser(store, reservation.userId);
  assertReservedCoversHold(
    credits,
    reservation.userId,
    reservation.id,
    reservation.amount
  );

  // Handing a hold back removes only this hold's share of the credits kept solely to
  // back holds. The journal check still runs before the mutation, so a key collision
  // leaves `reserved`, the balance, the status and `completedAt` untouched.
  const inForce = expiredBackingInForce(store, credits);
  const backing = settleExpiredHoldBacking(
    credits.balance,
    inForce.total,
    holdExpiredBacking(reservation, inForce.frontier, inForce.rewrites)
  );
  const nextBalance = sumAmounts(credits.balance, -backing.used);
  const journal: JournalWriteInput = {
    userId: reservation.userId,
    operation: `${transition.transition}Reservation`,
    entryType: "credit",
    amount: 0,
    balanceBefore: sumAmounts(credits.balance, credits.bonusCredits),
    balanceAfter: sumAmounts(nextBalance, credits.bonusCredits),
    source: transition.source,
    reservationId: reservation.id,
    description:
      transition.options?.description ??
      `${transition.verb} ${reservation.amount} reserved credits for ${getOperationLabel(reservation.operationType)}`,
    metadata: {
      ...transition.options?.metadata,
      operationType: reservation.operationType,
      amount: reservation.amount,
      ...(backing.used > 0 ? { expiredCreditsRemoved: backing.used } : {}),
    },
    idempotencyKey: reservationJournalKey(reservation.id, transition.transition),
  };
  const nextReserved = sumAmounts(credits.reserved, -reservation.amount);
  assertRepresentableFields(
    { reserved: nextReserved },
    { userId: reservation.userId, operation: `${transition.transition}Reservation` }
  );
  // The hold's backing share leaves the balance unspent: breakage, as an expiry.
  const lots = planMemoryLots(store, {
    userId: reservation.userId,
    before: bucketsOf(credits),
    after: bucketsAfter(nextBalance, backing.remaining, credits.bonusCredits),
    opRef: `${transition.transition}:${reservation.id}`,
    createdAt: credits.createdAt,
    apply: (plan) =>
      planLotRemoval(plan, {
        bucket: "balance",
        portion: "backing",
        credits: backing.used,
        kind: "expire",
        reason: transition.transition,
        ref: reservation.id,
      }),
  });

  const existingEntryId = planTransitionJournal(store, journal);

  reservation.status = transition.status;
  reservation.completedAt = new Date().toISOString();
  credits.reserved = nextReserved;
  credits.balance = nextBalance;
  writeRecordedShares(store, reservation.userId, inForce);
  Object.assign(
    credits,
    expiredBackingPatch({ total: backing.remaining, frontier: inForce.frontier }, credits)
  );
  credits.updatedAt = new Date().toISOString();
  applyMemoryLots(store, reservation.userId, `${transition.transition}Reservation`, lots);

  return commitTransitionJournal(store, journal, existingEntryId);
}
