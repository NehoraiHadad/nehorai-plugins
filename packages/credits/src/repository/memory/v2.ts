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
  createInvalidAmountError,
  CreditError,
  CreditErrorCode,
} from "../../core/errors.js";
import type {
  CommitOutcome,
  ExpireOutcome,
  ReleaseOutcome,
  ReserveOutcome,
  TerminalReservationStatus,
} from "../../core/outcomes.js";
import type {
  CreditSource,
  PortableJournalEntry,
  PortableReservation,
  PortableUserCredits,
} from "../../core/types.js";
import { getOperationLabel } from "../../config/index.js";
import { generateId } from "../utils.js";
import type {
  ExpireReservationV2Options,
  ReservationTransitionOptions,
  ReserveCreditsV2Input,
} from "../v2-types.js";
import { reservationJournalKey } from "../v2-types.js";
import { MemoryStore, scopedKey } from "./store.js";

/** Yield at the read/write seam so tests can force real interleaving. */
async function yieldPoint(store: MemoryStore): Promise<void> {
  if (store.schedulingHook) await store.schedulingHook();
}

/** Snapshot a reservation so callers cannot mutate stored state through it. */
function snapshot(reservation: PortableReservation): PortableReservation {
  return { ...reservation };
}

function terminalStatusOf(reservation: PortableReservation): TerminalReservationStatus {
  return reservation.status as TerminalReservationStatus;
}

