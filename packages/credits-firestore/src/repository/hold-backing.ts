import type { Firestore, Transaction } from "firebase-admin/firestore";
import { attributeExpiredBacking, expiredHoldBackingPatch, sumAmounts } from "@nehorai/credits";
import { getUserReservationsCollection } from "./shared.js";
import { toPortableReservation } from "./reservation-crud.js";

/** A change to the marked credits, read in a transaction and not yet written. */
export interface HoldBackingPlan {
  /** The balance document's field, the sum of the shares `write` stores. */
  patch: { expiredHoldBacking?: number };
  write: () => void;
}

/**
 * Attribute a new marked total across the account's open holds.
 *
 * The balance document's `expiredHoldBacking` is always the sum of the holds'
 * `expiredBacking`, so both are written together, by every balance-lowering write, and
 * a closing hold needs only its own document. Reading and writing are separate steps
 * because a transaction reads before it writes. Every write here comes with a balance
 * document write, which serializes it against a hold being placed or closed.
 *
 * An account with no marked credits before or after costs no query and gains no fields.
 */
export async function planHoldBacking(
  transaction: Transaction,
  db: Firestore,
  userId: string,
  next: number,
  stored?: number
): Promise<HoldBackingPlan> {
  if (next <= 0 && !stored) return { patch: {}, write: () => {} };

  const collection = getUserReservationsCollection(db, userId);
  const snapshot = await transaction.get(collection.where("status", "==", "reserved"));
  const holds = snapshot.docs.map((doc) => toPortableReservation(doc.id, doc.data()));
  const shares = attributeExpiredBacking(holds, next);

  return {
    patch: expiredHoldBackingPatch(sumAmounts(...shares.values()), stored),
    write: () => {
      for (const hold of holds) {
        const share = shares.get(hold.id) ?? 0;
        if (share !== (hold.expiredBacking ?? 0)) {
          transaction.update(collection.doc(hold.id), { expiredBacking: share });
        }
      }
    },
  };
}
