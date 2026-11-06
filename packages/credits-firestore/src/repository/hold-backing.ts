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
 * Read-only on purpose. A transaction's writes are bounded by the 10 MiB request
 * limit and a hold count is not, so no share is ever written to a hold: one frontier on
 * the balance document says where the marked credits end, and a closing hold writes its
 * own document and the balance document whatever else is open. A single equality filter
 * needs no composite index.
 */
async function readOpenHolds(
  transaction: Transaction,
  db: Firestore,
  userId: string
): Promise<ExpiredBackingHold[]> {
  const snapshot = await transaction.get(
    getUserReservationsCollection(db, userId)
      .where("status", "==", "reserved")
      .select("amount", "holdPlacedAt")
  );
  return snapshot.docs.map((doc) => {
    const { amount, holdPlacedAt } = doc.data();
    return { id: doc.id, amount, holdPlacedAt };
  });
}

/**
 * The marked credits in force. A total stored without a frontier (written by 2.2.0, or
 * never allocated) is allocated across the open holds now, ahead of whatever is about
 * to happen, so a hold placed or closed next cannot take what belongs to an older one.
 * Stored 2.2.0 shares on hold documents are not read: a total and its order decide them.
 */
export async function readExpiredBacking(
  transaction: Transaction,
  db: Firestore,
  userId: string,
  credits: { balance: number } & ExpiredBackingFields
): Promise<ExpiredBackingAllocation> {
  const total = heldExpiredBacking(credits.balance, credits.expiredHoldBacking);
  if (total > 0 && !credits.expiredBackingFrontier) {
    return allocateExpiredBacking(await readOpenHolds(transaction, db, userId), total);
  }
  return { total, frontier: credits.expiredBackingFrontier ?? null };
}

/**
 * The balance document's fields for a new marked total, compared with what is stored so
 * a bad stored value is overwritten. Call before the transaction's first write.
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
  if (next === stored.expiredHoldBacking && stored.expiredBackingFrontier) return {};
  const holds = await readOpenHolds(transaction, db, userId);
  return expiredBackingPatch(allocateExpiredBacking(holds, next), stored);
}
