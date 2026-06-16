import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type {
  PortableReservation,
  PortableUserCredits,
  CreditOperationType,
} from "@nehorai/credits";
import { getDefaultTier } from "@nehorai/credits";
import {
  getUserCreditsCollection,
  getUserReservationsCollection,
  BALANCE_DOC_ID,
  DEFAULT_FREE_CREDITS,
  getNextMonthStart,
  calculateCreditDeduction,
  toISOString,
} from "./shared.js";
import { validateTransition, isTerminalState } from "./state-machine.js";

/**
 * Internal type for Firestore document data
 */
interface FirestoreUserCredits {
  userId: string;
  balance: number;
  bonusCredits?: number;
  reserved: number;
  tier: string;
  monthlyLimit: number;
  monthlyUsed: number;
  monthlyResetAt: unknown;
  subscriptionExpiresAt?: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

interface FirestoreReservation {
  id: string;
  userId: string;
  amount: number;
  operationType: CreditOperationType;
  status: string;
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
}

/**
 * Atomically reserve credits (check balance, create reservation, update reserved amount)
 */
export async function reserveCreditsAtomic(
  db: Firestore,
  userId: string,
  amount: number,
  operationType: CreditOperationType,
  expiresAt: Date
): Promise<PortableReservation> {
  const creditsCol = getUserCreditsCollection(db, userId);
  const reservationsCol = getUserReservationsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);

