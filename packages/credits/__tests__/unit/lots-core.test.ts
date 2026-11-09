/**
 * The lot planners, without a repository: validation, draw order, value shares,
 * reconciliation, the open-lot limit and reversals.
 */
import { describe, expect, it } from "vitest";
import {
  CreditError,
  CreditErrorCode,
  MAX_OPEN_LOTS,
  assertValidLotSpec,
  finishLotPlan,
  lotBucketsOf,
  lotSums,
  lotTotalsOf,
  planAccountLots,
  planLotCap,
  planLotDraws,
  planLotGrant,
  planLotRemoval,
  planLotReplace,
  planLotReverse,
  startLotPlan,
  summarizeLots,
  type LotContext,
  type LotLedgerState,
  type LotPlan,
  type LotSpec,
} from "../../src";

let clock = 0;
function ctx(opRef = "op:test"): LotContext {
  let next = 0;
  clock += 1;
  return {
    now: new Date(Date.UTC(2026, 10, 9, 0, 0, clock)).toISOString(),
    newLotId: () => `lot-${clock}-${next++}`,
    opRef,
  };
}

const EMPTY: LotLedgerState = { v: 1, open: [] };
const PAID = (valueMicros: number, feeMicros: number | null = null): LotSpec => ({
  funding: "paid",
  valueMicros,
  feeMicros,
});
const FREE: LotSpec = { funding: "free" };
const UNKNOWN: LotSpec = { funding: "unknown" };

/** A ledger built from grants, each one write. */
function ledgerOf(
  grants: Array<{ bucket: "balance" | "bonus"; credits: number; spec: LotSpec }>
): LotLedgerState {
  let state = EMPTY;
  let buckets = lotBucketsOf(0, 0, 0);
  for (const grant of grants) {
    const after =
      grant.bucket === "balance"
        ? { ...buckets, spendable: buckets.spendable + grant.credits }
        : { ...buckets, bonus: buckets.bonus + grant.credits };
    const plan = planAccountLots({
      stored: state,
      before: buckets,
      after,
      ctx: ctx(),
      apply: (p) => planLotGrant(p, { ...grant, sourceType: "admin" }),
    });
    expect(plan.drift).toEqual([]);
    state = plan.state;
    buckets = after;
  }
  return state;
}

function bucketsOfState(state: LotLedgerState) {
  return lotSums(state);
}

function expectThrowsCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CreditError);
    expect((error as CreditError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("assertValidLotSpec", () => {
  it("accepts paid with a whole value, free and unknown without one", () => {
    expect(() => assertValidLotSpec(PAID(1_000_000))).not.toThrow();
    expect(() => assertValidLotSpec(PAID(1_000_000, 30_000))).not.toThrow();
    expect(() => assertValidLotSpec(FREE)).not.toThrow();
    expect(() => assertValidLotSpec(UNKNOWN)).not.toThrow();
  });

  it.each([
    ["paid without a value", { funding: "paid" }],
    ["a fractional value", { funding: "paid", valueMicros: 1.5 }],
    ["a negative value", { funding: "paid", valueMicros: -1 }],
    ["a fractional fee", { funding: "paid", valueMicros: 10, feeMicros: 0.5 }],
    ["a value on a free lot", { funding: "free", valueMicros: 10 }],
    ["a fee on an unknown lot", { funding: "unknown", feeMicros: 10 }],
    ["an unknown funding", { funding: "gift" }],
    ["not an object", null],
  ])("refuses %s", (_name, spec) => {
    expectThrowsCode(() => assertValidLotSpec(spec), CreditErrorCode.INVALID_AMOUNT);
  });
});

describe("draw order", () => {
  it("draws paid credits first, then free and unknown oldest first", () => {
    const state = ledgerOf([
      { bucket: "bonus", credits: 2, spec: FREE },
      { bucket: "bonus", credits: 3, spec: UNKNOWN },
      { bucket: "bonus", credits: 4, spec: PAID(4_000_000) },
    ]);
    const plan = planLotDraws(startLotPlan(state, bucketsOfState(state), ctx()), {
      backing: 0,
      spendable: 0,
      bonus: 7,
    });
    expect(plan.draws.map((draw) => [draw.funding, draw.credits])).toEqual([
      ["paid", 4],
      ["free", 2],
      ["unknown", 1],
    ]);
    expect(plan.drift).toEqual([]);
  });

  it("drains the balance bucket before the bonus bucket", () => {
    const state = ledgerOf([
      { bucket: "bonus", credits: 5, spec: PAID(5_000_000) },
      { bucket: "balance", credits: 2, spec: FREE },
    ]);
    const plan = planLotDraws(startLotPlan(state, bucketsOfState(state), ctx()), {
      backing: 0,
      spendable: 2,
      bonus: 1,
    });
    expect(plan.draws.map((draw) => [draw.bucket, draw.funding, draw.credits])).toEqual([
      ["balance", "free", 2],
      ["bonus", "paid", 1],
    ]);
  });
});

describe("value shares", () => {
  it("splits a lot's value by credits and gives the remainder to the draw that empties it", () => {
    let state = ledgerOf([{ bucket: "bonus", credits: 3, spec: PAID(1_000_000, 100) }]);
    const shares: Array<number | null> = [];
    const fees: Array<number | null> = [];
    let closed: LotPlan["closed"] = [];
    for (let i = 0; i < 3; i++) {
      const before = bucketsOfState(state);
      const plan = planAccountLots({
        stored: state,
        before,
        after: { ...before, bonus: before.bonus - 1 },
        ctx: ctx(),
        apply: (p) => planLotDraws(p, { backing: 0, spendable: 0, bonus: 1 }),
      });
      shares.push(plan.draws[0]!.valueMicros);
      fees.push(plan.draws[0]!.feeMicros);
      closed = closed.concat(plan.closed);
      state = plan.state;
    }
    expect(shares).toEqual([333_333, 333_333, 333_334]);
    expect(fees).toEqual([33, 33, 34]);
    expect(state.open).toEqual([]);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ drawnValueMicros: 1_000_000, drawnFeeMicros: 100 });
  });

  it("an unknown fee stays unknown on every draw and in the totals", () => {
    const state = ledgerOf([{ bucket: "bonus", credits: 2, spec: PAID(2_000_000) }]);
    const plan = planLotDraws(startLotPlan(state, bucketsOfState(state), ctx()), {
      backing: 0,
      spendable: 0,
      bonus: 1.5,
    });
    expect(lotTotalsOf(plan.draws)).toEqual({
      revenueMicros: 1_500_000,
      feeMicros: 0,
      paidCredits: 1.5,
      freeCredits: 0,
      unknownCredits: 0,
      unknownFeeCredits: 1.5,
    });
  });

  it("unknown lots carry no revenue", () => {
    const state = ledgerOf([{ bucket: "bonus", credits: 2, spec: UNKNOWN }]);
    const plan = planLotDraws(startLotPlan(state, bucketsOfState(state), ctx()), {
      backing: 0,
      spendable: 0,
      bonus: 2,
    });
    expect(lotTotalsOf(plan.draws)).toMatchObject({ revenueMicros: 0, unknownCredits: 2 });
  });
});

describe("startLotPlan", () => {
  it("opens one unknown legacy lot per bucket on an account without a ledger", () => {
    const plan = startLotPlan(null, lotBucketsOf(10, 4, 3), ctx());
    expect(plan.initialized).toBe(true);
    expect(plan.drift).toEqual([]);
    expect(plan.state.open.map((lot) => [lot.bucket, lot.funding, lot.spendable, lot.backing]))
      .toEqual(expect.arrayContaining([
        ["balance", "unknown", 6, 4],
        ["bonus", "unknown", 3, 0],
      ]));
    expect(plan.opened.every((header) => header.sourceType === "legacy")).toBe(true);
  });

  it("an empty account without a ledger opens no lot", () => {
    const plan = startLotPlan(undefined, lotBucketsOf(0, 0, 0), ctx());
    expect(plan.state.open).toEqual([]);
    expect(plan.initialized).toBe(true);
  });
});

