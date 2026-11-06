import type { Firestore, Transaction } from "firebase-admin/firestore";
import {
  allocateExpiredBacking,
  expiredBackingPatch,
  heldExpiredBacking,
} from "@nehorai/credits";
import type {
  ExpiredBackingAllocation,
  ExpiredBackingFields,
  ExpiredBackingHold,
} from "@nehorai/credits";
import { getUserReservationsCollection } from "./shared.js";

/**
 * The account's open holds, only the fields that decide a share.
 *
 * One read per open hold, in the transaction. Firestore sets no limit on the documents a
 * transaction reads; what ends one is its 270 second lifetime and 60 second idle expiry.
 * Past those the query or the commit fails, the client retries, the error reaches the
 * caller and nothing is written, so a walk too long to finish refuses the operation and
 * never settles on part of the holds. It runs once when an account with marks and no
 * frontier is first closed or reserved on, and when a write changes a positive total.
 * A single equality filter needs no composite index.
 *
 * Writes are not proportional to the open holds. A transaction's writes are bounded by
 * the 10 MiB request limit, so one frontier on the balance document says where the marked
 * credits end, and a closing hold writes its own document and the balance document.
 */
async function readOpenHolds(
  transaction: Transaction,
  db: Firestore,
  userId: string
): Promise<ExpiredBackingHold[]> {
  const snapshot = await transaction.get(
    getUserReservationsCollection(db, userId)
      .where("status", "==", "reserved")
      .select("amount", "holdPlacedAt", "expiredBacking")
  );
  return snapshot.docs.map((doc) => {
    const { amount, holdPlacedAt, expiredBacking } = doc.data();
    return { id: doc.id, amount, holdPlacedAt, expiredBacking };
  });
}

/**
 * Place a total on the open holds and write the stored shares that changed. Call it only
 * after the transaction's last read: nothing but writes may follow.
 */
async function allocateOnOpenHolds(
  transaction: Transaction,
  db: Firestore,
  userId: string,
  total: number
): Promise<ExpiredBackingAllocation> {
  const allocation = allocateExpiredBacking(await readOpenHolds(transaction, db, userId), total);
  const holds = getUserReservationsCollection(db, userId);
  for (const { id, expiredBacking } of allocation.rewrites ?? []) {
    transaction.update(holds.doc(id), { expiredBacking });
  }
  return allocation;
}

/**
 * The marked credits in force. A total stored without a frontier (written by 2.2.0, or
 * never allocated), or one the balance had to cut, is placed on the open holds now, ahead
 * of whatever is about to happen, so a hold placed or closed next cannot take what belongs
 * to another. Call it after the transaction's last read.
 */
export async function readExpiredBacking(
  transaction: Transaction,
  db: Firestore,
  userId: string,
  credits: { balance: number; expiredHoldBacking?: number; stored: ExpiredBackingFields }
): Promise<ExpiredBackingAllocation> {
  const { stored } = credits;
  const total = heldExpiredBacking(credits.balance, credits.expiredHoldBacking);
  if (total > 0 && (!stored.expiredBackingFrontier || stored.expiredHoldBacking !== total)) {
    return allocateOnOpenHolds(transaction, db, userId, total);
  }
  return { total, frontier: stored.expiredBackingFrontier ?? null };
}

/**
 * The balance document's fields for a marked total, compared with what is stored so a bad
 * stored value is overwritten. Every write to a balance document goes through this or
 * through {@link readExpiredBacking}. Call it after the transaction's last read.
 *
 * An account with no marked credits before or after costs no query and gains no fields,
 * and neither a clear nor an unchanged total reads a hold.
 */
export async function planHoldBacking(
  transaction: Transaction,
  db: Firestore,
  userId: string,
  next: number,
  stored: ExpiredBackingFields
): Promise<ExpiredBackingFields> {
  if (next <= 0) return expiredBackingPatch({ total: 0 }, stored);
  if (next === stored.expiredHoldBacking) return {};
  return expiredBackingPatch(await allocateOnOpenHolds(transaction, db, userId, next), stored);
}
