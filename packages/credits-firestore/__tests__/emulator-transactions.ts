import type { Firestore } from "firebase-admin/firestore";

/**
 * Production Firestore reports a transaction whose id it dropped as INVALID_ARGUMENT
 * "transaction has expired", and the SDK retries exactly that message
 * (`isRetryableTransactionError` in @google-cloud/firestore's transaction.js). The
 * emulator reports the same case as "Transaction is invalid or closed" — after its
 * lock-acquire timeout under contention — which the SDK does not recognise and
 * surfaces. This gives the emulator's wording the retry production's already gets,
 * so a contended test exercises production's behaviour instead of the emulator's.
 */
const EMULATOR_CLOSED_TRANSACTION = /Transaction is invalid or closed/;
const MAX_ATTEMPTS = 5; // the SDK's own default for runTransaction

export function retryEmulatorClosedTransactions(db: Firestore): Firestore {
  const run = db.runTransaction.bind(db);
  db.runTransaction = (async (updateFunction, options) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run(updateFunction, options);
      } catch (error) {
        const closed = error instanceof Error && EMULATOR_CLOSED_TRANSACTION.test(error.message);
        if (!closed || attempt >= MAX_ATTEMPTS) throw error;
      }
    }
  }) as Firestore["runTransaction"];
  return db;
}
