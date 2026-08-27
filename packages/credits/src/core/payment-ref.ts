/**
 * `paymentRef` as a global, semantic idempotency boundary.
 *
 * A payment reference is the identity of a *credit event* — one webhook, one
 * invoice, one charge. It is deliberately not scoped to a user: a processor's
 * reference is unique across the processor's whole account, and the SQL adapter
 * has always enforced it with a unique index over `payment_ref` alone. Two
 * problems followed from treating it as anything less.
 *
 * **It was scoped per user in memory and globally in SQL.** The in-memory
 * adapter searched only the crediting user's own transactions, so replaying a
 * reference against a *different* user credited both accounts, while the SQL
 * adapter silently no-opped. Same call, two ledgers, opposite results — and the
 * memory one is the direction that invents money.
 *
 * **It was compared on presence, never on payload.** A reference that arrived a
 * second time carrying a different amount was accepted as a replay of the
 * first, so a corrected or spoofed webhook credited the original amount and
 * reported success. Presence is only sound when the payload is known to match;
 * otherwise the honest answer is a conflict.
 *
 * So a reference now resolves to exactly one of three outcomes — `created`,
 * `replayed`, `conflict` — in both adapters, and `conflict` mutates nothing.
 */

import { sameAmount } from "./amount.js";
import { CreditError, CreditErrorCode } from "./errors.js";
import type {
  CreditSource,
  JournalReferenceType,
  PortableTransaction,
} from "./types.js";

/**
 * The fields that define the credit event a reference names.
 *
 * `description` is excluded on purpose: it is human-facing copy that a retry
 * may legitimately regenerate ("Purchase 100 credits" versus "Purchase of 100
 * credits") without the event being different. Everything that decides *how
 * much lands where* is in.
 */
export interface PaymentEventPayload {
  userId: string;
  amount: number;
  /** The transaction row's `type` — the operation the reference names. */
  type: PortableTransaction["type"];
  /** The journal entry's `source` — where the credits came from. */
  source: CreditSource;
  /** The journal entry's `referenceType`. */
  referenceType: JournalReferenceType;
}

/**
 * The stored side of the comparison, as either adapter can produce it.
 *
 * `amount` is `unknown` because SQL returns `numeric` as a string, and
 * comparing the mapped `Number` is exactly the rounding hole that let
 * `9999999999.9900001` match a request for `9999999999.99`.
 */
export interface StoredPaymentEvent {
  userId: string;
  amount: unknown;
  type: string;
  /** Absent when no journal entry could be located for the stored transaction. */
  source?: string;
  referenceType?: string;
}

/**
 * Normalise a payment reference to "a reference" or "no reference".
 *
 * Empty and whitespace-only strings are *not* references: they cannot identify
 * a payment, and treating them as one produced the divergence where SQL skipped
 * the duplicate check (falsy) but still stored the value, so the replay hit the
 * unique index and threw while memory quietly credited twice.
 *
 * Unlike an idempotency key, a blank reference is normalised rather than
 * rejected. A key is the caller's explicit request for exactly-once and a blank
 * one means they got it wrong; `paymentRef` is an optional annotation on a
 * credit, and an absent one is a normal, supported call.
 */
export function normalizePaymentRef(ref?: string | null): string | undefined {
  if (typeof ref !== "string") return undefined;
  const trimmed = ref.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Name the first field on which a stored credit event disagrees, or `null`.
 *
 * `null` means the delivery is a genuine replay and must change nothing.
 * Anything else is a conflict: the same reference was used for a different
 * event, and crediting on it would either double-credit or credit the wrong
 * amount to the wrong account.
 *
 * `source` and `referenceType` are compared only when the stored side has them.
 * They live on the journal entry, and a transaction written before this library
 * journalled its purchases has none to compare against — treating that absence
 * as a mismatch would turn every pre-existing reference into a permanent
 * conflict, which is a refusal to credit rather than a protection against one.
 */
export function describePaymentMismatch(
  stored: StoredPaymentEvent,
  expected: PaymentEventPayload
): string | null {
  if (stored.userId !== expected.userId) return "userId";
  if (!sameAmount(stored.amount, expected.amount)) return "amount";
  if (stored.type !== expected.type) return "type";
  if (stored.source !== undefined && stored.source !== expected.source) return "source";
  if (stored.referenceType !== undefined && stored.referenceType !== expected.referenceType) {
    return "referenceType";
  }
  return null;
}

/**
 * Refuse a payment reference on the direct, record-only transaction writer.
 *
 * `createTransaction` writes a ledger *record*: no balance moves and no journal
 * entry is created. But a `paymentRef` on that record still occupies the global
 * unique boundary, and `addCreditsV2` treats the row that holds a reference as
 * the authoritative credit event — a later delivery of the real payment with
 * the same reference then matches the record on user/amount/type, reports
 * `replayed`, and credits nothing, forever. The record would have consumed the
 * payment.
 *
 * Same shape as `assertUnkeyedDirectReservation`: the claim is refused at the
 * boundary, so the row that could impersonate a credit event cannot be written
 * in the first place. Credits that carry a reference go through
 * `addCreditsAtomic` / `addCreditsV2`, which claim the reference and move the
 * balance in one atomic step.
 */
export function assertUnreferencedDirectTransaction(input: {
  userId: string;
  paymentRef?: string;
}): void {
  if (normalizePaymentRef(input.paymentRef) === undefined) return;
  throw new CreditError(
    "createTransaction cannot accept a paymentRef: it records a transaction " +
      "without crediting the account, and the reference would then be treated " +
      "as an already-delivered payment — a later addCredits call with the same " +
      "reference reports `replayed` and credits nothing. Record unreferenced " +
      "transactions here, or deliver referenced payments through addCredits " +
      "(addCreditsAtomic / addCreditsV2), which claims the reference and moves " +
      "the balance atomically.",
    CreditErrorCode.UNSUPPORTED_OPERATION,
    {
      userId: input.userId,
      paymentRef: input.paymentRef,
      operation: "createTransaction",
      reason: "referenced_direct_transaction",
    }
  );
}

/**
 * The conflict, as an error, for the legacy `addCreditsAtomic` signature.
 *
 * That method returns `void`, so it has nowhere to put a `conflict` outcome.
 * Swallowing one would be the original bug in a new place — the SQL adapter
 * used to no-op on a cross-user reference reuse, which reads to the caller as
 * "credited" — so the legacy path throws instead. Callers that want to *handle*
 * a conflict rather than catch it should use `addCreditsV2`.
 */
export function createPaymentRefConflictError(
  paymentRef: string,
  details: { userId: string; mismatch: string; existingUserId?: string }
): CreditError {
  return new CreditError(
    `Payment reference ${paymentRef} has already been used for a different credit ` +
      `event (${details.mismatch} differs). Nothing was credited. A payment reference ` +
      "identifies one credit event globally; reusing it for another user, amount or " +
      "source is refused rather than silently ignored.",
    CreditErrorCode.IDEMPOTENCY_CONFLICT,
    { paymentRef, reason: "payment_ref_conflict", ...details }
  );
}