function getReservation(
  store: MemoryStore,
  userId: string,
  reservationId: string
): PortableReservation | undefined {
  return store.reservations.get(userId)?.get(reservationId);
}

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
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw createInvalidAmountError(input.amount);
  }

  return store.locks.run(input.userId, async () => {
    if (input.idempotencyKey) {
      const existingId = store.reservationKeys.get(
        scopedKey(input.userId, input.idempotencyKey)
      );
      if (existingId) {
        const existing = getReservation(store, input.userId, existingId);
        if (existing) {
          // `expiresAt` is excluded on purpose: a retry legitimately computes a
          // later deadline and that must not read as a conflict.
          const samePayload =
            existing.amount === input.amount &&
            existing.operationType === input.operationType;
          return samePayload
            ? { outcome: "replayed", reservation: snapshot(existing) }
            : {
                outcome: "idempotency_conflict",
                idempotencyKey: input.idempotencyKey,
                existing: snapshot(existing),
              };
        }
      }
    }

    const credits = requireUser(store, input.userId);
    const available = credits.balance + credits.bonusCredits - credits.reserved;
    await yieldPoint(store);
    if (available < input.amount) {
      return {
        outcome: "insufficient",
        available,
        required: input.amount,
        shortfall: input.amount - available,
      };
    }

    const now = new Date().toISOString();
    const reservation: PortableReservation = {
      id: generateId(),
      userId: input.userId,
      amount: input.amount,
      operationType: input.operationType,
      status: "reserved",
      createdAt: now,
      expiresAt: input.expiresAt.toISOString(),
      idempotencyKey: input.idempotencyKey,
    };

    if (!store.reservations.has(input.userId)) {
      store.reservations.set(input.userId, new Map());
    }
    store.reservations.get(input.userId)!.set(reservation.id, reservation);
    if (input.idempotencyKey) {
      store.reservationKeys.set(
        scopedKey(input.userId, input.idempotencyKey),
        reservation.id
      );
    }

    credits.reserved += input.amount;
    credits.updatedAt = now;

    return { outcome: "created", reservation: snapshot(reservation) };
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
    if (reservation.status !== "reserved") {
      return {
        outcome: "already_terminal",
        reservation: snapshot(reservation),
        terminalStatus: terminalStatusOf(reservation),
      };
    }

    const credits = requireUser(store, userId);
    const amount = reservation.amount;
    await yieldPoint(store);
    if (credits.balance + credits.bonusCredits < amount) {
      throw new CreditError(
        `Insufficient credits to commit reservation ${reservationId}`,
        CreditErrorCode.INSUFFICIENT_CREDITS,
        { userId, reservationId, required: amount }
      );
    }

    reservation.status = "committed";
    reservation.completedAt = new Date().toISOString();

    // Drain `balance` before `bonusCredits`, matching the SQL adapter.
    const fromBalance = Math.min(credits.balance, amount);
    credits.balance -= fromBalance;
    credits.bonusCredits -= amount - fromBalance;
    credits.reserved = Math.max(credits.reserved - amount, 0);
    credits.monthlyUsed += amount;
    credits.updatedAt = new Date().toISOString();

    const journalEntryId = writeTransitionJournal(store, {
      userId,
      entryType: "debit",
      amount,
      balanceAfter: credits.balance + credits.bonusCredits,
      source: "operation_commit",
      reservationId,
      description:
        options?.description ??
        `Committed ${amount} credits for ${getOperationLabel(reservation.operationType)}`,
      metadata: { operationType: reservation.operationType, ...options?.metadata },
      idempotencyKey: reservationJournalKey(reservationId, "commit"),
    });

    return {
      outcome: "committed",
      reservation: snapshot(reservation),
      amount,
      balanceAfter: credits.balance + credits.bonusCredits,
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
    if (reservation.status !== "reserved") {
      return {
        outcome: "already_terminal",
        reservation: snapshot(reservation),
        terminalStatus: terminalStatusOf(reservation),
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
      reservation: snapshot(reservation),
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
    if (reservation.status !== "reserved") {
      return {
        outcome: "already_terminal",
        reservation: snapshot(reservation),
        terminalStatus: terminalStatusOf(reservation),
      };
    }
    if (new Date(reservation.expiresAt).getTime() > asOf.getTime()) {
      return { outcome: "not_due", reservation: snapshot(reservation) };
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
      reservation: snapshot(reservation),
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
  reservation.status = transition.status;
  reservation.completedAt = new Date().toISOString();
  credits.reserved = Math.max(credits.reserved - reservation.amount, 0);
  credits.updatedAt = new Date().toISOString();

  return writeTransitionJournal(store, {
    userId: reservation.userId,
    entryType: "credit",
    amount: 0,
    balanceAfter: credits.balance + credits.bonusCredits,
    source: transition.source,
    reservationId: reservation.id,
    description:
      transition.options?.description ??
      `${transition.verb} ${reservation.amount} reserved credits for ${getOperationLabel(reservation.operationType)}`,
    metadata: {
      operationType: reservation.operationType,
      amount: reservation.amount,
      ...transition.options?.metadata,
    },
    idempotencyKey: reservationJournalKey(reservation.id, transition.transition),
  });
}

interface JournalWriteInput {
  userId: string;
  entryType: "debit" | "credit";
  amount: number;
  balanceAfter: number;
  source: CreditSource;
  reservationId: string;
  description: string;
  metadata?: Record<string, unknown>;
  idempotencyKey: string;
}

/** Write the one journal entry for a transition, honouring the unique key. */
function writeTransitionJournal(store: MemoryStore, input: JournalWriteInput): string {
  const key = scopedKey(input.userId, input.idempotencyKey);
  const existingId = store.journalKeys.get(key);
  if (existingId) return existingId;

  const entry: PortableJournalEntry = {
    id: generateId(),
    userId: input.userId,
    entryType: input.entryType,
    amount: input.amount,
    balanceAfter: input.balanceAfter,
    source: input.source,
    referenceId: input.reservationId,
    referenceType: "reservation",
    description: input.description,
    metadata: input.metadata,
    idempotencyKey: input.idempotencyKey,
    createdAt: new Date().toISOString(),
  };

  if (!store.journalEntries.has(input.userId)) {
    store.journalEntries.set(input.userId, []);
  }
  store.journalEntries.get(input.userId)!.push(entry);
  store.journalKeys.set(key, entry.id);
  return entry.id;
}
