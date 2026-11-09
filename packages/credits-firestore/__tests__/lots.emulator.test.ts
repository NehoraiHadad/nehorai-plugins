/**
 * The lot ledger against a real Firestore: every writer keeps the inline lots equal to
 * the account in the same transaction, commits record their draws, reversals are keyed,
 * legacy accounts start with unknown lots, and contention leaves no drift.
 *
 * Run with `pnpm test:emulator`. Skipped when FIRESTORE_EMULATOR_HOST is unset.
 */
import { randomUUID } from "node:crypto";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CreditErrorCode,
  heldExpiredBacking,
  lotBucketsOf,
  lotSums,
  supportsLots,
  type LotDriftReport,
  type LotEvent,
  type LotHeader,
  type LotSpec,
  type PortableReservation,
} from "@nehorai/credits";
import {
  BALANCE_DOC_ID,
  FirestoreCreditRepository,
  getUserCreditsCollection,
  getUserReservationsCollection,
} from "../src";
import { getUserJournalCollection } from "../src/repository/journal.js";
import { getUserLotEventsCollection, getUserLotsCollection } from "../src/repository/lots.js";
import type { FirestoreUserCredits } from "../src/repository/credits-doc.js";
import { retryEmulatorClosedTransactions } from "./emulator-transactions.js";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const DAY = 86_400_000;
const OP = "story_generation";
const PAID = (valueMicros: number, feeMicros: number | null = null): LotSpec => ({
  funding: "paid",
  valueMicros,
  feeMicros,
});

