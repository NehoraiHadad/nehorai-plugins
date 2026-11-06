/**
 * Final balances do not depend on the order holds close in, against a real Firestore.
 * The table is shared with the memory suite.
 *
 * Run with `pnpm test:emulator`. Skipped when FIRESTORE_EMULATOR_HOST is unset.
 */
import { randomUUID } from "node:crypto";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FirestoreCreditRepository, getUserReservationsCollection } from "../src";
import {
  SCENARIOS,
  checkAbsoluteBalanceClearsBacking,
  checkIncrementGuard,
  checkIncrementSparesBacking,
  checkReservedWithoutHolds,
  checkScenario,
} from "../../credits/__tests__/helpers/hold-close-order";
import { retryEmulatorClosedTransactions } from "./emulator-transactions.js";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;

describe.skipIf(!emulator)("holds close in any order (emulator)", { timeout: 60_000 }, () => {
  let app: App;
  let db: Firestore;

  beforeAll(() => {
    app = initializeApp({ projectId: "credits-firestore-test" }, `close-order-${randomUUID()}`);
    db = retryEmulatorClosedTransactions(getFirestore(app));
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", async (_name, scenario) => {
    const problems = await checkScenario(
      scenario,
      (options) => new FirestoreCreditRepository(db, options),
      () => `close-order-${randomUUID()}`
    );
    expect(problems).toEqual([]);
  });

  it("refuses an increment through the floor or below 0", async () => {
    await checkIncrementGuard(new FirestoreCreditRepository(db), `close-order-${randomUUID()}`);
  });

  it("charges an increment to valid credits only", async () => {
    await checkIncrementSparesBacking(
      new FirestoreCreditRepository(db),
      `close-order-${randomUUID()}`
    );
  });

  it("clears total and shares together on an absolute balance", async () => {
    await checkAbsoluteBalanceClearsBacking(
      new FirestoreCreditRepository(db),
      `close-order-${randomUUID()}`
    );
  });

  it("marks only what placed holds can carry", async () => {
    await checkReservedWithoutHolds(
      new FirestoreCreditRepository(db),
      `close-order-${randomUUID()}`
    );
  });

  it("a close touches only its own hold", async () => {
    const repo = new FirestoreCreditRepository(db);
    const userId = `close-order-${randomUUID()}`;
    await repo.initializeUserCredits(userId, "premium", 100);
    const hold = async (amount: number) => {
      const made = await repo.reserveCreditsV2({
        userId,
        amount,
        operationType: "story_generation",
        expiresAt: new Date(Date.now() + 60_000),
      });
      if (made.outcome !== "created") throw new Error(made.outcome);
      return made.reservation.id;
    };
    const first = await hold(50);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await hold(30);
    await repo.updateUserTier(userId, { tier: "premium", monthlyLimit: 500, balanceCap: 0 });
    const before = await repo.getReservation(userId, second);
    const updateTime = async () =>
      (await getUserReservationsCollection(db, userId).doc(second).get()).updateTime?.toMillis();
    const stamp = await updateTime();

    await repo.releaseReservationV2(userId, first);

    expect(await updateTime()).toBe(stamp);
    expect(await repo.getReservation(userId, second)).toEqual(before);
  });

  it("holds closing at once land on the same totals", async () => {
    const repo = new FirestoreCreditRepository(db, { getDowngradeBalanceCap: () => 0 });
    const userId = `close-order-${randomUUID()}`;
    await repo.initializeUserCredits(userId, "premium", 100);
    const holdOf = async (amount: number) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const made = await repo.reserveCreditsV2({
        userId,
        amount,
        operationType: "story_generation",
        expiresAt: new Date(Date.now() + 60_000),
      });
      if (made.outcome !== "created") throw new Error(made.outcome);
      return made.reservation.id;
    };
    const first = await holdOf(50);
    const second = await holdOf(30);
    await repo.updateUserCredits(userId, {
      subscriptionExpiresAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
    });
    await repo.checkAndHandleSubscriptionExpiry(userId, 3);
    await repo.updateUserCredits(userId, { bonusCreditsIncrement: 100 });
    const third = await holdOf(10);

    await Promise.all([
      repo.commitReservationV2(userId, first),
      repo.releaseReservationV2(userId, second),
      repo.commitReservationV2(userId, third),
    ]);

    // The 80 kept are 50 + 30 expired: both go, and the third pays 10 from the bonus.
    expect(await repo.getUserCredits(userId)).toMatchObject({
      balance: 0,
      bonusCredits: 90,
      reserved: 0,
      expiredHoldBacking: 0,
    });
  });
});