describe("reconcile", () => {
  it("opens an unknown lot for credits another writer added, and reports it", () => {
    const state = ledgerOf([{ bucket: "bonus", credits: 2, spec: FREE }]);
    const plan = startLotPlan(state, { spendable: 0, backing: 0, bonus: 5 }, ctx());
    expect(plan.drift).toEqual([{ bucket: "bonus", portion: "spendable", credits: 3, phase: "before" }]);
    expect(plan.events).toEqual([
      expect.objectContaining({ kind: "reconcile", reason: "unknown_lot", credits: 3 }),
    ]);
    expect(lotSums(plan.state)).toEqual({ spendable: 0, backing: 0, bonus: 5 });
  });

  it("removes credits another writer took, in draw order", () => {
    const state = ledgerOf([
      { bucket: "bonus", credits: 2, spec: FREE },
      { bucket: "bonus", credits: 2, spec: PAID(2_000_000) },
    ]);
    const plan = startLotPlan(state, { spendable: 0, backing: 0, bonus: 1 }, ctx());
    expect(plan.drift).toEqual([{ bucket: "bonus", portion: "spendable", credits: -3, phase: "before" }]);
    expect(plan.events.map((event) => [event.funding, event.credits, event.reason])).toEqual([
      ["paid", 2, "unattributed_removal"],
      ["free", 1, "unattributed_removal"],
    ]);
  });

  it("finish reports a plan that disagrees with the account it leaves", () => {
    const state = ledgerOf([{ bucket: "balance", credits: 5, spec: FREE }]);
    const started = startLotPlan(state, lotBucketsOf(5, 0, 0), ctx());
    const finished = finishLotPlan(started, lotBucketsOf(4, 0, 0));
    expect(finished.drift).toEqual([
      { bucket: "balance", portion: "spendable", credits: -1, phase: "after" },
    ]);
  });
});

describe("planLotReplace", () => {
  it("keeps the held backing, expires the rest of the old balance, opens the grant", () => {
    const state = ledgerOf([
      { bucket: "balance", credits: 4, spec: FREE },
      { bucket: "balance", credits: 6, spec: PAID(6_000_000) },
    ]);
    const plan = planAccountLots({
      stored: state,
      before: lotBucketsOf(10, 0, 0),
      // A hold of 3 stays backed by old credits; the new allotment is 20.
      after: lotBucketsOf(23, 3, 0),
      ctx: ctx(),
      apply: (p) =>
        planLotReplace(p, {
          spendable: 20,
          backing: 3,
          grant: { spec: PAID(20_000_000), sourceType: "subscription_cycle", sourceRef: "cycle-2" },
          reason: "cycle_replaced",
          ref: "cycle-2",
        }),
    });
    expect(plan.drift).toEqual([]);
    // Paid credits are marked as backing first, so paid value is what the hold will draw.
    const grantId = plan.opened[0]!.id;
    const old = plan.state.open.filter((lot) => lot.id !== grantId);
    expect(old.map((lot) => [lot.funding, lot.spendable, lot.backing])).toEqual([["paid", 0, 3]]);
    const expired = plan.events.filter((event) => event.kind === "expire");
    expect(expired.map((event) => [event.funding, event.credits, event.valueMicros])).toEqual([
      ["paid", 3, 3_000_000],
      ["free", 4, 0],
    ]);
    expect(plan.opened).toEqual([
      expect.objectContaining({ sourceType: "subscription_cycle", sourceRef: "cycle-2", granted: 20 }),
    ]);
    expect(lotSums(plan.state)).toEqual({ spendable: 20, backing: 3, bonus: 0 });
  });
});

describe("planLotCap", () => {
  it("expires a spendable excess in draw order", () => {
    const state = ledgerOf([
      { bucket: "balance", credits: 4, spec: FREE },
      { bucket: "balance", credits: 6, spec: PAID(6_000_000) },
    ]);
    const plan = planAccountLots({
      stored: state,
      before: lotBucketsOf(10, 0, 0),
      after: lotBucketsOf(3, 0, 0),
      ctx: ctx(),
      apply: (p) => planLotCap(p, { spendable: 3, backing: 0, reason: "tier_cap", ref: "free" }),
    });
    expect(plan.drift).toEqual([]);
    expect(plan.events.map((event) => [event.funding, event.credits])).toEqual([
      ["paid", 6],
      ["free", 1],
    ]);
    expect(plan.state.open.map((lot) => [lot.funding, lot.spendable])).toEqual([["free", 3]]);
  });

  it("tops a shortfall up with the given lot and flags its anomaly", () => {
    const state = ledgerOf([{ bucket: "balance", credits: 4, spec: FREE }]);
    const plan = planAccountLots({
      stored: state,
      before: lotBucketsOf(4, 0, 0),
      after: lotBucketsOf(25, 0, 0),
      ctx: ctx(),
      apply: (p) =>
        planLotCap(p, {
          spendable: 25,
          backing: 0,
          reason: "monthly_reset",
          ref: "r",
          topUp: { spec: FREE, sourceType: "monthly_reset", anomaly: "paid_tier_reset" },
        }),
    });
    expect(plan.opened).toEqual([
      expect.objectContaining({ granted: 21, sourceType: "monthly_reset", anomaly: "paid_tier_reset" }),
    ]);
    expect(plan.anomalies).toEqual(["paid_tier_reset"]);
  });

  it("marks and unmarks backing without an event", () => {
    const state = ledgerOf([{ bucket: "balance", credits: 4, spec: FREE }]);
    const marked = planAccountLots({
      stored: state,
      before: lotBucketsOf(4, 0, 0),
      after: lotBucketsOf(4, 3, 0),
      ctx: ctx(),
      apply: (p) => planLotCap(p, { spendable: 1, backing: 3, reason: "tier_cap", ref: "x" }),
    });
    expect(marked.events).toEqual([]);
    expect(marked.drift).toEqual([]);
    expect(lotSums(marked.state)).toEqual({ spendable: 1, backing: 3, bonus: 0 });
  });
});

