/**
 * Account creation, the signup-grant claim, once-only paid credits and expired
 * credits backing a hold, against a real Firestore (the emulator): real transaction
 * contention and real documents.
 *
 * Run with `pnpm test:emulator` (needs Java for the emulator). Skipped when
 * FIRESTORE_EMULATOR_HOST is unset, so `pnpm test` stays hermetic.
 */
import { randomUUID } from "node:crypto";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { holdExpiredBacking } from "@nehorai/credits";
import {
  BALANCE_DOC_ID,
  FirestoreCreditRepository,
  ReservationAtomicOps,
  getUserCreditsCollection,
  getUserReservationsCollection,
  getUserTransactionsCollection,
  type FirestoreRepositoryOptions,
} from "../src";
import { getUserJournalCollection } from "../src/repository/journal.js";
import { retryEmulatorClosedTransactions } from "./emulator-transactions.js";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const DAY = 86_400_000;
const PERIOD_END = "2027-02-01T00:00:00.000Z";
const RESET_AT = "2027-02-05T00:00:00.000Z";

describe.skipIf(!emulator)("Firestore ledger guards (emulator)", { timeout: 30_000 }, () => {
  let app: App;
  let db: Firestore;

  beforeAll(() => {
    app = initializeApp({ projectId: "credits-firestore-test" }, `guards-${randomUUID()}`);
    db = retryEmulatorClosedTransactions(getFirestore(app));
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  const balanceRef = (userId: string) => getUserCreditsCollection(db, userId).doc(BALANCE_DOC_ID);
  const repoWith = (options: FirestoreRepositoryOptions = {}) =>
    new FirestoreCreditRepository(db, options);
  const newUser = () => `user-${randomUUID()}`;
  const claimRef = () => db.collection("signup_grant_records").doc(randomUUID());
  const stored = async (userId: string) =>
    (await balanceRef(userId).get()).data() as Record<string, any>;

  async function seed(fields: Record<string, unknown>): Promise<string> {
    const userId = newUser();
    await balanceRef(userId).set({
      userId,
      balance: 0,
      bonusCredits: 0,
      reserved: 0,
      tier: "premium",
      monthlyLimit: 500,
      monthlyUsed: 2,
      monthlyResetAt: new Date(Date.now() - DAY).toISOString(),
      subscriptionExpiresAt: new Date(Date.now() - 400 * DAY).toISOString(),
      ...fields,
    });
    return userId;
  }

  async function hold(repo: FirestoreCreditRepository, userId: string, amount: number) {
    const reserved = await repo.reserveCreditsV2({
      userId,
      amount,
      operationType: "audio_generation",
      expiresAt: new Date(Date.now() + 60_000),
    });
    if (reserved.outcome !== "created") throw new Error(`no hold: ${reserved.outcome}`);
    return reserved.reservation.id;
  }

  /** The audit case: 100 credits, 80 held, expired down to a cap of 0. */
  async function expiredAccount(amounts = { balance: 100, held: 80, cap: 0, bonusCredits: 0 }) {
    const repo = repoWith({ getDowngradeBalanceCap: () => amounts.cap });
    const userId = await seed({ balance: amounts.balance, bonusCredits: amounts.bonusCredits });
    const reservationId = await hold(repo, userId, amounts.held);
    const result = await repo.checkAndHandleSubscriptionExpiry(userId, 3);
    expect(result.wasDowngraded).toBe(true);
    return { repo, userId, reservationId };
  }

  describe("initializeUserCredits", () => {
    it("a late second call leaves balance, bonus and reserved alone", async () => {
      const repo = repoWith();
      const userId = newUser();
      await repo.initializeUserCredits(userId, "free", 25);
      await repo.addCreditsAtomic(userId, 10, "bonus");
      await hold(repo, userId, 20);

      const again = await repo.initializeUserCredits(userId, "free", 25);

      expect(again).toMatchObject({ balance: 25, bonusCredits: 10, reserved: 20 });
      expect(await stored(userId)).toMatchObject({ balance: 25, bonusCredits: 10, reserved: 20 });
    });

    it("concurrent calls create one account", async () => {
      const repo = repoWith();
      const userId = newUser();

      const results = await Promise.all(
        Array.from({ length: 5 }, () => repo.initializeUserCredits(userId, "free", 25))
      );

      expect(results.every((credits) => credits.balance === 25)).toBe(true);
      expect((await stored(userId)).balance).toBe(25);
    });

    it("without a claim, records no signupGrant", async () => {
      const userId = newUser();
      const credits = await repoWith().initializeUserCredits(userId, "free", 25);

      expect(credits.signupGrant).toBeUndefined();
      expect((await stored(userId)).signupGrant).toBeUndefined();
    });
  });

  describe("signup grant claim", () => {
    it("an absent claim gives the grant and writes only a server timestamp", async () => {
      const repo = repoWith();
      const userId = newUser();
      const claim = claimRef();

      const created = await repo.initializeUserCredits(userId, "free", 25, {
        signupGrantClaim: claim,
      });

      expect(created).toMatchObject({ balance: 25, signupGrant: 25, monthlyLimit: 25 });
      expect(await stored(userId)).toMatchObject({ balance: 25, signupGrant: 25 });
      const data = (await claim.get()).data()!;
      expect(Object.keys(data)).toEqual(["claimedAt"]);
      expect(typeof data.claimedAt.toDate).toBe("function");
    });

    it("an existing claim starts the account at 0 with no signupGrant", async () => {
      const repo = repoWith();
      const claim = claimRef();
      await claim.set({ claimedAt: new Date() });
      const before = (await claim.get()).updateTime;
      const userId = newUser();

      const created = await repo.initializeUserCredits(userId, "free", 25, {
        signupGrantClaim: claim,
      });

      expect(created).toMatchObject({ balance: 0, monthlyLimit: 25 });
      expect(created).not.toHaveProperty("signupGrant");
      expect(await stored(userId)).not.toHaveProperty("signupGrant");
      expect(await repo.getUserCredits(userId)).not.toHaveProperty("signupGrant");
      expect((await claim.get()).updateTime!.isEqual(before!)).toBe(true);
    });

    it("a zero grant writes no claim", async () => {
      const claim = claimRef();
      const userId = newUser();
      const created = await repoWith().initializeUserCredits(userId, "free", 0, {
        signupGrantClaim: claim,
      });

      expect(created).toMatchObject({ balance: 0 });
      expect(created).not.toHaveProperty("signupGrant");
      expect(await stored(userId)).not.toHaveProperty("signupGrant");
      expect((await claim.get()).exists).toBe(false);
    });

    it("an existing account returns unchanged and takes no claim", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 7, tier: "free" });
      const claim = claimRef();

      const credits = await repo.initializeUserCredits(userId, "free", 25, {
        signupGrantClaim: claim,
      });

      expect(credits.balance).toBe(7);
      expect(credits.signupGrant).toBeUndefined();
      expect((await stored(userId)).signupGrant).toBeUndefined();
      expect((await claim.get()).exists).toBe(false);
    });

    it("concurrent signups on one claim grant once", async () => {
      const repo = repoWith();
      const claim = claimRef();

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          repo.initializeUserCredits(newUser(), "free", 25, { signupGrantClaim: claim })
        )
      );

      expect(results.map((credits) => credits.balance).sort((a, b) => a - b)).toEqual([
        0, 0, 0, 0, 25,
      ]);
      expect(results.filter((credits) => credits.signupGrant === 25)).toHaveLength(1);
    });
  });

  describe("addCreditsIdempotent", () => {
    const input = (userId: string, overrides = {}) => ({
      userId,
      amount: 40,
      description: "Purchase",
      paymentRef: "pay/123",
      ...overrides,
    });

    it("concurrent deliveries credit once, with one row and one journal entry", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 5, bonusCredits: 1 });

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => repo.addCreditsIdempotent(input(userId)))
      );

      expect(outcomes.filter((o) => o.outcome === "created")).toHaveLength(1);
      expect(outcomes.filter((o) => o.outcome === "replayed")).toHaveLength(4);
      expect((await stored(userId)).bonusCredits).toBe(41);
      expect((await getUserTransactionsCollection(db, userId).get()).size).toBe(1);
      const journal = await getUserJournalCollection(db, userId).get();
      expect(journal.size).toBe(1);
      expect(journal.docs[0].data()).toMatchObject({
        amount: 40,
        balanceAfter: 46,
        source: "purchase",
      });
    });

    it("a replay returns the original row", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 5 });
      const first = await repo.addCreditsIdempotent(input(userId));
      if (first.outcome !== "created") throw new Error("expected created");

      const replay = await repo.addCreditsIdempotent(input(userId));

      expect(replay).toMatchObject({
        outcome: "replayed",
        transaction: { id: first.transaction!.id, amount: 40, newBalance: 45 },
      });
      expect((await stored(userId)).bonusCredits).toBe(40);
    });

    it("the same reference with another amount is a conflict and writes nothing", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 5 });
      await repo.addCreditsIdempotent(input(userId));

      const conflict = await repo.addCreditsIdempotent(input(userId, { amount: 41 }));

      expect(conflict).toMatchObject({ outcome: "conflict", mismatch: "amount" });
      expect((await stored(userId)).bonusCredits).toBe(40);
    });

    it("updates the caller's document atomically, only when applied", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 5 });
      const order = db.collection("orders").doc(randomUUID());
      await order.set({ creditsGranted: false, writes: 0 });
      const alsoUpdate = { ref: order, data: { creditsGranted: true, writes: 1 } };

      await repo.addCreditsIdempotent(input(userId, { alsoUpdate }));
      await order.update({ writes: 7 });
      await repo.addCreditsIdempotent(input(userId, { alsoUpdate }));

      expect((await order.get()).data()).toEqual({ creditsGranted: true, writes: 7 });
    });

    it("a missing caller document rolls the credit back", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 5 });
      const alsoUpdate = {
        ref: db.collection("orders").doc(randomUUID()),
        data: { creditsGranted: true },
      };

      await expect(repo.addCreditsIdempotent(input(userId, { alsoUpdate }))).rejects.toThrow();

      expect((await stored(userId)).bonusCredits).toBe(0);
      expect((await getUserTransactionsCollection(db, userId).get()).size).toBe(0);
      expect((await getUserJournalCollection(db, userId).get()).size).toBe(0);
    });

    it("creates a missing account without free credits", async () => {
      const userId = newUser();
      await repoWith().addCreditsIdempotent(input(userId));

      expect(await stored(userId)).toMatchObject({ balance: 0, bonusCredits: 40 });
    });

    it("refuses a blank reference", async () => {
      await expect(
        repoWith().addCreditsIdempotent(input(newUser(), { paymentRef: "  " }))
      ).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
    });
  });

  describe("grantSubscriptionCycle", () => {
    const grant = (userId: string, overrides = {}) => ({
      userId,
      grantKey: `cycle/${userId}`,
      tier: "premium",
      credits: 500,
      subscriptionExpiresAt: new Date(PERIOD_END),
      monthlyResetAt: RESET_AT,
      description: "Subscription cycle: Premium (500 credits)",
      metadata: { planId: "premium-monthly" },
      ...overrides,
    });

    it("writes every field and journals from the snapshot it read", async () => {
      const userId = await seed({ tier: "free", balance: 3, bonusCredits: 10, monthlyLimit: 25 });

      const result = await repoWith().grantSubscriptionCycle(grant(userId));

      expect(result).toMatchObject({
        outcome: "granted",
        credits: { balance: 500, bonusCredits: 10, tier: "premium", monthlyUsed: 0 },
      });
      expect(await stored(userId)).toMatchObject({
        tier: "premium",
        balance: 500,
        bonusCredits: 10,
        reserved: 0,
        monthlyLimit: 500,
        monthlyUsed: 0,
        subscriptionExpiresAt: PERIOD_END,
        monthlyResetAt: RESET_AT,
      });
      const journal = await getUserJournalCollection(db, userId).get();
      expect(journal.size).toBe(1);
      expect(journal.docs[0].data()).toMatchObject({
        entryType: "credit",
        amount: 500,
        balanceAfter: 510,
        source: "subscription_grant",
        referenceId: `cycle/${userId}`,
        referenceType: "subscription",
        metadata: { planId: "premium-monthly", tier: "premium" },
      });
    });

    it("a retry does not restore credits already spent", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 3 });
      await repo.grantSubscriptionCycle(grant(userId));
      await repo.deductCreditsAtomic(userId, 200);

      const retry = await repo.grantSubscriptionCycle(grant(userId));

      expect(retry.outcome).toBe("replayed");
      expect((await stored(userId)).balance).toBe(300);
      expect((await getUserJournalCollection(db, userId).get()).size).toBe(1);
    });

    it("concurrent deliveries grant once", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 3 });

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => repo.grantSubscriptionCycle(grant(userId)))
      );

      expect(outcomes.filter((o) => o.outcome === "granted")).toHaveLength(1);
      expect((await getUserJournalCollection(db, userId).get()).size).toBe(1);
    });

    it("the same key with another amount or tier is a conflict", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 3 });
      await repo.grantSubscriptionCycle(grant(userId));

      expect(await repo.grantSubscriptionCycle(grant(userId, { credits: 600 }))).toMatchObject({
        outcome: "conflict",
        mismatch: "amount",
      });
      expect(await repo.grantSubscriptionCycle(grant(userId, { tier: "pro" }))).toMatchObject({
        outcome: "conflict",
        mismatch: "tier",
      });
      expect((await stored(userId)).balance).toBe(500);
    });

    it("updates the caller's document atomically, only when applied", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 3 });
      const guard = db.collection("provider_payments").doc(randomUUID());
      await guard.set({ creditsGranted: false });
      const alsoUpdate = { ref: guard, data: { creditsGranted: true } };

      await repo.grantSubscriptionCycle(grant(userId, { alsoUpdate }));

      expect((await guard.get()).data()).toEqual({ creditsGranted: true });
    });

    it("refuses a missing account and a blank key", async () => {
      await expect(
        repoWith().grantSubscriptionCycle(grant(newUser()))
      ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
      await expect(
        repoWith().grantSubscriptionCycle(grant(newUser(), { grantKey: " " }))
      ).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
    });

    it("clears marked credits, and keeps the floor when holds exceed the grant", async () => {
      const { repo, userId } = await expiredAccount();
      expect(await stored(userId)).toMatchObject({ balance: 80, expiredHoldBacking: 80 });

      await repo.grantSubscriptionCycle(grant(userId, { credits: 20, grantKey: "small" }));
      expect(await stored(userId)).toMatchObject({ balance: 80, expiredHoldBacking: 60 });

      await repo.grantSubscriptionCycle(grant(userId, { credits: 500, grantKey: "big" }));
      expect(await stored(userId)).toMatchObject({ balance: 500, expiredHoldBacking: 0 });
    });
  });

  describe("expired credits backing a hold", () => {
    it("a release leaves none of them spendable", async () => {
      const { repo, userId, reservationId } = await expiredAccount();
      expect(await stored(userId)).toMatchObject({
        balance: 80,
        reserved: 80,
        tier: "free",
        expiredHoldBacking: 80,
      });

      const released = await repo.releaseReservationV2(userId, reservationId);

      expect(released.outcome).toBe("released");
      expect(await stored(userId)).toMatchObject({
        balance: 0,
        reserved: 0,
        expiredHoldBacking: 0,
      });
      expect((await getUserJournalCollection(db, userId).doc(released.outcome === "released" ? released.journalEntryId : "").get()).data()).toMatchObject({
        amount: 0,
        balanceAfter: 0,
        metadata: { expiredCreditsRemoved: 80 },
      });
    });

    it("the legacy release removes them", async () => {
      const { repo, userId, reservationId } = await expiredAccount();
      await repo.releaseReservationAtomic(userId, reservationId);
      expect(await stored(userId)).toMatchObject({ balance: 0, reserved: 0, expiredHoldBacking: 0 });
    });

    it("the V2 expiry removes them", async () => {
      const { repo, userId, reservationId } = await expiredAccount();
      const outcome = await repo.expireReservationV2(userId, reservationId, {
        asOf: new Date(Date.now() + 120_000),
      });
      expect(outcome.outcome).toBe("expired");
      expect(await stored(userId)).toMatchObject({ balance: 0, reserved: 0, expiredHoldBacking: 0 });
    });

    it("the legacy expiry the cleanup sweep settles with removes them", async () => {
      const { userId, reservationId } = await expiredAccount();
      await ReservationAtomicOps.expireReservationAtomic(db, userId, reservationId);
      expect(await stored(userId)).toMatchObject({ balance: 0, reserved: 0, expiredHoldBacking: 0 });
    });

    it("the cleanup sweep removes them", async () => {
      const { repo, userId, reservationId } = await expiredAccount();
      await db
        .collection("users")
        .doc(userId)
        .collection("reservations")
        .doc(reservationId)
        .update({ expiresAt: new Date(Date.now() - DAY).toISOString() });

      await repo.findAndExpireReservations();

      expect(await stored(userId)).toMatchObject({ balance: 0, reserved: 0, expiredHoldBacking: 0 });
    });

    it("a commit consumes them and still succeeds", async () => {
      const { repo, userId, reservationId } = await expiredAccount();

      const outcome = await repo.commitReservationV2(userId, reservationId);

      expect(outcome.outcome).toBe("committed");
      expect(await stored(userId)).toMatchObject({ balance: 0, reserved: 0, expiredHoldBacking: 0 });
    });

    it("two holds settle in either way, and the cap survives", async () => {
      const repo = repoWith({ getDowngradeBalanceCap: () => 20 });
      const userId = await seed({ balance: 100 });
      const first = await hold(repo, userId, 50);
      const second = await hold(repo, userId, 30);
      await repo.checkAndHandleSubscriptionExpiry(userId, 3);
      expect(await stored(userId)).toMatchObject({ balance: 80, expiredHoldBacking: 60 });

      await repo.releaseReservationV2(userId, first);
      expect(await stored(userId)).toMatchObject({ balance: 30, expiredHoldBacking: 10 });

      await repo.releaseReservationV2(userId, second);
      expect(await stored(userId)).toMatchObject({ balance: 20, expiredHoldBacking: 0 });
    });

    it("bonus credits back holds first, so less is marked", async () => {
      const { repo, userId, reservationId } = await expiredAccount({
        balance: 100,
        held: 80,
        cap: 0,
        bonusCredits: 30,
      });
      expect(await stored(userId)).toMatchObject({ balance: 50, expiredHoldBacking: 50 });

      await repo.releaseReservationV2(userId, reservationId);

      expect(await stored(userId)).toMatchObject({ balance: 0, bonusCredits: 30, reserved: 0 });
    });

    it("balanceCap marks them too", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 100 });
      const reservationId = await hold(repo, userId, 80);

      await repo.updateUserTier(userId, { tier: "free", monthlyLimit: 0, balanceCap: 0 });
      expect(await stored(userId)).toMatchObject({ balance: 80, expiredHoldBacking: 80 });

      await repo.releaseReservationV2(userId, reservationId);
      expect((await stored(userId)).balance).toBe(0);
    });

    it("a document lacking the field behaves as 0 and stays without it", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 100 });
      const reservationId = await hold(repo, userId, 80);

      await repo.releaseReservationV2(userId, reservationId);

      const data = await stored(userId);
      expect(data).toMatchObject({ balance: 100, reserved: 0 });
      expect(data.expiredHoldBacking).toBeUndefined();
    });

    it("a bonus purchase does not revive them", async () => {
      const { repo, userId, reservationId } = await expiredAccount();
      await repo.addCreditsIdempotent({
        userId,
        amount: 5,
        description: "Purchase",
        paymentRef: "small",
      });

      await repo.releaseReservationV2(userId, reservationId);

      expect(await stored(userId)).toMatchObject({ balance: 0, bonusCredits: 5 });
    });

    it("a reset resolver sees spendable credits, and keeping them keeps the mark", async () => {
      const seen: number[] = [];
      const repo = repoWith({
        getDowngradeBalanceCap: () => 20,
        resolveMonthlyReset: ({ balance }) => {
          seen.push(balance);
          return { balance };
        },
      });
      const userId = await seed({ balance: 100 });
      const reservationId = await hold(repo, userId, 80);
      await repo.checkAndHandleSubscriptionExpiry(userId, 3);
      const expected = (await stored(userId)).monthlyResetAt;

      const reset = await repo.atomicMonthlyReset(userId, "free", expected);

      expect(reset.wasReset).toBe(true);
      expect(seen[seen.length - 1]).toBe(20);
      expect(await stored(userId)).toMatchObject({ balance: 80, expiredHoldBacking: 60 });

      await repo.releaseReservationV2(userId, reservationId);
      expect((await stored(userId)).balance).toBe(20);
    });

    it("an absolute updateUserCredits balance clears the mark", async () => {
      const { repo, userId, reservationId } = await expiredAccount();
      await repo.updateUserCredits(userId, { balance: 200 });

      await repo.releaseReservationV2(userId, reservationId);

      expect(await stored(userId)).toMatchObject({ balance: 200, expiredHoldBacking: 0 });
    });

    it("an admin deduct lands on valid credits and survives the release", async () => {
      const { repo, userId, reservationId } = await expiredAccount({
        balance: 100,
        held: 80,
        cap: 0,
        bonusCredits: 50,
      });
      expect(await stored(userId)).toMatchObject({ balance: 30, expiredHoldBacking: 30 });
      await repo.addCreditsAtomic(userId, 40, "bonus");
      await repo.deductCreditsAtomic(userId, 20);
      expect(await stored(userId)).toMatchObject({
        balance: 30,
        bonusCredits: 70,
        expiredHoldBacking: 30,
      });

      await repo.releaseReservationV2(userId, reservationId);

      expect(await stored(userId)).toMatchObject({
        balance: 0,
        bonusCredits: 70,
        expiredHoldBacking: 0,
      });
    });

    const shareOf = async (userId: string, reservationId: string) => {
      const row = await getUserReservationsCollection(db, userId).doc(reservationId).get();
      const { expiredBackingFrontier } = await stored(userId);
      return holdExpiredBacking(
        { id: row.id, amount: row.get("amount"), holdPlacedAt: row.get("holdPlacedAt") },
        expiredBackingFrontier
      );
    };

    it("a new hold carries no share, and the old hold's share is on the account", async () => {
      const { repo, userId, reservationId } = await expiredAccount();
      await repo.addCreditsAtomic(userId, 100, "bonus");
      const later = await hold(repo, userId, 10);

      expect(await shareOf(userId, reservationId)).toBe(80);
      expect(await shareOf(userId, later)).toBe(0);
      expect((await stored(userId)).expiredBackingFrontier).toMatchObject({
        id: reservationId,
        share: 80,
      });
    });

    it("a later hold whose clock runs behind still takes no share", async () => {
      const { repo, userId, reservationId } = await expiredAccount();
      await repo.addCreditsAtomic(userId, 100, "bonus");
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - DAY });
      const later = await hold(repo, userId, 10).finally(() => vi.useRealTimers());
      expect(await shareOf(userId, later)).toBe(0);

      await repo.releaseReservationV2(userId, later);
      expect(await stored(userId)).toMatchObject({ balance: 80, expiredHoldBacking: 80 });
      await repo.commitReservationV2(userId, reservationId);

      expect(await stored(userId)).toMatchObject({
        balance: 0,
        bonusCredits: 100,
        expiredHoldBacking: 0,
      });
    });

    describe("shares follow every balance write, from the account alone", () => {
      it("the expiry downgrade", async () => {
        const { userId, reservationId } = await expiredAccount();
        expect(await shareOf(userId, reservationId)).toBe(80);
      });

      it("updateUserTier with a balance", async () => {
        const { repo, userId, reservationId } = await expiredAccount();
        await repo.updateUserTier(userId, { tier: "free", monthlyLimit: 25, balance: 30 });
        expect(await stored(userId)).toMatchObject({ balance: 80, expiredHoldBacking: 50 });
        expect(await shareOf(userId, reservationId)).toBe(50);
      });

      it("updateUserTier with a cap", async () => {
        const repo = repoWith();
        const userId = await seed({ balance: 100 });
        const reservationId = await hold(repo, userId, 40);
        await repo.updateUserTier(userId, { tier: "premium", monthlyLimit: 25, balanceCap: 10 });
        expect(await shareOf(userId, reservationId)).toBe(30);
      });

      it("a monthly reset", async () => {
        const { userId, reservationId } = await expiredAccount();
        const repo = repoWith({ resolveMonthlyReset: () => ({ balance: 15 }) });
        const expected = new Date(Date.now() - DAY).toISOString();
        await balanceRef(userId).update({ monthlyResetAt: expected });
        await repo.atomicMonthlyReset(userId, "free", expected);
        expect(await shareOf(userId, reservationId)).toBe(65);
      });

      it("an absolute balance", async () => {
        const { repo, userId, reservationId } = await expiredAccount();
        await repo.updateUserCredits(userId, { balance: 80 });
        expect(await stored(userId)).toMatchObject({ expiredHoldBacking: 0 });
        expect(await shareOf(userId, reservationId)).toBe(0);
      });

      it("not a negative increment, which is refused", async () => {
        const { repo, userId, reservationId } = await expiredAccount();
        await expect(
          repo.updateUserCredits(userId, { bonusCredits: 100, balanceIncrement: -30 })
        ).rejects.toThrow("expired hold backing");
        expect(await stored(userId)).toMatchObject({ balance: 80, expiredHoldBacking: 80 });
        expect(await shareOf(userId, reservationId)).toBe(80);
      });
    });

    it("a document without the new fields closes holds and gains none", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 100 });
      const reservationId = await hold(repo, userId, 40);

      await repo.commitReservationV2(userId, reservationId);

      const data = await stored(userId);
      expect(data).toMatchObject({ balance: 60, reserved: 0 });
      expect(data).not.toHaveProperty("expiredHoldBacking");
      expect(data).not.toHaveProperty("expiredBackingFrontier");
    });

    it("grantSubscriptionCycle moves the shares with the balance", async () => {
      const { repo, userId, reservationId } = await expiredAccount();
      await repo.grantSubscriptionCycle({
        userId,
        grantKey: `cycle-${randomUUID()}`,
        tier: "premium",
        credits: 10,
        subscriptionExpiresAt: PERIOD_END,
        monthlyResetAt: RESET_AT,
        description: "renewal",
      });
      expect(await stored(userId)).toMatchObject({ balance: 80, expiredHoldBacking: 70 });
      expect(await shareOf(userId, reservationId)).toBe(70);

      await repo.releaseReservationV2(userId, reservationId);

      expect(await stored(userId)).toMatchObject({ balance: 10, expiredHoldBacking: 0 });
    });
  });

  describe("seedMissingAccounts", () => {
    const strict = () => repoWith({ seedMissingAccounts: false });
    const expiresAt = () => new Date(Date.now() + 60_000);
    const credit = (userId: string, overrides = {}) => ({
      userId,
      amount: 40,
      description: "Purchase",
      paymentRef: "pay-1",
      ...overrides,
    });

    /** Nothing at all under the user: balance, rows, holds, keys or journal. */
    async function expectNothingWritten(userId: string) {
      expect((await balanceRef(userId).get()).exists).toBe(false);
      const user = db.collection("users").doc(userId);
      for (const name of ["transactions", "reservations", "reservation-keys", "credits"]) {
        expect((await user.collection(name).get()).size).toBe(0);
      }
      expect((await getUserJournalCollection(db, userId).get()).size).toBe(0);
    }

    describe("false", () => {
      const notFound = { code: "USER_NOT_FOUND" };

      it("addCreditsAtomic throws and writes nothing", async () => {
        const userId = newUser();
        await expect(strict().addCreditsAtomic(userId, 40, "bonus")).rejects.toMatchObject(notFound);
        await expect(strict().addCreditsAtomic(userId, 40, "paid", "ref")).rejects.toMatchObject(
          notFound
        );
        await expectNothingWritten(userId);
      });

      it("addCreditsIdempotent throws, writes nothing, and a retry lands", async () => {
        const repo = strict();
        const userId = newUser();
        const order = db.collection("orders").doc(randomUUID());
        await order.set({ creditsGranted: false });
        const input = credit(userId, {
          alsoUpdate: { ref: order, data: { creditsGranted: true } },
        });

        await expect(repo.addCreditsIdempotent(input)).rejects.toMatchObject(notFound);
        await expectNothingWritten(userId);
        expect((await order.get()).data()).toEqual({ creditsGranted: false });

        await repo.initializeUserCredits(userId, "free", 0);
        expect((await repo.addCreditsIdempotent(input)).outcome).toBe("created");
        expect(await stored(userId)).toMatchObject({ balance: 0, bonusCredits: 40 });
        expect((await order.get()).data()).toEqual({ creditsGranted: true });
      });

      it("reserveCreditsV2 throws and writes nothing, with or without a key", async () => {
        const userId = newUser();
        const reserve = { userId, amount: 5, operationType: "audio_generation", expiresAt: expiresAt() };

        await expect(strict().reserveCreditsV2(reserve)).rejects.toMatchObject(notFound);
        await expect(
          strict().reserveCreditsV2({ ...reserve, idempotencyKey: "k1" })
        ).rejects.toMatchObject(notFound);
        await expectNothingWritten(userId);
      });

      it("reserveCreditsAtomic throws and writes nothing", async () => {
        const userId = newUser();
        await expect(
          strict().reserveCreditsAtomic(userId, 5, "audio_generation", expiresAt())
        ).rejects.toMatchObject(notFound);
        await expectNothingWritten(userId);
      });

      it("every path works once the account exists", async () => {
        const repo = strict();
        const userId = newUser();
        await repo.initializeUserCredits(userId, "free", 25);

        await repo.addCreditsAtomic(userId, 10, "bonus");
        await repo.addCreditsIdempotent(credit(userId));
        await repo.reserveCreditsAtomic(userId, 5, "audio_generation", expiresAt());
        await hold(repo, userId, 5);

        expect(await stored(userId)).toMatchObject({ balance: 25, bonusCredits: 50, reserved: 10 });
      });

      it("a replay succeeds with the account gone and does not recreate it", async () => {
        const repo = strict();
        const userId = newUser();
        await repo.initializeUserCredits(userId, "free", 0);
        await repo.addCreditsIdempotent(credit(userId));
        await balanceRef(userId).delete();

        expect((await repo.addCreditsIdempotent(credit(userId))).outcome).toBe("replayed");
        expect((await balanceRef(userId).get()).exists).toBe(false);
      });
    });

    describe.each([
      ["default", () => repoWith()],
      ["true", () => repoWith({ seedMissingAccounts: true })],
    ])("%s", (_mode, repo) => {
      it("addCreditsAtomic seeds the default free credits", async () => {
        const userId = newUser();
        await repo().addCreditsAtomic(userId, 40, "bonus");
        expect(await stored(userId)).toMatchObject({ balance: 25, bonusCredits: 40 });
      });

      it("reserveCreditsV2 seeds the default free credits", async () => {
        const userId = newUser();
        await hold(repo(), userId, 5);
        expect(await stored(userId)).toMatchObject({ balance: 25, reserved: 5 });
      });

      it("reserveCreditsAtomic seeds the default free credits", async () => {
        const userId = newUser();
        await repo().reserveCreditsAtomic(userId, 5, "audio_generation", expiresAt());
        expect(await stored(userId)).toMatchObject({ balance: 25, reserved: 5 });
      });

      it("addCreditsIdempotent creates the account with no free credits", async () => {
        const userId = newUser();
        await repo().addCreditsIdempotent(credit(userId));
        expect(await stored(userId)).toMatchObject({ balance: 0, bonusCredits: 40 });
      });
    });
  });

  describe("hold floors", () => {
    it("the legacy reset does not cut through a hold", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 100, monthlyLimit: 25, tier: "free" });
      const reservationId = await hold(repo, userId, 80);
      const expected = (await stored(userId)).monthlyResetAt;

      await repo.atomicMonthlyReset(userId, "free", expected);
      expect(await stored(userId)).toMatchObject({ balance: 80, expiredHoldBacking: 55 });

      expect((await repo.commitReservationV2(userId, reservationId)).outcome).toBe("committed");
    });

    it("the legacy reset without holds writes the limit and no field", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 100, monthlyLimit: 25, tier: "free" });

      await repo.atomicMonthlyReset(userId, "free", (await stored(userId)).monthlyResetAt);

      const data = await stored(userId);
      expect(data.balance).toBe(25);
      expect(data.expiredHoldBacking).toBeUndefined();
    });

    it("the default downgrade does not cut through a hold", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 100 });
      const reservationId = await hold(repo, userId, 80);

      await repo.checkAndHandleSubscriptionExpiry(userId, 3);
      expect(await stored(userId)).toMatchObject({ balance: 80, expiredHoldBacking: 55 });

      expect((await repo.commitReservationV2(userId, reservationId)).outcome).toBe("committed");
    });

    it("the default downgrade without holds still caps at the default", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 100 });

      await repo.checkAndHandleSubscriptionExpiry(userId, 3);

      const data = await stored(userId);
      expect(data).toMatchObject({ balance: 25, monthlyLimit: 25, tier: "free" });
      expect(data.expiredHoldBacking).toBeUndefined();
    });

    it("updateUserTier with balance does not cut through a hold", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 100 });
      const reservationId = await hold(repo, userId, 80);

      await repo.updateUserTier(userId, { tier: "free", monthlyLimit: 25, balance: 25 });
      expect(await stored(userId)).toMatchObject({ balance: 80, expiredHoldBacking: 55 });

      await repo.releaseReservationV2(userId, reservationId);
      expect((await stored(userId)).balance).toBe(25);
    });
  });
});
