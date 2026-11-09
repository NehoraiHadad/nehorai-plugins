import type { Firestore } from "firebase-admin/firestore";
import type {
  PortableReservation,
  ReservationStatus,
  CreateReservationInput,
} from "@nehorai/credits";
import {
  assertDirectStatusWriteAllowed,
  assertUnkeyedDirectReservation,
  assertValidCreditAmount,
  createReservationNotFoundError,
} from "@nehorai/credits";
import { getUserReservationsCollection } from "./shared.js";

/**
 * Map a stored reservation document to the portable shape.
 *
 * `holdPlacedAt` and `idempotencyKey` are carried through because the V2
 * transitions decide on them; dropping them here would make every backed hold
 * read as unbacked.
 */
export function toPortableReservation(
  id: string,
  data: Record<string, unknown>
): PortableReservation {
  return {
    id: (data.id as string | undefined) || id,
    userId: data.userId,
    amount: data.amount,
    operationType: data.operationType,
    status: data.status,
    createdAt: data.createdAt,
    expiresAt: data.expiresAt,
    completedAt: data.completedAt,
    ...(data.idempotencyKey ? { idempotencyKey: data.idempotencyKey } : {}),
    ...(data.holdPlacedAt ? { holdPlacedAt: data.holdPlacedAt } : {}),
    ...(data.expiredBacking !== undefined ? { expiredBacking: data.expiredBacking } : {}),
    ...(data.lotDraws ? { lotDraws: data.lotDraws } : {}),
    ...(data.lotTotals ? { lotTotals: data.lotTotals } : {}),
  } as PortableReservation;
}

/**
 * Create a credit reservation record (non-atomic).
 *
 * Record-only: it places no hold, so the row carries no `holdPlacedAt` and the
 * V2 transitions refuse it. Holds go through `reserveCreditsAtomic` /
 * `reserveCreditsV2`.
 */
export async function createReservation(
  db: Firestore,
  input: CreateReservationInput
): Promise<PortableReservation> {
  assertValidCreditAmount(input.amount, { userId: input.userId, operation: "createReservation" });
  assertUnkeyedDirectReservation(input);

  const reservationsCol = getUserReservationsCollection(db, input.userId);
  const reservationRef = reservationsCol.doc();
  const now = new Date();

  const reservationData: PortableReservation = {
    id: reservationRef.id,
    userId: input.userId,
    amount: input.amount,
    operationType: input.operationType,
    status: "reserved",
    createdAt: now.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  };

  await reservationRef.set(reservationData);

  return reservationData;
}

/**
 * Get a reservation by ID
 */
export async function getReservation(
  db: Firestore,
  userId: string,
  reservationId: string
): Promise<PortableReservation | null> {
  const reservationsCol = getUserReservationsCollection(db, userId);
  const doc = await reservationsCol.doc(reservationId).get();

  if (!doc.exists) {
    return null;
  }

  return toPortableReservation(doc.id, doc.data() ?? {});
}

/**
 * Update reservation status on a record-only row.
 *
 * Refuses rows backed by a placed hold and any reopening to `reserved`: those
 * statuses belong to the transitions that move the credits with them.
 */
export async function updateReservationStatus(
  db: Firestore,
  userId: string,
  reservationId: string,
  status: ReservationStatus,
  completedAt?: Date
): Promise<void> {
  const reservationsCol = getUserReservationsCollection(db, userId);
  const reservationRef = reservationsCol.doc(reservationId);

  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(reservationRef);
    if (!doc.exists) throw createReservationNotFoundError(reservationId);
    assertDirectStatusWriteAllowed(toPortableReservation(doc.id, doc.data() ?? {}), status);

    const updateData: Record<string, unknown> = { status };
    if (completedAt) {
      updateData.completedAt = completedAt.toISOString();
    }
    transaction.update(reservationRef, updateData);
  });
}
