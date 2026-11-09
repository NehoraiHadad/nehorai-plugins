/**
 * The lot ledger on the in-memory adapter: every writer keeps the lots equal to the
 * account, commits record what paid for them, and reversals take back what a lot holds.
 *
 * The Firestore adapter runs the same scenarios against the emulator
 * (`credits-firestore/__tests__/lots.emulator.test.ts`).
 */
import { describe, expect, it, vi } from "vitest";
import {
  CreditError,
  CreditErrorCode,
  createInMemoryCreditRepository,
  heldExpiredBacking,
  lotBucketsOf,
  lotSums,
  supportsLots,
  type InMemoryCreditRepository,
  type LotDriftReport,
  type LotSpec,
  type PortableReservation,
} from "../../src";
import type { MemoryStore } from "../../src/repository/memory/store.js";

const USER = "u-lots";
const OP = "story_generation";
const soon = () => new Date(Date.now() + 60_000);
const PAID = (valueMicros: number, feeMicros: number | null = null): LotSpec => ({
  funding: "paid",
  valueMicros,
  feeMicros,
});

function storeOf(repo: InMemoryCreditRepository): MemoryStore {
  return (repo as unknown as { store: MemoryStore }).store;
}

function lotRepo(drift: LotDriftReport[] = []) {
  return createInMemoryCreditRepository({
    lotLedger: "on",
    onLotDrift: (report) => drift.push(report),
  });
}

async function hold(repo: InMemoryCreditRepository, amount: number, userId = USER) {
  const reserved = await repo.reserveCreditsV2({
    userId,
    amount,
    operationType: OP,
    expiresAt: soon(),
  });
  if (reserved.outcome !== "created") throw new Error(`expected a hold, got ${reserved.outcome}`);
  return reserved.reservation.id;
}

async function commit(repo: InMemoryCreditRepository, reservationId: string, userId = USER) {
  const outcome = await repo.commitReservationV2(userId, reservationId);
  if (outcome.outcome !== "committed") throw new Error(`expected a commit, got ${outcome.outcome}`);
  return (await repo.getReservation(userId, reservationId)) as PortableReservation;
}

/** The ledger equals the account, bucket by bucket. */
async function expectLotsMatch(repo: InMemoryCreditRepository, userId = USER) {
  const credits = (await repo.getUserCredits(userId))!;
  const ledger = await repo.getLotLedger(userId);
  expect(ledger?.state).not.toBeNull();
  expect(lotSums(ledger!.state!)).toEqual(
    lotBucketsOf(
      credits.balance,
      heldExpiredBacking(credits.balance, credits.expiredHoldBacking),
      credits.bonusCredits
    )
  );
}

/**
 * Every lot's value left exactly once: what draws, events and the open remainder carry
 * adds up to the value it was granted with.
 */
function expectValueConserved(repo: InMemoryCreditRepository, userId = USER) {
  const store = storeOf(repo);
  const headers = [...(store.lotHeaders.get(userId)?.values() ?? [])];
  const left = new Map<string, number>();
  for (const draw of [...(store.reservations.get(userId)?.values() ?? [])].flatMap(
    (reservation) => reservation.lotDraws ?? []
  )) {
    left.set(draw.lotId, (left.get(draw.lotId) ?? 0) + (draw.valueMicros ?? 0));
  }
  for (const event of store.lotEvents.get(userId)?.values() ?? []) {
    if (event.kind === "reconcile" && event.reason === "unknown_lot") continue;
    left.set(event.lotId, (left.get(event.lotId) ?? 0) + (event.valueMicros ?? 0));
  }
  const open = new Map(store.lotStates.get(userId)?.open.map((lot) => [lot.id, lot]) ?? []);
  for (const header of headers) {
    if (header.valueMicros === null) continue;
    const lot = open.get(header.id);
    const drawn = left.get(header.id) ?? 0;
    if (lot) {
      expect(drawn).toBe(lot.drawnValueMicros);
    } else {
      expect(header.closedAt).toBeDefined();
      expect(drawn).toBe(header.valueMicros);
      expect(header.drawnValueMicros).toBe(header.valueMicros);
    }
  }
}

