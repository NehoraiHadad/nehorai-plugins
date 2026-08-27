/**
 * Deterministic journal writes for the in-memory V2 transitions.
 *
 * The SQL adapter gets this from a partial unique index plus an
 * `ON CONFLICT DO NOTHING` that re-reads and compares the losing row. There is
 * no index here, so the same contract has to be built by hand — and it has to
 * be the *same* contract, or the shared reservation tests prove nothing about
 * the adapter anyone actually ships.
 *
 * Two properties matter. A key that already exists must be accepted only when
 * the stored row describes the identical event, so a wrong row pre-seeded
 * through the public `createJournalEntry` cannot make a transition report a
 * charge the ledger does not record. And the check has to happen *before* the
 * balances move: this store has no transaction to roll back, so a throw after
 * mutation would leave the ledger half-transitioned.
 */

import { assertRepresentableFields, sameAmount } from "../../core/amount.js";
import { CreditError, CreditErrorCode } from "../../core/errors.js";
import type { CreditSource, PortableJournalEntry } from "../../core/types.js";
import { generateId } from "../utils.js";
import { MemoryStore, scopedKey } from "./store.js";

export interface JournalWriteInput {
  userId: string;
  /** The transition writing this entry, so a refusal names what was refused. */
  operation: string;
  entryType: "debit" | "credit";
  amount: number;
  balanceAfter: number;
  source: CreditSource;
  reservationId: string;
  description: string;
  metadata?: Record<string, unknown>;
  idempotencyKey: string;
}

/** Name the first field an existing entry disagrees on, or `null` if it matches. */
function describeJournalMismatch(
  row: PortableJournalEntry,
  input: JournalWriteInput
): string | null {
  if (row.userId !== input.userId) return "user_id";
  if (row.entryType !== input.entryType) return "entry_type";
  if (!sameAmount(row.amount, input.amount)) return "amount";
  if (!sameAmount(row.balanceAfter, input.balanceAfter)) return "balance_after";
  if (row.source !== input.source) return "source";
  if (row.referenceId !== input.reservationId) return "reference_id";
  if (row.referenceType !== "reservation") return "reference_type";

  // Only the fields this adapter sets deterministically. Caller-supplied extras
  // are free-form and may legitimately differ between a request and its retry,
  // so they are not part of the identity of the event.
  const existingMeta = (row.metadata ?? {}) as Record<string, unknown>;
  const expectedMeta = (input.metadata ?? {}) as Record<string, unknown>;
  if (existingMeta.operationType !== expectedMeta.operationType) {
    return "metadata.operationType";
  }
  const hadAmount = existingMeta.amount !== undefined;
  const wantsAmount = expectedMeta.amount !== undefined;
  if (hadAmount !== wantsAmount) return "metadata.amount";
  if (wantsAmount && !sameAmount(existingMeta.amount, expectedMeta.amount)) {
    return "metadata.amount";
  }
  return null;
}

function findEntry(
  store: MemoryStore,
  userId: string,
  entryId: string
): PortableJournalEntry | undefined {
  return store.journalEntries.get(userId)?.find((entry) => entry.id === entryId);
}

/**
 * Decide what the journal write will do — without doing it.
 *
 * Returns the id of an existing, exactly matching entry to reuse, or
 * `undefined` when a fresh row is needed. Throws when the key is taken by a
 * different event, and it throws *here*, before the caller has touched a single
 * balance.
 */
export function planTransitionJournal(
  store: MemoryStore,
  input: JournalWriteInput
): string | undefined {
  // `balanceAfter` is a derived total, and every transition journal write
  // passes through this preflight before the ledger moves. Validating it here
  // rather than at each call site means a transition added later cannot forget
  // it, and a total the numeric column could not hold refuses while the
  // balances are still untouched.
  assertRepresentableFields(
    { amount: input.amount, "journal balanceAfter": input.balanceAfter },
    { userId: input.userId, reservationId: input.reservationId, operation: input.operation }
  );

  const existingId = store.journalKeys.get(scopedKey(input.userId, input.idempotencyKey));
  if (!existingId) return undefined;

  const row = findEntry(store, input.userId, existingId);
  const mismatch = row
    ? describeJournalMismatch(row, input)
    : "the key is registered but its entry is missing";
  if (mismatch) {
    throw new CreditError(
      `Journal key ${input.idempotencyKey} is already used by a different entry ` +
        `(${mismatch}). The transition was refused rather than reported as applied.`,
      CreditErrorCode.DATABASE_ERROR,
      {
        idempotencyKey: input.idempotencyKey,
        reservationId: input.reservationId,
        mismatch,
      }
    );
  }
  return existingId;
}

/**
 * Perform the write the preflight authorised.
 *
 * `existingId` is whatever {@link planTransitionJournal} returned for this same
 * input; passing it through keeps the decision and the write from drifting
 * apart, which is the whole point of splitting them.
 */
export function commitTransitionJournal(
  store: MemoryStore,
  input: JournalWriteInput,
  existingId: string | undefined
): string {
  if (existingId) return existingId;

  const entry: PortableJournalEntry = {
    id: generateId(),
    userId: input.userId,
    entryType: input.entryType,
    amount: input.amount,
    balanceAfter: input.balanceAfter,
    source: input.source,
    referenceId: input.reservationId,
    referenceType: "reservation",
    description: input.description,
    metadata: input.metadata,
    idempotencyKey: input.idempotencyKey,
    createdAt: new Date().toISOString(),
  };

  if (!store.journalEntries.has(input.userId)) {
    store.journalEntries.set(input.userId, []);
  }
  store.journalEntries.get(input.userId)!.push(entry);
  store.journalKeys.set(scopedKey(input.userId, input.idempotencyKey), entry.id);
  return entry.id;
}
