import type { CollectionReference, Firestore, Transaction } from "firebase-admin/firestore";
import {
  CreditError,
  CreditErrorCode,
  assertValidIdempotencyKey,
  finishLotPlan,
  heldExpiredBacking,
  lotBucketsOf,
  planAccountLots,
  planLotReverse,
  startLotPlan,
  sumAmounts,
} from "@nehorai/credits";
import type {
  LotBuckets,
  LotContext,
  LotEvent,
  LotHeader,
  LotLedgerOptions,
  LotLedgerState,
  LotLedgerView,
  LotPlan,
  ReverseLotInput,
  ReverseLotOutcome,
} from "@nehorai/credits";
import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { BALANCE_DOC_ID, getUserCreditsCollection, toISOString } from "./shared.js";
import { deterministicDocId, readStoredCredits, type FirestoreUserCredits } from "./credits-doc.js";
import { planHoldBacking } from "./hold-backing.js";
import { createJournalEntryInTransaction } from "./journal.js";

/**
 * The lot ledger on Firestore.
 *
 * - The open lots live inline on the balance document (`lots`), so every writer reads
 *   them with the balance it already reads and writes them in the same transaction.
 * - Each lot has a header at `users/{uid}/credits/data/lots/{lotId}`, created when it
 *   opens and given its closing totals when it empties.
 * - Each event (expiry, adjustment, refund, chargeback, reconcile) is a document at
 *   `users/{uid}/credits/data/lot_events/{sha256(key)}`, created once.
 *
 * Headers and events carry `userId`, so a collection-group query over `lots` or
 * `lot_events` (for example by `day`) can report across accounts.
 *
 * A plan is pure; its writes are queued after the transaction's last read. Drift is
 * reported once the transaction commits, from the attempt that committed.
 */

const LOTS_COLLECTION = "lots";
const LOT_EVENTS_COLLECTION = "lot_events";
const EMPTY_LEDGER: LotLedgerState = { v: 1, open: [] };

export function getUserLotsCollection(db: Firestore, userId: string): CollectionReference {
  return getUserCreditsCollection(db, userId).doc("data").collection(LOTS_COLLECTION);
}

export function getUserLotEventsCollection(db: Firestore, userId: string): CollectionReference {
  return getUserCreditsCollection(db, userId).doc("data").collection(LOT_EVENTS_COLLECTION);
}

/** The document id of an event key, which may contain `/`. */
export function lotEventDocId(key: string): string {
  return deterministicDocId("lot-event", key);
}

/** Whether these options record lots. */
export function lotsOn(options?: LotLedgerOptions): boolean {
  return options?.lotLedger === "on";
}

/** The lot totals of a stored balance document, as the ledger reads it; zero for none. */
export function storedLotBuckets(raw: FirestoreUserCredits | null): LotBuckets {
  if (!raw) return lotBucketsOf(0, 0, 0);
  const data = readStoredCredits(raw);
  return lotBucketsOf(
    data.balance,
    heldExpiredBacking(data.balance, data.expiredHoldBacking),
    data.bonusCredits ?? 0
  );
}

/** The lot totals a write leaves the account at. */
export function lotBucketsAfter(balance: number, marked: number, bonusCredits: number): LotBuckets {
  return lotBucketsOf(balance, heldExpiredBacking(balance, marked), bonusCredits);
}

/** An operation reference for a write that has none of its own. */
export function newLotOpRef(): string {
  return `op:${randomUUID()}`;
}

function contextOf(raw: FirestoreUserCredits | null, opRef: string): LotContext {
  return {
    now: new Date().toISOString(),
    newLotId: randomUUID,
    opRef,
    ...(raw?.createdAt ? { legacyGrantedAt: toISOString(raw.createdAt) } : {}),
  };
}

/**
 * Plan one write's lots, or null when the ledger is off. `raw` is the balance document as
 * read in the transaction, or null for an account this write creates.
 */