describe("lotLedger off (the default)", () => {
  it("records nothing and refuses reversals", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "free", 10, { signupBonus: 5 });
    await repo.addCreditsV2({ userId: USER, amount: 4, description: "x", options: { lot: PAID(1) } });

    expect(repo.lotLedger).toBe("off");
    expect(supportsLots(repo)).toBe(false);
    expect(await repo.getLotLedger(USER)).toEqual({ state: null });
    await expect(
      repo.reverseLot({ userId: USER, lotId: "x", kind: "refund", reversalKey: "r", refundMicros: 0 })
    ).rejects.toMatchObject({ code: CreditErrorCode.UNSUPPORTED_OPERATION });
  });

  it("still refuses an invalid lot spec", async () => {
    const repo = createInMemoryCreditRepository();
    await expect(
      repo.addCreditsV2({
        userId: USER,
        amount: 4,
        description: "x",
        options: { lot: { funding: "paid" } as LotSpec },
      })
    ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });
  });
});

describe("lotLedger on", () => {
  it("is reported by supportsLots", () => {
    const repo = lotRepo();
    expect(repo.lotLedger).toBe("on");
    expect(supportsLots(repo)).toBe(true);
  });

  it("opens free lots for the signup allotment and the signup gift", async () => {
    const repo = lotRepo();
    await repo.initializeUserCredits(USER, "free", 25, { signupBonus: 10 });

    const { state } = (await repo.getLotLedger(USER))!;
    expect(state!.open.map((lot) => [lot.bucket, lot.funding, lot.spendable])).toEqual(
      expect.arrayContaining([
        ["balance", "free", 25],
        ["bonus", "free", 10],
      ])
    );
    for (const lot of state!.open) {
      expect(await repo.getLotHeader(USER, lot.id)).toMatchObject({
        sourceType: "signup",
        valuationBasis: "free",
        valueMicros: 0,
      });
    }
    await expectLotsMatch(repo);
  });

  it("a purchase opens a paid bonus lot carrying its payment reference", async () => {
    const repo = lotRepo();
    await repo.initializeUserCredits(USER, "free", 0);
    await repo.addCreditsV2({
      userId: USER,
      amount: 50,
      description: "pack",
      paymentRef: "pay-1",
      options: { lot: PAID(9_990_000, 400_000) },
    });
    await repo.addCreditsV2({ userId: USER, amount: 5, description: "gift" });

    const { state } = (await repo.getLotLedger(USER))!;
    const headers = await Promise.all(state!.open.map((lot) => repo.getLotHeader(USER, lot.id)));
    expect(headers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ funding: "paid", sourceType: "purchase", sourceRef: "pay-1", valueMicros: 9_990_000 }),
        expect.objectContaining({ funding: "unknown", sourceType: "admin", sourceRef: null, valueMicros: null }),
      ])
    );
    await expectLotsMatch(repo);
  });

  it("a replayed purchase opens no second lot", async () => {
    const repo = lotRepo();
    await repo.initializeUserCredits(USER, "free", 0);
    const input = {
      userId: USER,
      amount: 50,
      description: "pack",
      paymentRef: "pay-1",
      options: { lot: PAID(9_990_000) },
    };
    await repo.addCreditsV2(input);
    expect((await repo.addCreditsV2(input)).outcome).toBe("replayed");
    expect((await repo.getLotLedger(USER))!.state!.open.filter((lot) => lot.funding === "paid"))
      .toHaveLength(1);
  });

  it("a commit spanning lots records each draw, paid first within a bucket", async () => {
    const repo = lotRepo();
    await repo.initializeUserCredits(USER, "free", 5, { signupBonus: 2 });
    await repo.addCreditsV2({
      userId: USER,
      amount: 10,
      description: "pack",
      paymentRef: "pay-1",
      options: { lot: PAID(10_000_000, 500_000) },
    });

    const reservation = await commit(repo, await hold(repo, 8));

    // Balance before bonus; within the bonus, paid before the free signup gift.
    expect(reservation.lotDraws!.map((draw) => [draw.bucket, draw.funding, draw.credits]))
      .toEqual([
        ["balance", "free", 5],
        ["bonus", "paid", 3],
      ]);
    expect(reservation.lotTotals).toEqual({
      revenueMicros: 3_000_000,
      feeMicros: 150_000,
      paidCredits: 3,
      freeCredits: 5,
      unknownCredits: 0,
      unknownFeeCredits: 0,
    });
    const [line] = await repo.getJournalEntries({ userId: USER, source: "operation_commit" });
    expect(line?.metadata).toMatchObject({ lotTotals: reservation.lotTotals });
    await expectLotsMatch(repo);
    expectValueConserved(repo);
  });

  it("a hold kept across a balance replacement is paid from the credits that backed it", async () => {
    const repo = lotRepo();
    await repo.initializeUserCredits(USER, "premium", 10);
    const id = await hold(repo, 8);

    // Only the new plan's credits: the old allotment expires except what backs the open
    // hold. The floor keeps 8 (the hold) and the target is 2, so 6 old credits are marked
    // as backing and the other 4 expire.
    await repo.updateUserTier(USER, { tier: "pro", monthlyLimit: 500, balance: 2 });
    await expectLotsMatch(repo);
    const expired = [...storeOf(repo).lotEvents.get(USER)!.values()].filter(
      (event) => event.kind === "expire"
    );
    expect(expired.map((event) => [event.reason, event.credits])).toEqual([["tier_balance", 4]]);

    const reservation = await commit(repo, id);
    expect(reservation.lotDraws!.map((draw) => [draw.portion, draw.credits])).toEqual([
      ["backing", 6],
      ["spendable", 2],
    ]);
    expect(new Set(reservation.lotDraws!.map((draw) => draw.lotId)).size).toBe(2);
    await expectLotsMatch(repo);
  });

  it("a mixed hold across a replacement draws backing, then the new allotment", async () => {
    const repo = lotRepo();
    await repo.initializeUserCredits(USER, "premium", 6);
    await repo.addCreditsV2({
      userId: USER,
      amount: 4,
      description: "pack",
      paymentRef: "pay-1",
      options: { lot: PAID(4_000_000) },
    });
    const id = await hold(repo, 9);
    // The hold needs 9 and the bonus covers 4, so 5 of the balance stay: 3 new and 2 old
    // marked as backing. The other 4 old credits expire.
    await repo.updateUserTier(USER, { tier: "pro", monthlyLimit: 500, balance: 3 });
    await expectLotsMatch(repo);

    const reservation = await commit(repo, id);
    expect(reservation.lotDraws!.map((draw) => [draw.bucket, draw.portion, draw.funding, draw.credits]))
      .toEqual([
        ["balance", "backing", "free", 2],
        ["balance", "spendable", "free", 3],
        ["bonus", "spendable", "paid", 4],
      ]);
    expect(reservation.lotTotals).toMatchObject({ paidCredits: 4, freeCredits: 5, revenueMicros: 4_000_000 });
    await expectLotsMatch(repo);
    expectValueConserved(repo);
  });

  it("a release after a replacement expires the backing it no longer needs", async () => {
    const repo = lotRepo();
    await repo.initializeUserCredits(USER, "premium", 10);
    const id = await hold(repo, 8);
    await repo.updateUserTier(USER, { tier: "pro", monthlyLimit: 500, balance: 2 });

    await repo.releaseReservationV2(USER, id);

    const events = [...storeOf(repo).lotEvents.get(USER)!.values()];
    expect(events.filter((event) => event.reason === "release").map((event) => event.credits))
      .toEqual([6]);
    expect((await repo.getUserCredits(USER))!.balance).toBe(2);
    await expectLotsMatch(repo);
  });

  it("an expired hold's backing leaves as breakage", async () => {
    const repo = lotRepo();
    await repo.initializeUserCredits(USER, "premium", 10);
    const id = await hold(repo, 8);
    await repo.updateUserTier(USER, { tier: "pro", monthlyLimit: 500, balance: 2 });

    await repo.expireReservationV2(USER, id, { asOf: new Date(Date.now() + 120_000) });

    const events = [...storeOf(repo).lotEvents.get(USER)!.values()];
    expect(events.filter((event) => event.reason === "expire").map((event) => event.kind))
      .toEqual(["expire"]);
    await expectLotsMatch(repo);
  });

  it("deduct records adjustments, not revenue", async () => {
    const repo = lotRepo();
    await repo.initializeUserCredits(USER, "free", 2, { signupBonus: 3 });
    await repo.deductCreditsAtomic(USER, 4, { referenceId: "adj-1" });
    const events = [...storeOf(repo).lotEvents.get(USER)!.values()];
    expect(events.map((event) => [event.kind, event.bucket, event.credits, event.ref])).toEqual([
      ["adjustment", "balance", 2, "adj-1"],
      ["adjustment", "bonus", 2, "adj-1"],
    ]);
    await expectLotsMatch(repo);
  });

  it("the monthly reset expires an excess and tops a shortfall up with a free lot", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const drift: LotDriftReport[] = [];
    const repo = lotRepo(drift);
    await repo.initializeUserCredits(USER, "free", 3);
    // Back-date the reset through the raw writer: a write the ledger only follows.
    await repo.updateUserCredits(USER, { monthlyResetAt: past });
    await repo.atomicMonthlyReset(USER, "free", past);

    const { state } = (await repo.getLotLedger(USER))!;
    const headers = await Promise.all(state!.open.map((lot) => repo.getLotHeader(USER, lot.id)));
    expect(headers.map((header) => [header!.sourceType, header!.granted])).toEqual(
      expect.arrayContaining([
        ["signup", 3],
        ["monthly_reset", 22],
      ])
    );
    expect(drift).toEqual([]);
    await expectLotsMatch(repo);
  });

  it("a reset on a paid tier is flagged", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const drift: LotDriftReport[] = [];
    const repo = lotRepo(drift);
    await repo.initializeUserCredits(USER, "premium", 3);
    await repo.updateUserCredits(USER, { monthlyResetAt: past });
    await repo.atomicMonthlyReset(USER, "premium", past);
    expect(drift).toEqual([
      expect.objectContaining({ operation: "atomicMonthlyReset", anomalies: ["paid_tier_reset"] }),
    ]);
    await expectLotsMatch(repo);
  });

  it("a subscription downgrade expires the balance above the cap", async () => {
    const repo = lotRepo();
    await repo.initializeUserCredits(USER, "premium", 200);
    await repo.updateUserTier(USER, {
      tier: "premium",
      monthlyLimit: 200,
      subscriptionExpiresAt: new Date(Date.now() - 10 * 86_400_000),
    });
    const result = await repo.checkAndHandleSubscriptionExpiry(USER);
    expect(result.wasDowngraded).toBe(true);
    const events = [...storeOf(repo).lotEvents.get(USER)!.values()];
    expect(events.map((event) => [event.reason, event.credits])).toEqual([
      ["subscription_downgrade", 175],
    ]);
    await expectLotsMatch(repo);
  });

  it("a raw balance write is followed and reported as drift", async () => {
    const drift: LotDriftReport[] = [];
    const repo = lotRepo(drift);
    await repo.initializeUserCredits(USER, "free", 3);
    await repo.updateUserCredits(USER, { bonusCreditsIncrement: 4 });
    expect(drift).toEqual([
      {
        userId: USER,
        operation: "updateUserCredits",
        drift: [{ bucket: "bonus", portion: "spendable", credits: 4, phase: "after" }],
        anomalies: [],
      },
    ]);
    await expectLotsMatch(repo);
  });

  it("a drift hook that throws does not fail the write", async () => {
    const repo = createInMemoryCreditRepository({
      lotLedger: "on",
      onLotDrift: () => {
        throw new Error("metrics down");
      },
    });
    await repo.initializeUserCredits(USER, "free", 3);
    await expect(repo.updateUserCredits(USER, { balance: 9 })).resolves.toBeUndefined();
    expect((await repo.getUserCredits(USER))!.balance).toBe(9);
  });

  it("an account without a ledger gets unknown legacy lots on its next write", async () => {
    const drift: LotDriftReport[] = [];
    const repo = lotRepo(drift);
    await repo.initializeUserCredits(USER, "free", 7, { signupBonus: 2 });
    // As if the account predates the ledger.
    storeOf(repo).lotStates.delete(USER);
    storeOf(repo).lotHeaders.delete(USER);
    expect(await repo.getLotLedger(USER)).toEqual({ state: null });

    const reservation = await commit(repo, await hold(repo, 8));

    expect(drift).toEqual([]);
    expect(reservation.lotTotals).toMatchObject({ unknownCredits: 8, revenueMicros: 0 });
    const headers = [...storeOf(repo).lotHeaders.get(USER)!.values()];
    expect(headers.map((header) => [header.sourceType, header.funding, header.bucket]))
      .toEqual(expect.arrayContaining([
        ["legacy", "unknown", "balance"],
        ["legacy", "unknown", "bonus"],
      ]));
    await expectLotsMatch(repo);
  });

  it("refuses a write that would open too many lots, and leaves the account untouched", async () => {
    const repo = lotRepo();
    await repo.initializeUserCredits(USER, "free", 0);
    for (let i = 0; i < 100; i++) {
      await repo.addCreditsV2({ userId: USER, amount: 1, description: `gift ${i}` });
    }
    const before = await repo.getUserCredits(USER);
    await expect(
      repo.addCreditsV2({ userId: USER, amount: 1, description: "one too many" })
    ).rejects.toMatchObject({ code: CreditErrorCode.LOT_LIMIT_EXCEEDED });
    expect(await repo.getUserCredits(USER)).toEqual(before);
    await expectLotsMatch(repo);
  });
});

