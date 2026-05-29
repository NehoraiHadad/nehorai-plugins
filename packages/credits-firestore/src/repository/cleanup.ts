import type { Firestore } from "firebase-admin/firestore";
import { COLLECTIONS, getErrorMessage } from "./shared.js";
import { expireReservationAtomic } from "./reservation-atomic.js";

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
 * How many expirations to settle concurrently per batch. Each settlement is an
 * independent Firestore transaction, so this bounds parallelism without
 * overwhelming the backend during the (daily) sweep.
 */
const EXPIRE_CONCURRENCY = 10;

/**
 * Process a single batch of expired reservations.
 *
 * The collection-group query is used only to DISCOVER candidates; the actual
 * settlement of each one goes through `expireReservationAtomic`, which re-reads
 * the reservation inside a transaction and releases `reserved` only if it is
 * still in the `reserved` state. This replaces the previous query-then-
 * unconditional-`db.batch()` approach, which could decrement `reserved` a
 * second time when a reservation was committed/released between the query and
 * the write — the root cause of negative `reserved` drift.
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
    // Query expired reservations using collection group query (discovery only)
    const expiredReservationsSnapshot = await db
      .collectionGroup(COLLECTIONS.reservations)
      .where("status", "==", "reserved")
      .where("expiresAt", "<", now.toISOString())
      .orderBy("expiresAt", "asc")
      .limit(batchSize)
      .get();

    const docs = expiredReservationsSnapshot.docs;
    const processedCount = docs.length;

    // Settle each candidate atomically, with bounded concurrency.
    for (let i = 0; i < docs.length; i += EXPIRE_CONCURRENCY) {
      const chunk = docs.slice(i, i + EXPIRE_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (reservationDoc) => {
          const { userId } = reservationDoc.data() as FirestoreReservation;
          try {
            return await expireReservationAtomic(db, userId, reservationDoc.id);
          } catch (error) {
            errors.push(
              `Failed to process reservation ${reservationDoc.id}: ${getErrorMessage(error)}`
            );
            return { expired: false, amount: 0 };
          }
        })
      );

      for (const result of results) {
        if (result.expired) {
          expiredCount++;
          creditsReleased += result.amount;
        }
      }
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