describe.skipIf(!emulator)("credit lots (emulator)", { timeout: 120_000 }, () => {
  let app: App;
  let db: Firestore;
  let repo: FirestoreCreditRepository;
  let plain: FirestoreCreditRepository;
  const drift: LotDriftReport[] = [];

  beforeAll(() => {
    app = initializeApp({ projectId: "credits-firestore-test" }, `lots-${randomUUID()}`);
    db = retryEmulatorClosedTransactions(getFirestore(app));
    repo = new FirestoreCreditRepository(db, {
      lotLedger: "on",
      onLotDrift: (report) => drift.push(report),
      getDowngradeBalanceCap: () => 25,
    });
    plain = new FirestoreCreditRepository(db);
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  const newUser = () => `user-${randomUUID()}`;
  const balanceRef = (userId: string) => getUserCreditsCollection(db, userId).doc(BALANCE_DOC_ID);
  const raw = async (userId: string) =>
    (await balanceRef(userId).get()).data() as FirestoreUserCredits;
  const headers = async (userId: string) =>
    (await getUserLotsCollection(db, userId).get()).docs.map(
      (doc) => doc.data() as LotHeader & { userId: string }
    );
  const events = async (userId: string) =>
    (await getUserLotEventsCollection(db, userId).get()).docs.map(
      (doc) => doc.data() as LotEvent & { userId: string }
    );
  const driftFor = (userId: string) => drift.filter((report) => report.userId === userId);

  async function hold(userId: string, amount: number, r = repo) {
    const outcome = await r.reserveCreditsV2({
      userId,
      amount,
      operationType: OP,
      expiresAt: new Date(Date.now() + 60_000),
    });
    if (outcome.outcome !== "created") throw new Error(`expected a hold, got ${outcome.outcome}`);
    return outcome.reservation.id;
  }

  async function commit(userId: string, reservationId: string) {
    const outcome = await repo.commitReservationV2(userId, reservationId);
    if (outcome.outcome !== "committed") throw new Error(`expected a commit, got ${outcome.outcome}`);
    return (await repo.getReservation(userId, reservationId)) as PortableReservation;
  }

  function purchase(userId: string, amount: number, ref: string, lot: LotSpec = PAID(amount * 1_000_000)) {
    return repo.addCreditsIdempotent({
      userId,
      amount,
      description: "pack",
      paymentRef: ref,
      options: { lot },
    });
  }

  /** The inline lots equal the account, bucket by bucket. */
  async function expectLotsMatch(userId: string) {
    const doc = await raw(userId);
    expect(doc.lots).toBeDefined();
    const credits = (await repo.getUserCredits(userId))!;
    expect(lotSums(doc.lots!)).toEqual(
      lotBucketsOf(
        credits.balance,
        heldExpiredBacking(credits.balance, credits.expiredHoldBacking),
        credits.bonusCredits
      )
    );
    // Every open lot has a header that is not closed.
    const byId = new Map((await headers(userId)).map((header) => [header.id, header]));
    for (const lot of doc.lots!.open) {
      expect(byId.get(lot.id)).toMatchObject({ userId, funding: lot.funding, granted: lot.granted });
      expect(byId.get(lot.id)!.closedAt).toBeUndefined();
    }
  }

  /** Every paid lot's value left exactly once, across draws, events and what is open. */
  async function expectValueConserved(userId: string) {
    const doc = await raw(userId);
    const reservations = (await getUserReservationsCollection(db, userId).get()).docs.map(
      (d) => d.data() as PortableReservation
    );
    const left = new Map<string, number>();
    for (const draw of reservations.flatMap((reservation) => reservation.lotDraws ?? [])) {
      left.set(draw.lotId, (left.get(draw.lotId) ?? 0) + (draw.valueMicros ?? 0));
    }
    for (const event of await events(userId)) {
      if (event.kind === "reconcile" && event.reason === "unknown_lot") continue;
      left.set(event.lotId, (left.get(event.lotId) ?? 0) + (event.valueMicros ?? 0));
    }
    const open = new Map(doc.lots!.open.map((lot) => [lot.id, lot]));
    for (const header of await headers(userId)) {
      if (header.valueMicros === null) continue;
      const lot = open.get(header.id);
      if (lot) expect(left.get(header.id) ?? 0).toBe(lot.drawnValueMicros);
      else {
        expect(header.closedAt).toBeDefined();
        expect(left.get(header.id) ?? 0).toBe(header.valueMicros);
        expect(header.drawnValueMicros).toBe(header.valueMicros);
      }
    }
  }

  describe("lotLedger off", () => {
    it("writes no lot, no header and no event, and refuses reversals", async () => {
      const userId = newUser();
      await plain.initializeUserCredits(userId, "free", 10, { signupBonus: 5 });
      await plain.addCreditsIdempotent({
        userId,
        amount: 4,
        description: "pack",
        paymentRef: `pay-${userId}`,
        options: { lot: PAID(4_000_000) },
      });
      const id = await hold(userId, 6, plain);
      await plain.commitReservationV2(userId, id);

      expect(plain.lotLedger).toBe("off");
      expect(supportsLots(plain)).toBe(false);
      expect((await raw(userId)).lots).toBeUndefined();
      expect(await headers(userId)).toEqual([]);
      expect(await events(userId)).toEqual([]);
      expect((await plain.getReservation(userId, id))!.lotDraws).toBeUndefined();
      await expect(
        plain.reverseLot({ userId, lotId: "x", kind: "refund", reversalKey: "k", refundMicros: 0 })
      ).rejects.toMatchObject({ code: CreditErrorCode.UNSUPPORTED_OPERATION });
    });
  });

  describe("lotLedger on", () => {
    it("opens free signup lots with headers", async () => {
      const userId = newUser();
      await repo.initializeUserCredits(userId, "free", 25, { signupBonus: 10 });

      expect(supportsLots(repo)).toBe(true);
      const { state } = (await repo.getLotLedger(userId))!;
      expect(state!.open.map((lot) => [lot.bucket, lot.funding, lot.spendable])).toEqual(
        expect.arrayContaining([
          ["balance", "free", 25],
          ["bonus", "free", 10],
        ])
      );
      for (const lot of state!.open) {
        expect(await repo.getLotHeader(userId, lot.id)).toMatchObject({
          sourceType: "signup",
          valuationBasis: "free",
        });
      }
      await expectLotsMatch(userId);
      expect(driftFor(userId)).toEqual([]);
    });

    it("a commit spanning lots stores its draws on the reservation and the journal line", async () => {
      const userId = newUser();
      await repo.initializeUserCredits(userId, "free", 5, { signupBonus: 2 });
      await purchase(userId, 10, `pay-${userId}`, PAID(10_000_000, 500_000));

      const reservation = await commit(userId, await hold(userId, 8));

      expect(reservation.lotDraws!.map((draw) => [draw.bucket, draw.funding, draw.credits])).toEqual([
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
      const lines = (await getUserJournalCollection(db, userId).get()).docs.map((doc) => doc.data());
      expect(lines.find((line) => line.source === "operation_commit")?.metadata).toMatchObject({
        lotTotals: reservation.lotTotals,
      });
      // The signup balance lot emptied and was closed.
      const closed = (await headers(userId)).filter((header) => header.closedAt);
      expect(closed.map((header) => [header.bucket, header.sourceType])).toEqual([["balance", "signup"]]);
      await expectLotsMatch(userId);
      await expectValueConserved(userId);
    });

    it("an upgrade grants only the new plan; a hold across it is paid from its backing first", async () => {
      const userId = newUser();
      await repo.initializeUserCredits(userId, "free", 10);
      await purchase(userId, 4, `pay-${userId}`);
      const id = await hold(userId, 9);

      const granted = await repo.grantSubscriptionCycle({
        userId,
        grantKey: `upgrade/${userId}`,
        tier: "premium",
        credits: 3,
        subscriptionExpiresAt: new Date(Date.now() + 30 * DAY),
        monthlyResetAt: new Date(Date.now() + 30 * DAY),
        description: "Upgrade",
        lot: { ...PAID(3_000_000, 90_000), sourceType: "subscription_upgrade" },
      });
      expect(granted.outcome).toBe("granted");
      await expectLotsMatch(userId);
      const expired = (await events(userId)).filter((event) => event.kind === "expire");
      expect(expired.map((event) => [event.reason, event.credits])).toEqual([["cycle_replaced", 8]]);
      expect(await headers(userId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceType: "subscription_upgrade",
            sourceRef: `upgrade/${userId}`,
            funding: "paid",
            granted: 3,
          }),
        ])
      );

      const reservation = await commit(userId, id);
      expect(
        reservation.lotDraws!.map((draw) => [draw.bucket, draw.portion, draw.funding, draw.credits])
      ).toEqual([
        ["balance", "backing", "free", 2],
        ["balance", "spendable", "paid", 3],
        ["bonus", "spendable", "paid", 4],
      ]);
      await expectLotsMatch(userId);
      await expectValueConserved(userId);

      // A repeat of the grant writes nothing.
      const before = await raw(userId);
      expect(
        (
          await repo.grantSubscriptionCycle({
            userId,
            grantKey: `upgrade/${userId}`,
            tier: "premium",
            credits: 3,
            subscriptionExpiresAt: new Date(Date.now() + 30 * DAY),
            monthlyResetAt: new Date(Date.now() + 30 * DAY),
            description: "Upgrade",
            lot: PAID(3_000_000),
          })
        ).outcome
      ).toBe("replayed");
      expect((await raw(userId)).lots).toEqual(before.lots);
    });

    it("a release or an expiry after a replacement expires the backing", async () => {
      const userId = newUser();
      await repo.initializeUserCredits(userId, "free", 10);
      const released = await hold(userId, 4);
      const expiring = await hold(userId, 4);
      await repo.updateUserTier(userId, { tier: "premium", monthlyLimit: 100, balance: 1 });
      await expectLotsMatch(userId);

      await repo.releaseReservationV2(userId, released);
      await repo.expireReservationV2(userId, expiring, { asOf: new Date(Date.now() + 120_000) });

      const reasons = (await events(userId))
        .filter((event) => event.kind === "expire")
        .map((event) => event.reason)
        .sort();
      expect(reasons).toEqual(["expire", "release", "tier_balance"]);
      expect((await repo.getUserCredits(userId))!.balance).toBe(1);
      await expectLotsMatch(userId);
    });

    it("deduct, the monthly reset and the expiry downgrade keep the lots", async () => {
      const userId = newUser();
      await repo.initializeUserCredits(userId, "premium", 200, { signupBonus: 3 });
      await repo.deductCreditsAtomic(userId, 10, { referenceId: `adj-${userId}`, description: "fix" });
      expect((await events(userId)).map((event) => [event.kind, event.ref])).toEqual([
        ["adjustment", `adj-${userId}`],
      ]);

      const past = new Date(Date.now() - DAY).toISOString();
      await balanceRef(userId).update({ monthlyResetAt: past });
      await repo.atomicMonthlyReset(userId, "premium", past);
      expect(driftFor(userId)).toEqual([
        expect.objectContaining({ operation: "atomicMonthlyReset", anomalies: ["paid_tier_reset"], drift: [] }),
      ]);
      await expectLotsMatch(userId);

      await repo.updateUserTier(userId, {
        tier: "premium",
        monthlyLimit: 200,
        subscriptionExpiresAt: new Date(Date.now() - 10 * DAY),
      });
      const result = await repo.checkAndHandleSubscriptionExpiry(userId);
      expect(result.wasDowngraded).toBe(true);
      expect(
        (await events(userId)).filter((event) => event.reason === "subscription_downgrade")
          .reduce((sum, event) => sum + event.credits, 0)
      ).toBe(175);
      await expectLotsMatch(userId);
    });

    it("a credit for a missing account seeds it with lots", async () => {
      const userId = newUser();
      await purchase(userId, 7, `pay-${userId}`);
      await expectLotsMatch(userId);
      expect((await headers(userId)).map((header) => header.sourceType)).toEqual(["purchase"]);

      const seeded = newUser();
      await hold(seeded, 3);
      await expectLotsMatch(seeded);
      expect((await headers(seeded)).map((header) => header.sourceType)).toEqual(["seed"]);
    });
  });

  describe("reverseLot", () => {
    async function purchased() {
      const userId = newUser();
      await repo.initializeUserCredits(userId, "free", 0);
      await purchase(userId, 10, `pay-${userId}`, PAID(10_000_000, 500_000));
      await commit(userId, await hold(userId, 4));
      const lot = (await repo.getLotLedger(userId))!.state!.open.find((open) => open.funding === "paid")!;
      return { userId, lotId: lot.id };
    }

    it("a refund takes back what the lot holds, once", async () => {
      const { userId, lotId } = await purchased();
      const input = {
        userId,
        lotId,
        kind: "refund" as const,
        reversalKey: `refund/${userId}`,
        refundMicros: 10_000_000,
      };
      const outcome = await repo.reverseLot(input);
      expect(outcome).toMatchObject({
        outcome: "reversed",
        creditsRemoved: 6,
        event: {
          credits: 6,
          valueMicros: 6_000_000,
          reversal: { contraRevenueMicros: 4_000_000, retainedRevenueMicros: 0, uncollectedCredits: 4 },
        },
      });
      expect((await repo.getUserCredits(userId))!.bonusCredits).toBe(0);
      expect(await repo.getLotHeader(userId, lotId)).toMatchObject({
        drawnValueMicros: 10_000_000,
        drawnFeeMicros: 500_000,
      });
      const before = await raw(userId);

      expect((await repo.reverseLot(input)).outcome).toBe("replayed");
      expect(await repo.reverseLot({ ...input, kind: "chargeback" })).toMatchObject({
        outcome: "conflict",
        mismatch: "kind",
      });
      expect(await repo.reverseLot({ ...input, lotId: "other" })).toMatchObject({
        outcome: "conflict",
        mismatch: "lotId",
      });
      expect((await raw(userId)).lots).toEqual(before.lots);
      const refunds = (await getUserJournalCollection(db, userId).get()).docs
        .map((doc) => doc.data())
        .filter((line) => line.source === "refund");
      expect(refunds).toEqual([
        expect.objectContaining({ amount: 6, referenceId: `refund/${userId}`, entryType: "debit" }),
      ]);
      await expectLotsMatch(userId);
      await expectValueConserved(userId);
    });

    it("a chargeback never uncovers an open hold", async () => {
      const { userId, lotId } = await purchased();
      await hold(userId, 5);
      const outcome = await repo.reverseLot({
        userId,
        lotId,
        kind: "chargeback",
        reversalKey: `cb/${userId}`,
        refundMicros: 10_000_000,
        chargebackFeeMicros: 15_000_000,
      });
      expect(outcome).toMatchObject({
        outcome: "reversed",
        creditsRemoved: 1,
        event: { reversal: { keptCredits: 5, chargebackFeeMicros: 15_000_000 } },
      });
      const credits = (await repo.getUserCredits(userId))!;
      expect(credits.bonusCredits).toBe(credits.reserved);
      await expectLotsMatch(userId);
    });

    it("an unknown lot is not_found and writes nothing", async () => {
      const { userId } = await purchased();
      const before = await raw(userId);
      expect(
        await repo.reverseLot({ userId, lotId: "nope", kind: "refund", reversalKey: "k", refundMicros: 0 })
      ).toEqual({ outcome: "not_found", lotId: "nope" });
      expect(await raw(userId)).toEqual(before);
    });
  });

  describe("accounts written without lots", () => {
    it("a legacy account gets unknown lots on its first write, with no drift reported", async () => {
      const userId = newUser();
      await plain.initializeUserCredits(userId, "free", 7, { signupBonus: 2 });
      expect((await repo.getLotLedger(userId))!.state).toBeNull();

      const reservation = await commit(userId, await hold(userId, 8));

      expect(reservation.lotTotals).toMatchObject({ unknownCredits: 8, revenueMicros: 0 });
      expect((await headers(userId)).map((header) => [header.sourceType, header.bucket]).sort()).toEqual([
        ["legacy", "balance"],
        ["legacy", "bonus"],
      ]);
      expect(driftFor(userId)).toEqual([]);
      await expectLotsMatch(userId);
    });

    it("a write by a repository with lots off is reconciled and reported on the next write", async () => {
      const userId = newUser();
      await repo.initializeUserCredits(userId, "free", 5);
      await plain.addCreditsAtomic(userId, 3, "gift outside the ledger");
      expect(driftFor(userId)).toEqual([]);

      await repo.deductCreditsAtomic(userId, 1);

      expect(driftFor(userId)).toEqual([
        expect.objectContaining({
          operation: "deductCredits",
          drift: [{ bucket: "bonus", portion: "spendable", credits: 3, phase: "before" }],
        }),
      ]);
      expect((await events(userId)).filter((event) => event.kind === "reconcile")).toEqual([
        expect.objectContaining({ reason: "unknown_lot", credits: 3, funding: "unknown" }),
      ]);
      await expectLotsMatch(userId);
    });
  });

  describe("contention", () => {
    it("concurrent purchases, reserves and commits on one account leave no drift", async () => {
      const userId = newUser();
      await repo.initializeUserCredits(userId, "free", 20, { signupBonus: 5 });

      const holds = await Promise.all(Array.from({ length: 4 }, () => hold(userId, 3)));
      await Promise.all([
        ...holds.map((id) => repo.commitReservationV2(userId, id)),
        ...Array.from({ length: 4 }, (_, i) => purchase(userId, 2, `pay-${userId}-${i}`)),
        repo.deductCreditsAtomic(userId, 1),
        hold(userId, 2),
      ]);

      expect(driftFor(userId)).toEqual([]);
      await expectLotsMatch(userId);
      await expectValueConserved(userId);
      const credits = (await repo.getUserCredits(userId))!;
      expect(credits.balance + credits.bonusCredits).toBe(20);
      expect(credits.reserved).toBe(2);
    });

    it("a concurrent refund and commit on one lot never take the same credits twice", async () => {
      const userId = newUser();
      await repo.initializeUserCredits(userId, "free", 0);
      await purchase(userId, 10, `pay-${userId}`);
      const lotId = (await repo.getLotLedger(userId))!.state!.open[0]!.id;
      const id = await hold(userId, 6);

      const [, refund] = await Promise.all([
        repo.commitReservationV2(userId, id),
        repo.reverseLot({ userId, lotId, kind: "refund", reversalKey: `r/${userId}`, refundMicros: 1 }),
      ]);

      expect(refund).toMatchObject({ outcome: "reversed", creditsRemoved: 4 });
      expect((await repo.getUserCredits(userId))!).toMatchObject({ bonusCredits: 0, reserved: 0 });
      expect(driftFor(userId)).toEqual([]);
      await expectLotsMatch(userId);
      await expectValueConserved(userId);
    });
  });
});
