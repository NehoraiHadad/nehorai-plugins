/**
 * The free-tier policy hooks and the atomic tier write against a real Firestore
 * (the emulator): real transaction contention, and the document's `updateTime`
 * as independent proof of whether a write happened.
 *
 * Run with `pnpm test:emulator` (needs Java for the emulator). Skipped when
 * FIRESTORE_EMULATOR_HOST is unset, so `pnpm test` stays hermetic.
 */
import { randomUUID } from "node:crypto";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreditsService } from "@nehorai/credits";
import {
  BALANCE_DOC_ID,
  FirestoreCreditRepository,
  getUserCreditsCollection,
  type FirestoreRepositoryOptions,
} from "../src";
import { getUserJournalCollection } from "../src/repository/journal.js";
import { retryEmulatorClosedTransactions } from "./emulator-transactions.js";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const DAY = 86_400_000;
const pastDue = () => new Date(Date.now() - DAY).toISOString();

describe.skipIf(!emulator)("Firestore free-tier policy (emulator)", { timeout: 30_000 }, () => {
  let app: App;
  let db: Firestore;

  beforeAll(() => {
    app = initializeApp({ projectId: "credits-firestore-test" }, `grants-${randomUUID()}`);
    db = retryEmulatorClosedTransactions(getFirestore(app));
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  const balanceRef = (userId: string) => getUserCreditsCollection(db, userId).doc(BALANCE_DOC_ID);
  const repoWith = (options: FirestoreRepositoryOptions = {}) =>
    new FirestoreCreditRepository(db, options);

  async function seed(fields: Record<string, unknown>): Promise<string> {
    const userId = `user-${randomUUID()}`;
    await balanceRef(userId).set({
      userId,
      balance: 0,
      bonusCredits: 0,
      reserved: 0,
      tier: "free",
      monthlyLimit: 25,
      monthlyUsed: 2,
      monthlyResetAt: pastDue(),
      subscriptionExpiresAt: null,
      ...fields,
    });
    return userId;
  }

  async function stored(userId: string) {
    return (await balanceRef(userId).get()).data() as Record<string, any>;
  }

  it("a free account keeps its limit when the argument names the paid tier", async () => {
    const userId = await seed({ balance: 25 });
    const expected = (await stored(userId)).monthlyResetAt;
    const repo = repoWith({ getMonthlyLimit: (tier) => (tier === "free" ? 25 : 500) });

    const result = await repo.atomicMonthlyReset(userId, "premium", expected);

    expect(result.wasReset).toBe(true);
    expect((await stored(userId)).balance).toBe(25);
    expect((await stored(userId)).tier).toBe("free");
  });

  it("resolver null performs no write at all", async () => {
    const userId = await seed({ balance: 7 });
    const before = await balanceRef(userId).get();
    const repo = repoWith({ resolveMonthlyReset: () => null });

    const result = await repo.atomicMonthlyReset(userId, "free", before.data()!.monthlyResetAt);

    const after = await balanceRef(userId).get();
    expect(result.wasReset).toBe(false);
    expect(after.updateTime!.isEqual(before.updateTime!)).toBe(true);
    expect(after.data()).toEqual(before.data());
  });

  it("a resolver result writes the balance, and monthlyLimit only when returned", async () => {
    const without = await seed({ balance: 7, bonusCredits: 4 });
    await repoWith({ resolveMonthlyReset: () => ({ balance: 40 }) }).atomicMonthlyReset(
      without,
      "free",
      (await stored(without)).monthlyResetAt
    );
    const first = await stored(without);
    expect(first.balance).toBe(40);
    expect(first.monthlyLimit).toBe(25);
    expect(first.monthlyUsed).toBe(0);
    expect(first.bonusCredits).toBe(4);
    expect(new Date(first.monthlyResetAt).getTime()).toBeGreaterThan(Date.now());

    const withLimit = await seed({ balance: 7 });
    await repoWith({
      resolveMonthlyReset: () => ({ balance: 7, monthlyLimit: 0 }),
    }).atomicMonthlyReset(withLimit, "free", (await stored(withLimit)).monthlyResetAt);
    expect((await stored(withLimit)).monthlyLimit).toBe(0);
  });

  it("a resolver throw aborts without a retry or a write", async () => {
    const userId = await seed({ balance: 7 });
    const before = await balanceRef(userId).get();
    let calls = 0;
    const repo = repoWith({
      resolveMonthlyReset: () => {
        calls++;
        throw new Error("no settings");
      },
    });

    await expect(
      repo.atomicMonthlyReset(userId, "free", before.data()!.monthlyResetAt)
    ).rejects.toThrow("no settings");

    expect(calls).toBe(1);
    const after = await balanceRef(userId).get();
    expect(after.updateTime!.isEqual(before.updateTime!)).toBe(true);
  });

  it("concurrent resets through the service apply the resolver once", async () => {
    const userId = await seed({ balance: 3 });
    const service = new CreditsService(
      repoWith({
        resolveMonthlyReset: ({ balance }) => ({ balance: Math.max(balance, 10) }),
      })
    );

    await Promise.all(Array.from({ length: 4 }, () => service.getUserCredits(userId)));

    expect((await stored(userId)).balance).toBe(10);
    const journal = await getUserJournalCollection(db, userId)
      .where("source", "==", "monthly_reset")
      .get();
    expect(journal.docs).toHaveLength(1);
    expect(journal.docs[0]!.data().metadata.tier).toBe("free");
  });

  it("the downgrade cap sets balance and monthlyLimit", async () => {
    const userId = await seed({
      tier: "premium",
      balance: 400,
      monthlyLimit: 500,
      monthlyResetAt: new Date(Date.now() + DAY).toISOString(),
      subscriptionExpiresAt: new Date(Date.now() - 10 * DAY).toISOString(),
    });

    const result = await repoWith({
      getDowngradeBalanceCap: () => 0,
    }).checkAndHandleSubscriptionExpiry(userId, 3);

    expect(result.wasDowngraded).toBe(true);
    const after = await stored(userId);
    expect(after.tier).toBe("free");
    expect(after.balance).toBe(0);
    expect(after.monthlyLimit).toBe(0);
  });

  it("a capped downgrade leaves a live hold committable", async () => {
    const userId = await seed({
      tier: "premium",
      balance: 100,
      monthlyResetAt: new Date(Date.now() + DAY).toISOString(),
    });
    const repo = repoWith({ getDowngradeBalanceCap: () => 0 });
    const hold = await repo.reserveCreditsV2({
      userId,
      amount: 60,
      operationType: "audio_generation",
      expiresAt: new Date(Date.now() + 60_000),
    });
    if (hold.outcome !== "created") throw new Error(`reserve: ${hold.outcome}`);
    await balanceRef(userId).update({
      subscriptionExpiresAt: new Date(Date.now() - 10 * DAY).toISOString(),
    });

    await repo.checkAndHandleSubscriptionExpiry(userId, 3);
    expect((await stored(userId)).balance).toBe(60);

    const commit = await repo.commitReservationV2(userId, hold.reservation.id);
    expect(commit.outcome).toBe("committed");
  });

  it("balanceCap racing a charge never writes the spent balance back", async () => {
    // Whichever transaction wins, the charge survives: the two orders both end at 0.
    for (let round = 0; round < 5; round++) {
      const userId = await seed({ tier: "premium", balance: 20, monthlyLimit: 500 });
      const repo = repoWith();

      await Promise.all([
        repo.deductCreditsAtomic(userId, 20),
        repo.updateUserTier(userId, { tier: "free", monthlyLimit: 25, balanceCap: 25 }),
      ]);

      const after = await stored(userId);
      expect(after.balance).toBe(0);
      expect(after.tier).toBe("free");
    }
  });

  it("balanceCap lowers a paid account and ignores a free one", async () => {
    const paid = await seed({ tier: "premium", balance: 400 });
    const free = await seed({ tier: "free", balance: 400 });
    const repo = repoWith();

    await repo.updateUserTier(paid, { tier: "free", monthlyLimit: 25, balanceCap: 25 });
    await repo.updateUserTier(free, { tier: "free", monthlyLimit: 50, balanceCap: 25 });

    expect((await stored(paid)).balance).toBe(25);
    expect((await stored(free)).balance).toBe(400);
    expect((await stored(free)).monthlyLimit).toBe(50);
  });

  it("refuses balance and balanceCap together", async () => {
    const userId = await seed({ tier: "premium", balance: 400 });

    await expect(
      repoWith().updateUserTier(userId, {
        tier: "free",
        monthlyLimit: 25,
        balance: 25,
        balanceCap: 25,
      })
    ).rejects.toThrow("both balance and balanceCap");
    expect((await stored(userId)).tier).toBe("premium");
  });
});
