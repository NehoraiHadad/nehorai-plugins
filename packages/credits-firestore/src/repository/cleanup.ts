import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type { PortableReservation } from "@nehorai/credits";
import {
  getUserCreditsCollection,
  COLLECTIONS,
  BALANCE_DOC_ID,
  getErrorMessage,
} from "./shared";
import { validateTransition } from "./state-machine";

/**
 * Internal type for Firestore reservation document
 */
interface FirestoreReservation {
  id: string;
  userId: string;
  amount: number;
  operationType: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
}

/**
 * Process a single batch of expired reservations
 *
 * Internal helper function that processes one batch of expired reservations
 * and returns the results.
 */
async function processExpiredBatch(
  db: Firestore,
  batchSize: number
): Promise<{
  expiredCount: number;
  creditsReleased: number;
  processedCount: number;
  errors: string[];
}> {
  const now = new Date();
  let expiredCount = 0;
  let creditsReleased = 0;
  const errors: string[] = [];

  try {
    // Query expired reservations using collection group query
    const expiredReservationsSnapshot = await db
      .collectionGroup(COLLECTIONS.reservations)
      .where("status", "==", "reserved")
      .where("expiresAt", "<", now.toISOString())
      .orderBy("expiresAt", "asc")
      .limit(batchSize)
      .get();

    const processedCount = expiredReservationsSnapshot.docs.length;

    // Process expired reservations in batches
    // Firestore supports max 500 operations per batch
    const FIRESTORE_BATCH_SIZE = 500;
    const batches: FirebaseFirestore.WriteBatch[] = [];
    let currentBatch = db.batch();
    let operationCount = 0;

    for (const reservationDoc of expiredReservationsSnapshot.docs) {
      try {
        const reservation = reservationDoc.data() as FirestoreReservation;
        const { userId, amount, status, id } = reservation;

        // Validate state transition using state machine
        validateTransition(status as PortableReservation["status"], "expired", id);

        // Get references
        const creditsCol = getUserCreditsCollection(db, userId);
        const balanceRef = creditsCol.doc(BALANCE_DOC_ID);

        // Update reservation status to expired
        currentBatch.update(reservationDoc.ref, {
          status: "expired",
          completedAt: now.toISOString(),
        });

        // Release reserved credits back to balance
        currentBatch.update(balanceRef, {
          reserved: FieldValue.increment(-amount),
          updatedAt: FieldValue.serverTimestamp(),
        });

        operationCount += 2; // Two operations per reservation
        expiredCount++;
        creditsReleased += amount;

        // Start new batch if we hit Firestore limit
        if (operationCount >= FIRESTORE_BATCH_SIZE) {
          batches.push(currentBatch);
          currentBatch = db.batch();
          operationCount = 0;
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        errors.push(
          `Failed to process reservation ${reservationDoc.id}: ${errorMessage}`
        );
      }
    }

    // Add final batch if it has operations
    if (operationCount > 0) {
      batches.push(currentBatch);
    }

    // Commit all batches
    for (const batch of batches) {
      await batch.commit();
    }

    return {
      expiredCount,
      creditsReleased,
      processedCount,
      errors,
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    errors.push(`Cleanup query failed: ${errorMessage}`);
    return {
      expiredCount: 0,
      creditsReleased: 0,
      processedCount: 0,
      errors,
    };
  }
}

/**
 * Find and expire reservations with pagination (cleanup operation)
 *
 * This function queries across all users' reservation subcollections using
 * a collection group query, then processes expired reservations in batches
 * with pagination support.
 *
 * Continues processing until fewer items than batchSize are returned or
 * maxIterations is reached (safety limit to prevent infinite loops).
 *
 * Firestore batch limit: 500 operations per batch
 */
export async function findAndExpireReservations(
  db: Firestore,
  batchSize = 100,
  maxIterations = 100
): Promise<{
  expiredCount: number;
  creditsReleased: number;
  errors: string[];
}> {
  let totalExpiredCount = 0;
  let totalCreditsReleased = 0;
  const allErrors: string[] = [];
  let iteration = 0;
  let hasMore = true;

  while (hasMore && iteration < maxIterations) {
    iteration++;
    const result = await processExpiredBatch(db, batchSize);

    totalExpiredCount += result.expiredCount;
    totalCreditsReleased += result.creditsReleased;
    allErrors.push(...result.errors);

    // Stop if fewer items than batch size (no more to process)
    hasMore = result.processedCount >= batchSize;
  }

  if (iteration >= maxIterations) {
    allErrors.push(`Reached max iterations limit (${maxIterations})`);
  }

  return {
    expiredCount: totalExpiredCount,
    creditsReleased: totalCreditsReleased,
    errors: allErrors,
  };
}