describe("planLotRemoval", () => {
  it("records an adjustment per lot touched, value included", () => {
    const state = ledgerOf([
      { bucket: "bonus", credits: 2, spec: PAID(2_000_000) },
      { bucket: "bonus", credits: 2, spec: FREE },
    ]);
    const plan = planLotRemoval(startLotPlan(state, bucketsOfState(state), ctx()), {
      bucket: "bonus",
      portion: "spendable",
      credits: 3,
      kind: "adjustment",
      reason: "deduct",
      ref: "d1",
    });
    expect(plan.events.map((event) => [event.kind, event.funding, event.credits, event.valueMicros]))
      .toEqual([
        ["adjustment", "paid", 2, 2_000_000],
        ["adjustment", "free", 1, 0],
      ]);
    expect(new Set(plan.events.map((event) => event.key)).size).toBe(2);
  });
});

describe("the open-lot limit", () => {
  it(`refuses a write that leaves more than ${MAX_OPEN_LOTS} open lots`, () => {
    const state: LotLedgerState = ledgerOf(
      Array.from({ length: MAX_OPEN_LOTS }, () => ({ bucket: "bonus" as const, credits: 1, spec: FREE }))
    );
    expect(state.open).toHaveLength(MAX_OPEN_LOTS);
    expectThrowsCode(
      () =>
        planAccountLots({
          stored: state,
          before: bucketsOfState(state),
          after: { ...bucketsOfState(state), bonus: MAX_OPEN_LOTS + 1 },
          ctx: ctx(),
          apply: (p) => planLotGrant(p, { bucket: "bonus", credits: 1, spec: FREE, sourceType: "admin" }),
        }),
      CreditErrorCode.LOT_LIMIT_EXCEEDED
    );
  });
});