describe("reverseLot", () => {
  async function purchased() {
    const repo = lotRepo();
    await repo.initializeUserCredits(USER, "free", 0);
    await repo.addCreditsV2({
      userId: USER,
      amount: 10,
      description: "pack",
      paymentRef: "pay-1",
      options: { lot: PAID(10_000_000, 500_000) },
    });
    await commit(repo, await hold(repo, 4));
    const lot = (await repo.getLotLedger(USER))!.state!.open.find((open) => open.funding === "paid")!;
    return { repo, lotId: lot.id };
  }

  it("a refund takes back what the lot holds and journals it", async () => {
    const { repo, lotId } = await purchased();
    const outcome = await repo.reverseLot({
      userId: USER,
      lotId,
      kind: "refund",
      reversalKey: "refund-1",
      refundMicros: 10_000_000,
    });
    expect(outcome).toMatchObject({
      outcome: "reversed",
      creditsRemoved: 6,
      event: {
        kind: "refund",
        credits: 6,
        valueMicros: 6_000_000,
        reversal: { contraRevenueMicros: 4_000_000, uncollectedCredits: 4 },
      },
    });
    expect((await repo.getUserCredits(USER))!.bonusCredits).toBe(0);
    const [line] = await repo.getJournalEntries({ userId: USER, source: "refund" });
    expect(line).toMatchObject({ entryType: "debit", amount: 6, referenceId: "refund-1" });
    expect(await repo.getLotHeader(USER, lotId)).toMatchObject({
      drawnValueMicros: 10_000_000,
      drawnFeeMicros: 500_000,
    });
    await expectLotsMatch(repo);
    expectValueConserved(repo);
  });

  it("a repeat is replayed and a reused key is a conflict; neither writes", async () => {
    const { repo, lotId } = await purchased();
    const input = {
      userId: USER,
      lotId,
      kind: "refund" as const,
      reversalKey: "refund-1",
      refundMicros: 1_000_000,
      credits: 1,
    };
    await repo.reverseLot(input);
    const before = await repo.getUserCredits(USER);

    expect((await repo.reverseLot(input)).outcome).toBe("replayed");
    expect(await repo.reverseLot({ ...input, kind: "chargeback" })).toMatchObject({
      outcome: "conflict",
      mismatch: "kind",
    });
    expect(await repo.reverseLot({ ...input, lotId: "other" })).toMatchObject({
      outcome: "conflict",
      mismatch: "lotId",
    });
    expect(await repo.getUserCredits(USER)).toEqual(before);
  });

  it("an unknown lot is not_found", async () => {
    const { repo } = await purchased();
    expect(
      await repo.reverseLot({ userId: USER, lotId: "nope", kind: "refund", reversalKey: "k", refundMicros: 0 })
    ).toEqual({ outcome: "not_found", lotId: "nope" });
  });

  it("a chargeback never uncovers an open hold", async () => {
    const { repo, lotId } = await purchased();
    await hold(repo, 5);
    const outcome = await repo.reverseLot({
      userId: USER,
      lotId,
      kind: "chargeback",
      reversalKey: "cb-1",
      refundMicros: 10_000_000,
      chargebackFeeMicros: 15_000_000,
    });
    expect(outcome).toMatchObject({
      outcome: "reversed",
      creditsRemoved: 1,
      event: { reversal: { keptCredits: 5, chargebackFeeMicros: 15_000_000 } },
    });
    const credits = (await repo.getUserCredits(USER))!;
    expect(credits.bonusCredits).toBe(credits.reserved);
    await expectLotsMatch(repo);
  });

  it("a closed lot reverses for 0 credits, still journaled", async () => {
    const repo = lotRepo();
    await repo.initializeUserCredits(USER, "free", 0);
    await repo.addCreditsV2({
      userId: USER,
      amount: 2,
      description: "pack",
      paymentRef: "pay-1",
      options: { lot: PAID(2_000_000) },
    });
    const lotId = (await repo.getLotLedger(USER))!.state!.open[0]!.id;
    await commit(repo, await hold(repo, 2));
    expect((await repo.getLotHeader(USER, lotId))!.closedAt).toBeDefined();

    const outcome = await repo.reverseLot({
      userId: USER,
      lotId,
      kind: "refund",
      reversalKey: "late",
      refundMicros: 2_000_000,
    });
    expect(outcome).toMatchObject({
      outcome: "reversed",
      creditsRemoved: 0,
      event: { reversal: { contraRevenueMicros: 2_000_000, uncollectedCredits: 2 } },
    });
    expect(await repo.getJournalEntries({ userId: USER, source: "refund" })).toHaveLength(1);
  });

  it("refuses a malformed amount before writing", async () => {
    const { repo, lotId } = await purchased();
    const before = await repo.getUserCredits(USER);
    await expect(
      repo.reverseLot({ userId: USER, lotId, kind: "refund", reversalKey: "k", refundMicros: 0.5 })
    ).rejects.toBeInstanceOf(CreditError);
    expect(await repo.getUserCredits(USER)).toEqual(before);
  });
});

