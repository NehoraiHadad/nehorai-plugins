/**
 * The depth of the ledger against a real Firestore: bad stored values, accounts written
 * by 2.2.0 and earlier, the transaction size of a close, and the journal of each step.
 *
 * Run with `pnpm test:emulator`. `CREDITS_SCALE_HOLDS` sets how many holds the scale
 * test places. Skipped when FIRESTORE_EMULATOR_HOST is unset.
 */
import { randomUUID } from "node:crypto";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CreditErrorCode, holdExpiredBacking } from "@nehorai/credits";
import {
  BALANCE_DOC_ID,
  FirestoreCreditRepository,
  getUserCreditsCollection,
  getUserReservationsCollection,
  type FirestoreRepositoryOptions,
} from "../src";
import { getUserJournalCollection } from "../src/repository/journal.js";
import { retryEmulatorClosedTransactions } from "./emulator-transactions.js";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const DAY = 86_400_000;
const SCALE_HOLDS = Number(process.env.CREDITS_SCALE_HOLDS ?? 2_000);

describe.skipIf(!emulator)("Firestore ledger depth (emulator)", { timeout: 60_000 }, () => {
  let app: App;
  let db: Firestore;

  beforeAll(() => {
    app = initializeApp({ projectId: "credits-firestore-test" }, `depth-${randomUUID()}`);
    db = retryEmulatorClosedTransactions(getFirestore(app));
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const balanceRef = (userId: string) => getUserCreditsCollection(db, userId).doc(BALANCE_DOC_ID);
  const holds = (userId: string) => getUserReservationsCollection(db, userId);
  const repoWith = (options: FirestoreRepositoryOptions = {}) =>
    new FirestoreCreditRepository(db, options);
  const stored = async (userId: string) =>
    (await balanceRef(userId).get()).data() as Record<string, any>;
  const journal = async (userId: string) => {
    const snapshot = await getUserJournalCollection(db, userId).get();
    return snapshot.docs.map((doc) => doc.data());
  };

  async function seed(fields: Record<string, unknown>): Promise<string> {
    const userId = `user-${randomUUID()}`;
    await balanceRef(userId).set({
      userId,
      balance: 0,
      bonusCredits: 0,
      reserved: 0,
      tier: "premium",
      monthlyLimit: 500,
      monthlyUsed: 0,
      monthlyResetAt: new Date(Date.now() - DAY).toISOString(),
      subscriptionExpiresAt: null,
      ...fields,
    });
    return userId;
  }

  async function hold(repo: FirestoreCreditRepository, userId: string, amount: number) {
    const made = await repo.reserveCreditsV2({
      userId,
      amount,
      operationType: "story_generation",
      expiresAt: new Date(Date.now() + 60_000),
    });
    if (made.outcome !== "created") throw new Error(`no hold: ${made.outcome}`);
    return made.reservation.id;
  }

  const share = async (repo: FirestoreCreditRepository, userId: string, id: string) => {
    const credits = await repo.getUserCredits(userId);
    const reservation = await repo.getReservation(userId, id);
    return holdExpiredBacking(reservation!, credits!.expiredBackingFrontier);
  };

  describe("the marked total stays within the balance", () => {
    it("a stored negative value mints nothing across holds, and the first write repairs it", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 20, expiredHoldBacking: -10 });

      for (let cycle = 0; cycle < 3; cycle += 1) {
        await repo.releaseReservationV2(userId, await hold(repo, userId, 10));
        expect(await stored(userId)).toMatchObject({ balance: 20, reserved: 0 });
      }
      expect((await stored(userId)).expiredHoldBacking).toBe(0);
    });

    it("a stored negative value does not read as spendable", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 20, expiredHoldBacking: -10 });

      await expect(repo.deductCreditsAtomic(userId, 25)).rejects.toThrow("Insufficient");
      await repo.deductCreditsAtomic(userId, 20);
      expect(await stored(userId)).toMatchObject({ balance: 0, expiredHoldBacking: 0 });
    });

    it("a reset decides on the balance, not on the balance plus a negative mark", async () => {
      const seen: number[] = [];
      const repo = repoWith({
        resolveMonthlyReset: ({ balance }) => {
          seen.push(balance);
          return { balance: Math.max(balance, 10) };
        },
      });
      const expected = new Date(Date.now() - DAY).toISOString();
      const userId = await seed({
        balance: 20,
        expiredHoldBacking: -10,
        monthlyResetAt: expected,
      });

      await repo.atomicMonthlyReset(userId, "premium", expected);

      expect(seen.at(-1)).toBe(20);
      expect(await stored(userId)).toMatchObject({ balance: 20, expiredHoldBacking: 0 });
    });

    it("a stored value above the balance closes for no more than the balance", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 50, bonusCredits: 100 });
      const id = await hold(repo, userId, 40);
      await balanceRef(userId).update({ expiredHoldBacking: 90 });

      await repo.releaseReservationV2(userId, id);

      const after = await stored(userId);
      expect(after.balance).toBe(10);
      expect(after.expiredHoldBacking).toBe(0);
    });

    it("the increment and the tier write that would break it are refused", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 100 });
      await hold(repo, userId, 80);
      await repo.updateUserTier(userId, { tier: "premium", monthlyLimit: 500, balanceCap: 0 });
      await repo.updateUserCredits(userId, { bonusCreditsIncrement: 100 });
      const before = await stored(userId);
      expect(before).toMatchObject({ balance: 80, expiredHoldBacking: 80 });

      await expect(repo.updateUserCredits(userId, { balanceIncrement: -90 })).rejects.toThrow(
        "Balance cannot be negative"
      );
      await expect(
        repo.updateUserTier(userId, { tier: "premium", monthlyLimit: 500, balance: -10 })
      ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });

      const after = await stored(userId);
      expect([after.balance, after.expiredHoldBacking]).toEqual([80, 80]);
    });
  });

  describe("an account written before the frontier", () => {
    async function legacyAccount(repo: FirestoreCreditRepository) {
      const userId = await seed({ balance: 80, bonusCredits: 100 });
      const a = await hold(repo, userId, 50);
      const b = await hold(repo, userId, 30);
      await balanceRef(userId).update({ expiredHoldBacking: 60 });
      return { userId, a, b };
    }

    it("a new hold from a lagging clock takes none of the old backing", async () => {
      const repo = repoWith();
      const { userId, a, b } = await legacyAccount(repo);

      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 5_000 });
      const lagged = await hold(repo, userId, 10);
      vi.useRealTimers();

      const placed = await holds(userId).doc(b).get();
      const row = await holds(userId).doc(lagged).get();
      expect(row.get("holdPlacedAt") > placed.get("holdPlacedAt")).toBe(true);
      expect((await stored(userId)).expiredBackingFrontier).toMatchObject({ id: b, share: 10 });
      expect(await share(repo, userId, a)).toBe(50);
      expect(await share(repo, userId, b)).toBe(10);
      expect(await share(repo, userId, lagged)).toBe(0);

      await repo.commitReservationV2(userId, lagged);
      await repo.releaseReservationV2(userId, a);
      await repo.releaseReservationV2(userId, b);

      // 20 was spendable, so the commit paid from the balance, as `planHoldCommit` orders.
      expect(await stored(userId)).toMatchObject({
        balance: 10,
        bonusCredits: 100,
        reserved: 0,
        expiredHoldBacking: 0,
      });
    });

    it("a close converts the account, with no write to another hold", async () => {
      const repo = repoWith();
      const { userId, a, b } = await legacyAccount(repo);
      const other = await holds(userId).doc(b).get();

      await repo.commitReservationV2(userId, a);

      expect((await stored(userId)).expiredBackingFrontier).toMatchObject({ id: b, share: 10 });
      const after = await holds(userId).doc(b).get();
      expect(after.updateTime?.isEqual(other.updateTime!)).toBe(true);
    });

    it("shares a 2.2.0 hold document stored are ignored, and its total is kept", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 80, bonusCredits: 100 });
      const a = await hold(repo, userId, 50);
      const b = await hold(repo, userId, 30);
      await holds(userId).doc(a).update({ expiredBacking: 50 });
      await holds(userId).doc(b).update({ expiredBacking: 10 });
      await balanceRef(userId).update({ expiredHoldBacking: 60 });

      await repo.releaseReservationV2(userId, b);
      expect(await stored(userId)).toMatchObject({ balance: 70, expiredHoldBacking: 50 });
      await repo.releaseReservationV2(userId, a);
      expect(await stored(userId)).toMatchObject({ balance: 20, expiredHoldBacking: 0 });
    });
  });

  describe("a transaction never scales with the holds it does not close", () => {
    async function openHolds(userId: string, count: number, amount: number) {
      const writer = db.bulkWriter();
      const placedAt = Date.now() - DAY;
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const ref = holds(userId).doc();
        ids.push(ref.id);
        void writer.create(ref, {
          userId,
          amount,
          operationType: "story_generation",
          status: "reserved",
          createdAt: new Date(placedAt + index).toISOString(),
          // Not due, or the other suites' cleanup sweeps would walk them on this emulator.
          expiresAt: new Date(Date.now() + DAY).toISOString(),
          holdPlacedAt: new Date(placedAt + index).toISOString(),
        });
      }
      await writer.close();
      return ids;
    }

    it("a lowering write and a close leave every other hold document untouched", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 50, reserved: 50 });
      const ids = await openHolds(userId, 50, 1);
      const before = await holds(userId).get();

      await repo.updateUserTier(userId, { tier: "premium", monthlyLimit: 500, balanceCap: 0 });
      expect(await stored(userId)).toMatchObject({ balance: 50, expiredHoldBacking: 50 });
      expect((await stored(userId)).expiredBackingFrontier).toMatchObject({
        id: ids[49],
        share: 1,
      });
      await repo.releaseReservationV2(userId, ids[0]!);

      const after = await holds(userId).get();
      for (const doc of before.docs) {
        if (doc.id === ids[0]) continue;
        const now = after.docs.find((candidate) => candidate.id === doc.id);
        expect(now?.updateTime.isEqual(doc.updateTime)).toBe(true);
        expect(now?.get("expiredBacking")).toBeUndefined();
      }
      expect(await stored(userId)).toMatchObject({ balance: 49, expiredHoldBacking: 49 });
    });

    it(
      `an account with ${SCALE_HOLDS} holds can cap, commit, release, expire and top up`,
      async () => {
        const repo = repoWith();
        const total = SCALE_HOLDS / 100;
        const userId = await seed({ balance: total, reserved: total });
        const ids = await openHolds(userId, SCALE_HOLDS, 0.01);

        const timed = async <T>(label: string, step: () => Promise<T>) => {
          const started = performance.now();
          const result = await step();
          console.info(`[scale ${SCALE_HOLDS}] ${label}: ${Math.round(performance.now() - started)}ms`);
          return result;
        };

        await timed("cap", () =>
          repo.updateUserTier(userId, { tier: "premium", monthlyLimit: 500, balanceCap: 0 })
        );
        expect((await stored(userId)).expiredHoldBacking).toBe(total);

        await timed("commit", () => repo.commitReservationV2(userId, ids[0]!));
        await timed("release", () => repo.releaseReservationV2(userId, ids[1]!));
        await timed("expire", () =>
          repo.expireReservationV2(userId, ids[2]!, { asOf: new Date(Date.now() + 2 * DAY) })
        );
        await timed("top up", () => repo.addCreditsAtomic(userId, 5, "bonus"));
        await timed("new hold", () => hold(repo, userId, 0.5));

        const after = await stored(userId);
        expect(after.balance).toBeCloseTo(total - 0.03, 2);
        expect(after.expiredHoldBacking).toBeCloseTo(total - 0.03, 2);
      },
      Math.max(60_000, SCALE_HOLDS * 20)
    );
  });

  describe("the journal is written with the step it records", () => {
    it("a reset, in its transaction, with before and after", async () => {
      const repo = repoWith({ resolveMonthlyReset: () => ({ balance: 10 }) });
      const expected = new Date(Date.now() - DAY).toISOString();
      const userId = await seed({ balance: 30, bonusCredits: 5, monthlyResetAt: expected });

      const result = await repo.atomicMonthlyReset(userId, "premium", expected);

      expect(result).toMatchObject({ wasReset: true, journaled: true });
      expect(await journal(userId)).toEqual([
        expect.objectContaining({
          entryType: "debit",
          amount: 20,
          balanceBefore: 35,
          balanceAfter: 15,
          source: "monthly_reset",
        }),
      ]);
    });

    it("a reset that moved nothing writes no line", async () => {
      const repo = repoWith({ resolveMonthlyReset: ({ balance }) => ({ balance }) });
      const expected = new Date(Date.now() - DAY).toISOString();
      const userId = await seed({ balance: 30, monthlyResetAt: expected });

      await repo.atomicMonthlyReset(userId, "premium", expected);

      expect(await journal(userId)).toEqual([]);
    });

    it("a downgrade, in its transaction, with before and after", async () => {
      const repo = repoWith({ getDowngradeBalanceCap: () => 5 });
      const userId = await seed({
        balance: 30,
        bonusCredits: 5,
        subscriptionExpiresAt: new Date(Date.now() - 400 * DAY).toISOString(),
      });

      const result = await repo.checkAndHandleSubscriptionExpiry(userId);

      expect(result).toMatchObject({ wasDowngraded: true, journaled: true });
      expect(await journal(userId)).toEqual([
        expect.objectContaining({
          amount: 0,
          balanceBefore: 35,
          balanceAfter: 10,
          source: "subscription_downgrade",
        }),
      ]);
    });

    it("a credit, in its transaction, with the caller's journal options", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 10, bonusCredits: 5 });

      await repo.addCreditsAtomic(userId, 20, "gift", undefined, {
        source: "bonus",
        referenceType: "adjustment",
        metadata: { reason: "support" },
      });

      expect(await journal(userId)).toEqual([
        expect.objectContaining({
          entryType: "credit",
          amount: 20,
          balanceBefore: 15,
          balanceAfter: 35,
          source: "bonus",
          referenceType: "adjustment",
          metadata: { reason: "support" },
        }),
      ]);
    });

    it("a deduct, in its transaction, or not at all when it is refused", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 10, bonusCredits: 5 });
      const line = { referenceId: "req-1", description: "Admin deduct" };

      await expect(repo.deductCreditsAtomic(userId, 50, line)).rejects.toThrow("Insufficient");
      expect(await journal(userId)).toEqual([]);

      const result = await repo.deductCreditsAtomic(userId, 12, line);

      expect(result).toEqual({
        previousBalance: 15,
        newBalance: 3,
        journalEntryId: expect.any(String),
      });
      expect(await journal(userId)).toEqual([
        expect.objectContaining({
          entryType: "debit",
          amount: 12,
          balanceBefore: 15,
          balanceAfter: 3,
          referenceId: "req-1",
        }),
      ]);
    });

    it("the transitions of a hold carry before and after", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 30, bonusCredits: 5 });

      await repo.commitReservationV2(userId, await hold(repo, userId, 10));
      await repo.releaseReservationV2(userId, await hold(repo, userId, 10));

      const lines = await journal(userId);
      expect(lines).toHaveLength(2);
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "operation_commit", balanceBefore: 35, balanceAfter: 25 }),
          expect.objectContaining({ source: "operation_release", balanceBefore: 25, balanceAfter: 25 }),
        ])
      );
    });
  });

  describe("amounts are whole cents on every path", () => {
    it("refuses a fractional cent on the paths that took one", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 30 });
      const invalid = { code: CreditErrorCode.INVALID_AMOUNT };

      await expect(repo.addCreditsAtomic(userId, 0.001, "dust")).rejects.toMatchObject(invalid);
      await expect(repo.deductCreditsAtomic(userId, 0.001)).rejects.toMatchObject(invalid);
      await expect(
        repo.updateUserCredits(userId, { bonusCredits: 0.001 })
      ).rejects.toMatchObject(invalid);
      await expect(
        repo.initializeUserCredits(`user-${randomUUID()}`, "free", 0.001)
      ).rejects.toMatchObject(invalid);

      expect(await stored(userId)).toMatchObject({ balance: 30, bonusCredits: 0 });
    });

    it("a stored fractional cent does not lock a hold and mints nothing", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 24.999, bonusCredits: 0.001 });

      await repo.commitReservationV2(userId, await hold(repo, userId, 10));
      const id = await hold(repo, userId, 5);
      await repo.releaseReservationV2(userId, id);

      expect(await stored(userId)).toMatchObject({ balance: 14.99, reserved: 0 });
      expect((await repo.getUserCredits(userId))?.bonusCredits).toBe(0);
    });

    it("stored float noise reads as the cent it landed next to", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 1.1 * 3, bonusCredits: 0.1 + 0.2 });

      expect(await repo.getUserCredits(userId)).toMatchObject({
        balance: 3.3,
        bonusCredits: 0.3,
      });
      await repo.commitReservationV2(userId, await hold(repo, userId, 1.1));

      expect(await stored(userId)).toMatchObject({ balance: 2.2, bonusCredits: 0.3 });
    });

    it("a raw float difference in a journal line is taken back to the cent", async () => {
      const repo = repoWith();
      const userId = await seed({ balance: 1 });

      const entry = await repo.createJournalEntry({
        userId,
        entryType: "debit",
        amount: 1.1,
        balanceAfter: 1.1 * 3,
        source: "operation_commit",
        referenceId: "r",
        referenceType: "adjustment",
        description: "d",
      });

      expect(entry.balanceAfter).toBe(3.3);
      await expect(
        repo.createJournalEntry({
          userId,
          entryType: "debit",
          amount: 0.005,
          balanceAfter: 1,
          source: "operation_commit",
          referenceId: "r",
          referenceType: "adjustment",
          description: "d",
        })
      ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });
    });
  });
});