describe("planLotReverse", () => {
  function partlySpent() {
    // 10 credits for $10, 4 of them spent.
    const state = ledgerOf([{ bucket: "bonus", credits: 10, spec: PAID(10_000_000, 500_000) }]);
    const plan = planAccountLots({
      stored: state,
      before: bucketsOfState(state),
      after: { spendable: 0, backing: 0, bonus: 6 },
      ctx: ctx(),
      apply: (p) => planLotDraws(p, { backing: 0, spendable: 0, bonus: 4 }),
    });
    return plan.state;
  }

  it("a full refund cancels the undrawn value and books the rest as contra-revenue", () => {
    const state = partlySpent();
    const lotId = state.open[0]!.id;
    const result = planLotReverse(startLotPlan(state, bucketsOfState(state), ctx()), {
      lotId,
      kind: "refund",
      key: "reversal:r1",
      refundMicros: 10_000_000,
      available: 6,
    })!;
    expect(result.removed).toEqual({ balance: 0, bonus: 6 });
    expect(result.event).toMatchObject({
      key: "reversal:r1",
      kind: "refund",
      credits: 6,
      valueMicros: 6_000_000,
      feeMicros: 300_000,
      reversal: {
        refundMicros: 10_000_000,
        contraRevenueMicros: 4_000_000,
        retainedRevenueMicros: 0,
        chargebackFeeMicros: 0,
        uncollectedCredits: 4,
        keptCredits: 0,
      },
    });
    const finished = finishLotPlan(result.plan, { spendable: 0, backing: 0, bonus: 0 });
    expect(finished.drift).toEqual([]);
    expect(finished.closed).toEqual([
      expect.objectContaining({ id: lotId, drawnValueMicros: 10_000_000, drawnFeeMicros: 500_000 }),
    ]);
  });

  it("a partial refund keeps the undrawn value beyond it", () => {
    const state = partlySpent();
    const result = planLotReverse(startLotPlan(state, bucketsOfState(state), ctx()), {
      lotId: state.open[0]!.id,
      kind: "refund",
      key: "reversal:r2",
      refundMicros: 2_000_000,
      available: 6,
    })!;
    expect(result.event.reversal).toMatchObject({ contraRevenueMicros: 0, retainedRevenueMicros: 4_000_000 });
  });

  it("never takes more than the account can give up, and records what it kept", () => {
    const state = partlySpent();
    const result = planLotReverse(startLotPlan(state, bucketsOfState(state), ctx()), {
      lotId: state.open[0]!.id,
      kind: "chargeback",
      key: "reversal:c1",
      refundMicros: 10_000_000,
      chargebackFeeMicros: 15_000_000,
      available: 2.5,
    })!;
    expect(result.removed.bonus).toBe(2.5);
    expect(result.event.reversal).toMatchObject({
      chargebackFeeMicros: 15_000_000,
      keptCredits: 3.5,
      uncollectedCredits: 4,
    });
  });

  it("a closed lot reverses for 0 credits, and an unknown one is null", () => {
    const state = partlySpent();
    const header = {
      id: "closed-lot",
      bucket: "bonus" as const,
      funding: "paid" as const,
      granted: 5,
      valueMicros: 5_000_000,
      feeMicros: null,
      grantedAt: "2026-01-01T00:00:00.000Z",
      sourceType: "purchase" as const,
      sourceRef: "pay-1",
      valuationBasis: "snapshot" as const,
      closedAt: "2026-02-01T00:00:00.000Z",
    };
    const started = startLotPlan(state, bucketsOfState(state), ctx());
    const result = planLotReverse(started, {
      lotId: header.id,
      kind: "refund",
      key: "reversal:old",
      refundMicros: 5_000_000,
      available: 6,
      closedLot: header,
    })!;
    expect(result.removed).toEqual({ balance: 0, bonus: 0 });
    expect(result.event).toMatchObject({
      credits: 0,
      valueMicros: 0,
      reversal: { contraRevenueMicros: 5_000_000, uncollectedCredits: 5 },
    });
    expect(
      planLotReverse(started, { lotId: "nope", kind: "refund", key: "k", refundMicros: 0, available: 6 })
    ).toBeNull();
  });

  it("refuses money that is not whole micros", () => {
    const state = partlySpent();
    expectThrowsCode(
      () =>
        planLotReverse(startLotPlan(state, bucketsOfState(state), ctx()), {
          lotId: state.open[0]!.id,
          kind: "refund",
          key: "k",
          refundMicros: 1.5,
          available: 6,
        }),
      CreditErrorCode.INVALID_AMOUNT
    );
  });
});

describe("summarizeLots", () => {
  it("reports deferred revenue and credits by funding", () => {
    const state = ledgerOf([
      { bucket: "bonus", credits: 4, spec: PAID(8_000_000) },
      { bucket: "balance", credits: 3, spec: FREE },
      { bucket: "bonus", credits: 2, spec: UNKNOWN },
    ]);
    expect(summarizeLots(state)).toEqual({
      openLots: 3,
      paidCredits: 4,
      freeCredits: 3,
      unknownCredits: 2,
      deferredValueMicros: 8_000_000,
      unknownValueCredits: 2,
    });
  });
});

describe("conservation under random draws", () => {
  it("a lot's value always leaves exactly once", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 50; round++) {
      const value = Math.floor(random() * 50_000_000);
      const granted = Math.round((1 + random() * 40) * 100) / 100;
      let state = ledgerOf([{ bucket: "bonus", credits: granted, spec: PAID(value, 1_234) }]);
      let drawnValue = 0;
      let drawnFee = 0;
      while (state.open.length > 0) {
        const left = state.open[0]!.spendable;
        const take = Math.min(left, Math.max(0.01, Math.round(random() * 500) / 100));
        const before = bucketsOfState(state);
        const plan = planAccountLots({
          stored: state,
          before,
          after: { ...before, bonus: Math.round((before.bonus - take) * 100) / 100 },
          ctx: ctx(),
          apply: (p) => planLotDraws(p, { backing: 0, spendable: 0, bonus: take }),
        });
        expect(plan.drift).toEqual([]);
        for (const draw of plan.draws) {
          drawnValue += draw.valueMicros ?? 0;
          drawnFee += draw.feeMicros ?? 0;
        }
        state = plan.state;
      }
      expect(drawnValue).toBe(value);
      expect(drawnFee).toBe(1_234);
    }
  });
});