export function planFirestoreLots(
  options: LotLedgerOptions | undefined,
  input: {
    raw: FirestoreUserCredits | null;
    after: LotBuckets;
    opRef: string;
    apply?: (plan: LotPlan) => LotPlan;
  }
): LotPlan | null {
  if (!lotsOn(options)) return null;
  return planAccountLots({
    stored: input.raw ? input.raw.lots : EMPTY_LEDGER,
    before: storedLotBuckets(input.raw),
    after: input.after,
    ctx: contextOf(input.raw, input.opRef),
    apply: input.apply,
  });
}

/**
 * Queue a plan's header and event documents, and return the balance document's `lots`
 * field to write with the balance. Call it after the transaction's last read.
 */
export function writeLotPlan(
  transaction: Transaction,
  db: Firestore,
  userId: string,
  plan: LotPlan | null
): { lots?: LotLedgerState } {
  if (!plan) return {};
  const headers = getUserLotsCollection(db, userId);
  const closings = new Map(plan.closed.map((closing) => [closing.id, closing]));
  for (const header of plan.opened) {
    // A lot that opens and empties in one write is created closed.
    const closing = closings.get(header.id);
    closings.delete(header.id);
    transaction.create(headers.doc(header.id), {
      ...stripUndefined(header),
      userId,
      ...(closing ? closingFields(closing) : {}),
    });
  }
  for (const closing of closings.values()) {
    transaction.set(headers.doc(closing.id), closingFields(closing), { merge: true });
  }
  const events = getUserLotEventsCollection(db, userId);
  for (const event of plan.events) {
    transaction.create(events.doc(lotEventDocId(event.key)), { ...stripUndefined(event), userId });
  }
  return { lots: plan.state };
}