  const reservation = await db.runTransaction(async (transaction) => {
    const balanceDoc = await transaction.get(balanceRef);

    // Initialize if not exists
    if (!balanceDoc.exists) {
      const now = new Date();
      const monthlyResetAt = getNextMonthStart(now);

      const initialCredits = {
        userId,
        balance: DEFAULT_FREE_CREDITS,
        bonusCredits: 0,
        reserved: 0,
        tier: getDefaultTier(),
        monthlyLimit: DEFAULT_FREE_CREDITS,
        monthlyUsed: 0,
        monthlyResetAt: monthlyResetAt.toISOString(),
        subscriptionExpiresAt: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      transaction.set(balanceRef, initialCredits);

      // Check if new user has enough
      if (DEFAULT_FREE_CREDITS < amount) {
        throw new Error(
          `Insufficient credits. Available: ${DEFAULT_FREE_CREDITS}, Required: ${amount}`
        );
      }
    } else {
      const data = balanceDoc.data() as FirestoreUserCredits;
      // Available = balance + bonusCredits - reserved
      const bonusCredits = data.bonusCredits ?? 0;
      const available = data.balance + bonusCredits - data.reserved;

      if (available < amount) {
        throw new Error(
          `Insufficient credits. Available: ${available}, Required: ${amount}`
        );
      }
    }

    // Create reservation
    const reservationRef = reservationsCol.doc();
    const now = new Date();

    const reservationData: PortableReservation = {
      id: reservationRef.id,
      userId,
      amount,
      operationType,
      status: "reserved",
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    transaction.set(reservationRef, reservationData);

    // Update balance with reservation
    transaction.update(balanceRef, {
      reserved: FieldValue.increment(amount),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return reservationData;
  });

  return reservation;
}

/**
 * Atomically commit a reservation (deduct credits, update reservation status)
 */
export async function commitReservationAtomic(
  db: Firestore,
  userId: string,
  reservationId: string
): Promise<void> {
  const creditsCol = getUserCreditsCollection(db, userId);
  const reservationsCol = getUserReservationsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);
  const reservationRef = reservationsCol.doc(reservationId);

  await db.runTransaction(async (transaction) => {
    const [reservationDoc, balanceDoc] = await Promise.all([
      transaction.get(reservationRef),
      transaction.get(balanceRef),
    ]);

    if (!reservationDoc.exists) {
      throw new Error(`Reservation ${reservationId} not found`);
    }

    if (!balanceDoc.exists) {
      throw new Error(`User credits not found for userId: ${userId}`);
    }

    const reservation = reservationDoc.data() as FirestoreReservation;
    const credits = balanceDoc.data() as FirestoreUserCredits;

    // Idempotent: a re-delivered commit for an already-committed reservation
    // is a no-op (retry-safe), mirroring release's terminal guard. Committing
    // a released/expired reservation is still a genuine conflict and throws
    // below via validateTransition.
    if (reservation.status === "committed") {
      return;
    }

    // Validate state transition using state machine
    validateTransition(reservation.status as PortableReservation["status"], "committed", reservationId);

    // Calculate how to split deduction between balance and bonusCredits
    // Deduct from balance first, then bonusCredits
    const bonusCredits = credits.bonusCredits ?? 0;
    const { balanceDeduction, bonusDeduction } = calculateCreditDeduction(
      credits.balance,
      bonusCredits,
      reservation.amount
    );

    // Deduct from balance and/or bonusCredits, release reserved
    const updateData: Record<string, unknown> = {
      reserved: FieldValue.increment(-reservation.amount),
      monthlyUsed: FieldValue.increment(reservation.amount),
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (balanceDeduction > 0) {
      updateData.balance = FieldValue.increment(-balanceDeduction);
    }
    if (bonusDeduction > 0) {
      updateData.bonusCredits = FieldValue.increment(-bonusDeduction);
    }

    transaction.update(balanceRef, updateData);

    // Mark reservation as committed
    transaction.update(reservationRef, {
      status: "committed",
      completedAt: new Date().toISOString(),
    });
  });
}

/**
 * Atomically release a reservation (restore reserved credits, update status)
 */
export async function releaseReservationAtomic(
  db: Firestore,
  userId: string,
  reservationId: string
): Promise<void> {
  const creditsCol = getUserCreditsCollection(db, userId);
  const reservationsCol = getUserReservationsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);
  const reservationRef = reservationsCol.doc(reservationId);

  await db.runTransaction(async (transaction) => {
    const reservationDoc = await transaction.get(reservationRef);

    if (!reservationDoc.exists) {
      throw new Error(`Reservation ${reservationId} not found`);
    }

    const reservation = reservationDoc.data() as FirestoreReservation;

    // Check if already in terminal state (committed, released, expired)
    if (isTerminalState(reservation.status as PortableReservation["status"])) {
      // Already processed - log warning and skip (idempotent behavior)
      console.warn(
        `[Credits] Attempted to release already-processed reservation: ` +
        `id=${reservationId}, userId=${userId}, status=${reservation.status}`
      );
      return;
    }

    // Validate state transition using state machine
    validateTransition(reservation.status as PortableReservation["status"], "released", reservationId);

    // Release reserved credits
    transaction.update(balanceRef, {
      reserved: FieldValue.increment(-reservation.amount),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Mark reservation as released
    transaction.update(reservationRef, {
      status: "released",
      completedAt: new Date().toISOString(),
    });
  });
}

/**
 * Atomically expire a reservation (release reserved credits + mark expired).
 *
 * This is the transactional, idempotent primitive used by the cleanup sweep.
 * Unlike a query-then-batch write, it RE-READS the reservation inside the
 * transaction and only releases `reserved` if the reservation is still in the
 * `reserved` state. If another path (commit/release/expire) already settled it
 * between discovery and this call, this is a no-op — preventing the
 * double-decrement that drives `reserved` negative.
 *
 * @returns `{ expired: true, amount }` if this call performed the expiry, or
 *   `{ expired: false, amount: 0 }` if the reservation was already terminal.
 */
export async function expireReservationAtomic(
  db: Firestore,
  userId: string,
  reservationId: string
): Promise<{ expired: boolean; amount: number }> {
  const creditsCol = getUserCreditsCollection(db, userId);
  const reservationsCol = getUserReservationsCollection(db, userId);
  const balanceRef = creditsCol.doc(BALANCE_DOC_ID);
  const reservationRef = reservationsCol.doc(reservationId);

  return db.runTransaction(async (transaction) => {
    const reservationDoc = await transaction.get(reservationRef);

    if (!reservationDoc.exists) {
      throw new Error(`Reservation ${reservationId} not found`);
    }

    const reservation = reservationDoc.data() as FirestoreReservation;

    // Idempotent guard: skip anything already settled (committed/released/
    // expired) so `reserved` is released exactly once, ever.
    if (isTerminalState(reservation.status as PortableReservation["status"])) {
      return { expired: false, amount: 0 };
    }

    // Validate state transition using state machine
    validateTransition(
      reservation.status as PortableReservation["status"],
      "expired",
      reservationId
    );

    // Release reserved credits back to the available pool
    transaction.update(balanceRef, {
      reserved: FieldValue.increment(-reservation.amount),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Mark reservation as expired
    transaction.update(reservationRef, {
      status: "expired",
      completedAt: new Date().toISOString(),
    });

    return { expired: true, amount: reservation.amount };
  });
}
