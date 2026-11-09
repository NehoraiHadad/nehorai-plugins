/**
 * The lot ledger for the in-memory repository.
 *
 * Every writer plans its lots from values it projected *before* mutating anything, since
 * this store has no rollback: a plan that refuses (the open-lot limit) must refuse while
 * the account is untouched. The plan is applied right after the account write, in the
 * same synchronous step.
 */

import { heldExpiredBacking } from "../../core/amount.js";
import {
  lotBucketsOf,
  planAccountLots,
  startLotPlan,
  type LotBuckets,
  type LotContext,
  type LotLedgerState,
  type LotPlan,
} from "../../core/lots.js";
import type { PortableUserCredits } from "../../core/types.js";
import { generateId } from "../utils.js";
import type { MemoryStore } from "./store.js";

/** Whether the store records lots. */
export function lotsOn(store: MemoryStore): boolean {
  return store.lotOptions.lotLedger === "on";
}

/** The lot totals of a stored account. */
export function bucketsOf(credits: PortableUserCredits): LotBuckets {
  return lotBucketsOf(
    credits.balance,
    heldExpiredBacking(credits.balance, credits.expiredHoldBacking),
    credits.bonusCredits
  );
}

/** The lot totals of an account a write will leave at these values. */
export function bucketsAfter(balance: number, marked: number, bonusCredits: number): LotBuckets {
  return lotBucketsOf(balance, heldExpiredBacking(balance, marked), bonusCredits);
}

/** An empty ledger, for an account this write creates. */
export const EMPTY_LEDGER: LotLedgerState = { v: 1, open: [] };

/** The context of one write's lot plan. */
function contextOf(opRef: string, createdAt: string | undefined): LotContext {
  return {
    now: new Date().toISOString(),
    newLotId: generateId,
    opRef,
    legacyGrantedAt: createdAt,
  };
}

/**
 * Plan one write's lots, or null when the ledger is off. `stored` overrides the account's
 * stored ledger, for an account the write creates.
 */
export function planMemoryLots(
  store: MemoryStore,
  input: {
    userId: string;
    before: LotBuckets;
    after: LotBuckets;
    opRef: string;
    stored?: LotLedgerState;
    createdAt?: string;
    apply?: (plan: LotPlan) => LotPlan;
  }
): LotPlan | null {
  if (!lotsOn(store)) return null;
  return planAccountLots({
    stored: input.stored ?? store.lotStates.get(input.userId),
    before: input.before,
    after: input.after,
    ctx: contextOf(input.opRef, input.createdAt),
    apply: input.apply,
  });
}

/**
 * Start a plan whose totals after the write are only known once it is planned (a lot
 * reversal); the caller finishes it with `finishLotPlan`. Null when the ledger is off.
 */
export function startMemoryLots(
  store: MemoryStore,
  input: { userId: string; before: LotBuckets; opRef: string; createdAt?: string }
): LotPlan | null {
  if (!lotsOn(store)) return null;
  return startLotPlan(
    store.lotStates.get(input.userId),
    input.before,
    contextOf(input.opRef, input.createdAt)
  );
}

/** Store a plan: the ledger, new headers, closing totals and events. */
export function applyMemoryLots(
  store: MemoryStore,
  userId: string,
  operation: string,
  plan: LotPlan | null
): void {
  if (!plan) return;
  store.lotStates.set(userId, plan.state);
  let headers = store.lotHeaders.get(userId);
  if (!headers) {
    headers = new Map();
    store.lotHeaders.set(userId, headers);
  }
  for (const header of plan.opened) headers.set(header.id, { ...header });
  for (const closing of plan.closed) {
    const header = headers.get(closing.id);
    if (header) {
      Object.assign(header, {
        closedAt: closing.closedAt,
        drawnValueMicros: closing.drawnValueMicros,
        drawnFeeMicros: closing.drawnFeeMicros,
      });
    }
  }
  let events = store.lotEvents.get(userId);
  if (!events) {
    events = new Map();
    store.lotEvents.set(userId, events);
  }
  for (const event of plan.events) events.set(event.key, { ...event });

  if (plan.drift.length > 0 || plan.anomalies.length > 0) {
    try {
      store.lotOptions.onLotDrift?.({
        userId,
        operation,
        drift: plan.drift,
        anomalies: plan.anomalies,
      });
    } catch {
      // A metric hook never fails the write it reports on.
    }
  }
}