function closingFields(closing: LotPlan["closed"][number]) {
  return {
    closedAt: closing.closedAt,
    drawnValueMicros: closing.drawnValueMicros,
    drawnFeeMicros: closing.drawnFeeMicros,
  };
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

/**
 * Reports a write's drift after its transaction commits. A Firestore transaction may run
 * its function more than once, so each attempt starts over and only the committed
 * attempt's plan is reported.
 */
export class LotDriftReporter {
  private plan: LotPlan | null = null;

  constructor(
    private readonly options: LotLedgerOptions | undefined,
    private readonly userId: string,
    private readonly operation: string
  ) {}

  /** Call first in each transaction attempt. */
  begin(): void {
    this.plan = null;
  }

  track(plan: LotPlan | null): void {
    this.plan = plan;
  }

  /** Call after the transaction resolved. A throwing hook never fails the write. */
  flush(): void {
    const plan = this.plan;
    this.plan = null;
    if (!plan || (plan.drift.length === 0 && plan.anomalies.length === 0)) return;
    try {
      this.options?.onLotDrift?.({
        userId: this.userId,
        operation: this.operation,
        drift: plan.drift,
        anomalies: plan.anomalies,
      });
    } catch {
      // A metric hook never fails the write it reports on.
    }
  }
}

// ==================== Reading ====================

export async function getLotLedger(db: Firestore, userId: string): Promise<LotLedgerView | null> {
  const doc = await getUserCreditsCollection(db, userId).doc(BALANCE_DOC_ID).get();
  if (!doc.exists) return null;
  const lots = (doc.data() as FirestoreUserCredits).lots;
  return { state: lots ?? null };
}

export async function getLotHeader(
  db: Firestore,
  userId: string,
  lotId: string
): Promise<LotHeader | null> {
  const doc = await getUserLotsCollection(db, userId).doc(lotId).get();
  if (!doc.exists) return null;
  const { userId: _owner, ...header } = doc.data() as LotHeader & { userId: string };
  return header;
}

function toLotEvent(data: Record<string, unknown>): LotEvent {
  const { userId: _owner, ...event } = data;
  return event as unknown as LotEvent;
}

// ==================== Reversal ====================

/**
 * Refund or charge back one lot. See `ICreditRepositoryLots.reverseLot`.
 *
 * The event document under the reversal key is the guard: read with the balance and the
 * lot's header, and created in the same transaction as the removal and its journal line.
 */
export async function reverseLot(
  db: Firestore,
  input: ReverseLotInput,
  options?: LotLedgerOptions
): Promise<ReverseLotOutcome> {
  const { userId, lotId } = input;
  if (!lotsOn(options)) {
    throw new CreditError(
      'reverseLot needs the lot ledger: create the repository with lotLedger: "on"',
      CreditErrorCode.UNSUPPORTED_OPERATION,
      { userId, lotId }
    );
  }
  assertValidIdempotencyKey(input.reversalKey, { userId });
  const key = `reversal:${input.reversalKey}`;
  const balanceRef = getUserCreditsCollection(db, userId).doc(BALANCE_DOC_ID);
  const eventRef = getUserLotEventsCollection(db, userId).doc(lotEventDocId(key));
  const headerRef = getUserLotsCollection(db, userId).doc(lotId);
  const report = new LotDriftReporter(options, userId, "reverseLot");

  const outcome = await db.runTransaction(async (transaction): Promise<ReverseLotOutcome> => {
    report.begin();
    const [eventDoc, balanceDoc, headerDoc] = await transaction.getAll(
      eventRef,
      balanceRef,
      headerRef
    );

    if (eventDoc.exists) {
      const recorded = toLotEvent(eventDoc.data() ?? {});
      if (recorded.lotId !== lotId) return { outcome: "conflict", event: recorded, mismatch: "lotId" };
      if (recorded.kind !== input.kind) return { outcome: "conflict", event: recorded, mismatch: "kind" };
      return { outcome: "replayed", event: recorded };
    }
    if (!balanceDoc.exists) return { outcome: "not_found", lotId };

    const raw = balanceDoc.data() as FirestoreUserCredits;
    const current = readStoredCredits(raw);
    const bonusCredits = current.bonusCredits ?? 0;
    const held = heldExpiredBacking(current.balance, current.expiredHoldBacking);
    const header = headerDoc.exists ? (headerDoc.data() as LotHeader) : undefined;

    // Started, reversed, then finished: the totals it leaves are known only once planned.
    const started = startLotPlan(raw.lots, storedLotBuckets(raw), contextOf(raw, key));
    const reversal = planLotReverse(started, {
      lotId,
      kind: input.kind,
      key,
      refundMicros: input.refundMicros,
      chargebackFeeMicros: input.chargebackFeeMicros,
      credits: input.credits,
      available: sumAmounts(current.balance, bonusCredits, -(current.reserved ?? 0)),
      closedLot: header?.closedAt ? header : undefined,
    });
    if (!reversal) return { outcome: "not_found", lotId };

    const nextBalance = sumAmounts(current.balance, -reversal.removed.balance);
    const nextBonusCredits = sumAmounts(bonusCredits, -reversal.removed.bonus);
    const plan = finishLotPlan(
      reversal.plan,
      lotBucketsAfter(nextBalance, held, nextBonusCredits)
    );
    const creditsRemoved = sumAmounts(reversal.removed.balance, reversal.removed.bonus);
    // Only spendable credits leave, so the marks stand; this repairs a bad stored value.
    const backing = await planHoldBacking(transaction, db, userId, held, raw);

    transaction.update(balanceRef, {
      balance: nextBalance,
      bonusCredits: nextBonusCredits,
      ...backing,
      ...writeLotPlan(transaction, db, userId, plan),
      updatedAt: FieldValue.serverTimestamp(),
    });
    const journalEntryId = createJournalEntryInTransaction(transaction, db, {
      userId,
      entryType: "debit",
      amount: creditsRemoved,
      balanceBefore: sumAmounts(current.balance, bonusCredits),
      balanceAfter: sumAmounts(nextBalance, nextBonusCredits),
      source: "refund",
      referenceId: input.reversalKey,
      referenceType: "adjustment",
      description: input.description ?? `Lot ${input.kind}: ${lotId}`,
      metadata: { ...input.metadata, lotId, kind: input.kind, reversal: reversal.event.reversal },
    });
    report.track(plan);
    return { outcome: "reversed", event: reversal.event, creditsRemoved, journalEntryId };
  });
  report.flush();
  return outcome;
}
