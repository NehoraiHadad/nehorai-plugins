import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type {
  PortableReservation,
  PortableUserCredits,
  CreditOperationType,
} from "@nehorai/credits";
import {
  getUserCreditsCollection,
  getUserReservationsCollection,
  BALANCE_DOC_ID,
  DEFAULT_FREE_CREDITS,
  getNextMonthStart,
  calculateCreditDeduction,
  toISOString,
} from "./shared";
import { validateTransition, isTerminalState } from "./state-machine";

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
        tier: "free",
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
