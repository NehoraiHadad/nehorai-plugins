/**
 * The repository surface for credit lots. Optional on `ICreditRepository`; probe it with
 * `supportsLots`, which is true only when the repository records lots now.
 */

import type { LotEvent, LotHeader, LotLedgerState } from "../core/lots.js";

/** A refund or chargeback against one lot. */
export interface ReverseLotInput {
  userId: string;
  lotId: string;
  kind: "refund" | "chargeback";
  /**
   * Unique per user for this reversal, e.g. the provider's refund id. A repeat with the
   * same lot and kind changes nothing and reports `replayed`.
   */
  reversalKey: string;
  /** Money returned to the customer, whole USD micros, on the lot's value basis (net of VAT). */
  refundMicros: number;
  /** Chargeback only: the provider's dispute fee, whole USD micros. */
  chargebackFeeMicros?: number;
  /** At most this many credits are taken back. Default: all the lot's spendable credits. */
  credits?: number;
  /** The journal line's description. */
  description?: string;
  /** Merged onto the journal line's metadata. */
  metadata?: Record<string, unknown>;
}

export type ReverseLotOutcome =
  | {
      outcome: "reversed";
      event: LotEvent;
      /** Credits taken out of the lot's bucket. */
      creditsRemoved: number;
      journalEntryId: string;
    }
  /** The key was used before, for this lot and kind. Nothing was written. */
  | { outcome: "replayed"; event: LotEvent }
  /** The key was used before for another lot or kind. Nothing was written. */
  | { outcome: "conflict"; event: LotEvent; mismatch: "lotId" | "kind" }
  /** The account has no such lot, open or closed. Nothing was written. */
  | { outcome: "not_found"; lotId: string };

/** An account's lot ledger as stored. */
export interface LotLedgerView {
  /** The open lots. Null when the account has no ledger yet (lots were off, or it was never written). */
  state: LotLedgerState | null;
}

/** Implemented by a repository that can record lots. */
export interface ICreditRepositoryLots {
  /** Whether this instance records lots. See `LotLedgerOptions.lotLedger`. */
  readonly lotLedger: "off" | "on";
  /** The account's open lots, or null for a missing account. */
  getLotLedger(userId: string): Promise<LotLedgerView | null>;
  /** One lot's header, open or closed, or null. */
  getLotHeader(userId: string, lotId: string): Promise<LotHeader | null>;
  /**
   * Refund or charge back one lot, in one atomic step: take back what it still holds (only
   * spendable credits, and never so many that an open hold is uncovered), record the event
   * under `reversalKey`, and journal the removal (`source: "refund"`). Throws
   * `UNSUPPORTED_OPERATION` when the ledger is off.
   */
  reverseLot(input: ReverseLotInput): Promise<ReverseLotOutcome>;
}
