import type { Firestore } from "firebase-admin/firestore";
import type {
  PortableReservation,
  ReservationStatus,
  CreateReservationInput,
} from "@nehorai/credits";
import { getUserReservationsCollection } from "./shared.js";

/**
 * Create a credit reservation (non-atomic)
 */
export async function createReservation(
  db: Firestore,
  input: CreateReservationInput
): Promise<PortableReservation> {
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

  const data = doc.data();
  return {
    id: data?.id || doc.id,
    userId: data?.userId,
    amount: data?.amount,
    operationType: data?.operationType,
    status: data?.status,
    createdAt: data?.createdAt,
    expiresAt: data?.expiresAt,
    completedAt: data?.completedAt,
  } as PortableReservation;
}

/**
 * Update reservation status
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

  const updateData: Record<string, unknown> = { status };
  if (completedAt) {
    updateData.completedAt = completedAt.toISOString();
  }

  await reservationRef.update(updateData);
}
