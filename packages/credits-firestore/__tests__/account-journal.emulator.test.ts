/**
 * The journal lines of account creation and of a tier write against a real Firestore:
 * real contention, real transaction retries, and the journal read back independently.
 *
 * Run with `pnpm test:emulator`. Skipped when FIRESTORE_EMULATOR_HOST is unset.
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
} from "../src";
import { getUserJournalCollection } from "../src/repository/journal.js";
import { retryEmulatorClosedTransactions } from "./emulator-transactions.js";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;

describe.skipIf(!emulator)("account and tier journal lines (emulator)", { timeout: 60_000 }, () => {
  let app: App;
  let db: Firestore;

  beforeAll(() => {
    app = initializeApp({ projectId: "credits-firestore-test" }, `journal-${randomUUID()}`);
    db = retryEmulatorClosedTransactions(getFirestore(app));
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  const newUser = () => `user-${randomUUID()}`;
  const balanceRef = (userId: string) => getUserCreditsCollection(db, userId).doc(BALANCE_DOC_ID);
  const lines = async (userId: string) => {
    const snapshot = await getUserJournalCollection(db, userId).get();
    return snapshot.docs.map((doc) => doc.data());
  };
  const balanceOf = async (userId: string) => (await balanceRef(userId).get()).data()?.balance;

  it("concurrent creation commits one account and one line", async () => {
    const repo = new FirestoreCreditRepository(db);
    const userId = newUser();

    await Promise.all(
      Array.from({ length: 8 }, () => repo.initializeUserCredits(userId, "free", 25))
    );
    await repo.initializeUserCredits(userId, "free", 25);

    expect(await balanceOf(userId)).toBe(25);
    expect(await lines(userId)).toEqual([
      expect.objectContaining({
        entryType: "credit",
        amount: 25,
        balanceBefore: 0,
        balanceAfter: 25,
        source: "bonus",
      }),
    ]);
  });

  it("CreditsService.getOrCreateUserCredits journals the grant once", async () => {
    const service = new CreditsService(new FirestoreCreditRepository(db));
    const userId = newUser();

    const credits = await Promise.all(
      Array.from({ length: 4 }, () => service.getOrCreateUserCredits(userId))
    );

    const entries = await lines(userId);
    expect(entries).toHaveLength(1);
    expect(entries[0].balanceAfter).toBe(credits[0].balance);
  });

  it("a shared claim across concurrent accounts journals the one grant given", async () => {
    const repo = new FirestoreCreditRepository(db);
    const claim = db.collection("signup-claims").doc(randomUUID());
    const users = Array.from({ length: 5 }, newUser);

    await Promise.all(
      users.map((userId) =>
        repo.initializeUserCredits(userId, "free", 25, { signupGrantClaim: claim })
      )
    );

    const counts = await Promise.all(users.map(async (userId) => (await lines(userId)).length));
    const balances = await Promise.all(users.map(balanceOf));
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(balances.filter((balance) => balance === 25)).toHaveLength(1);
    expect(counts.map((count) => count === 1)).toEqual(balances.map((balance) => balance === 25));
  });

  it("a grant of 0 writes no line", async () => {
    const repo = new FirestoreCreditRepository(db);
    const userId = newUser();

    await repo.initializeUserCredits(userId, "free", 0);

    expect(await lines(userId)).toEqual([]);
  });

  it("concurrent first reserves journal the seed once", async () => {
    const repo = new FirestoreCreditRepository(db);
    const userId = newUser();
    const expiresAt = new Date(Date.now() + 60_000);

    await Promise.all(
      Array.from({ length: 4 }, () =>
        repo.reserveCreditsAtomic(userId, 1, "audio_generation", expiresAt)
      )
    );

    expect(await lines(userId)).toEqual([
      expect.objectContaining({ amount: 25, balanceBefore: 0, balanceAfter: 25, source: "bonus" }),
    ]);
  });

  it("concurrent first credits journal the seed once and chain their own lines", async () => {
    const repo = new FirestoreCreditRepository(db);
    const userId = newUser();

    await Promise.all(
      Array.from({ length: 4 }, () => repo.addCreditsAtomic(userId, 10, "first credit"))
    );

    const entries = await lines(userId);
    expect(entries.filter((entry) => entry.source === "bonus")).toHaveLength(1);
    expect(entries.filter((entry) => entry.source === "purchase")).toHaveLength(4);
    expect(entries.map((entry) => entry.balanceAfter).sort((a, b) => a - b)).toEqual([
      25, 35, 45, 55, 65,
    ]);
  });

  it("a tier raise commits one line with the balance", async () => {
    const repo = new FirestoreCreditRepository(db);
    const userId = newUser();
    await repo.initializeUserCredits(userId, "free", 25);
    await repo.addCreditsAtomic(userId, 10, "bonus");

    await repo.updateUserTier(userId, { tier: "premium", monthlyLimit: 100, balance: 100 });

    expect((await lines(userId)).filter((entry) => entry.source === "subscription_upgrade")).toEqual([
      expect.objectContaining({
        entryType: "credit",
        amount: 100,
        balanceBefore: 35,
        balanceAfter: 110,
      }),
    ]);
  });

  it("concurrent identical tier writes journal only the one that moved the balance", async () => {
    const repo = new FirestoreCreditRepository(db);
    const userId = newUser();
    await repo.initializeUserCredits(userId, "free", 25);

    await Promise.all(
      Array.from({ length: 6 }, () =>
        repo.updateUserTier(userId, { tier: "premium", monthlyLimit: 100, balance: 100 })
      )
    );

    expect(await balanceOf(userId)).toBe(100);
    expect(await lines(userId)).toHaveLength(2);
  });

  it("a tier write that leaves the balance alone writes no line", async () => {
    const repo = new FirestoreCreditRepository(db);
    const userId = newUser();
    await repo.initializeUserCredits(userId, "free", 25);

    await repo.updateUserTier(userId, { tier: "premium", monthlyLimit: 500 });
    await repo.updateUserTier(userId, { tier: "premium", monthlyLimit: 500, balance: 25 });

    expect(await lines(userId)).toHaveLength(1);
  });

  it("a downgrade by expiry and the tier write beside it do not double up", async () => {
    const repo = new FirestoreCreditRepository(db, { getDowngradeBalanceCap: () => 25 });
    const userId = newUser();
    await repo.initializeUserCredits(userId, "free", 25);
    await repo.updateUserTier(userId, {
      tier: "premium",
      monthlyLimit: 500,
      balance: 500,
      subscriptionExpiresAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
    });

    await repo.checkAndHandleSubscriptionExpiry(userId, 3);

    const entries = await lines(userId);
    expect(entries.map((entry) => entry.source).sort()).toEqual([
      "bonus",
      "subscription_downgrade",
      "subscription_upgrade",
    ]);
    expect(await balanceOf(userId)).toBe(25);
  });
});