describe("random operation sequences", () => {
  function rng(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
  }

  async function runSequence(seed: number, concurrent: boolean) {
    const random = rng(seed);
    const drift: LotDriftReport[] = [];
    const repo = lotRepo(drift);
    if (concurrent) {
      repo.setSchedulingHook(() => new Promise((resolve) => setTimeout(resolve, random() * 3)));
    }
    await repo.initializeUserCredits(USER, "premium", 20, { signupBonus: 5 });
    const open: string[] = [];
    const amount = () => Math.max(0.01, Math.round(random() * 800) / 100);
    let payment = 0;

    const step = async () => {
      const pick = random();
      try {
        if (pick < 0.25) {
          payment++;
          const credits = amount();
          await repo.addCreditsV2({
            userId: USER,
            amount: credits,
            description: "pack",
            paymentRef: `pay-${seed}-${payment}`,
            options:
              random() < 0.7
                ? { lot: PAID(Math.round(credits * 1_000_000), random() < 0.5 ? null : 1_000) }
                : { lot: { funding: "free" } },
          });
        } else if (pick < 0.5) {
          const reserved = await repo.reserveCreditsV2({
            userId: USER,
            amount: amount(),
            operationType: OP,
            expiresAt: soon(),
          });
          if (reserved.outcome === "created") open.push(reserved.reservation.id);
        } else if (pick < 0.7) {
          const id = open.splice(Math.floor(random() * open.length), 1)[0];
          if (id) await repo.commitReservationV2(USER, id);
        } else if (pick < 0.78) {
          const id = open.splice(Math.floor(random() * open.length), 1)[0];
          if (id) await repo.releaseReservationV2(USER, id);
        } else if (pick < 0.86) {
          await repo.updateUserTier(USER, {
            tier: "premium",
            monthlyLimit: 200,
            balance: Math.round(random() * 3000) / 100,
          });
        } else if (pick < 0.92) {
          await repo.deductCreditsAtomic(USER, amount());
        } else {
          const ledger = (await repo.getLotLedger(USER))!.state!;
          const lot = ledger.open[Math.floor(random() * ledger.open.length)];
          if (lot) {
            await repo.reverseLot({
              userId: USER,
              lotId: lot.id,
              kind: random() < 0.5 ? "refund" : "chargeback",
              reversalKey: `rev-${seed}-${Math.floor(random() * 1e9)}`,
              refundMicros: Math.floor(random() * 5_000_000),
            });
          }
        }
      } catch (error) {
        // Shortfalls are part of the game; anything else is a failure.
        if (!/Insufficient/i.test(String(error))) throw error;
      }
    };

    if (concurrent) {
      for (let round = 0; round < 10; round++) {
        await Promise.all(Array.from({ length: 6 }, step));
        await expectLotsMatch(repo);
      }
    } else {
      for (let i = 0; i < 60; i++) {
        await step();
        await expectLotsMatch(repo);
      }
    }
    for (const id of open) await repo.releaseReservationV2(USER, id);
    await expectLotsMatch(repo);
    expectValueConserved(repo);
    expect(drift).toEqual([]);
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("sequential seed %i keeps lots equal to the account", async (seed) => {
    await runSequence(seed, false);
  });

  it.each([11, 12, 13, 14])("interleaved seed %i keeps lots equal to the account", async (seed) => {
    await runSequence(seed, true);
  }, 30_000);
});

describe("hooks are not called for clean writes", () => {
  it("a full happy path reports nothing", async () => {
    const onLotDrift = vi.fn();
    const repo = createInMemoryCreditRepository({ lotLedger: "on", onLotDrift });
    await repo.initializeUserCredits(USER, "free", 25, { signupBonus: 10 });
    await repo.addCreditsV2({ userId: USER, amount: 5, description: "x", paymentRef: "p", options: { lot: PAID(5) } });
    await commit(repo, await hold(repo, 30));
    expect(onLotDrift).not.toHaveBeenCalled();
  });
});
