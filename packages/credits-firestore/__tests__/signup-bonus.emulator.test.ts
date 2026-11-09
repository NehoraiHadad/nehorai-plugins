/**
 * A signup gift passed as `signupBonus` against a real Firestore: it lands in
 * `bonusCredits`, so a subscription grant, a renewal, the expiry cap and a paid tier
 * write all keep it. The claim, the bonus and its line commit together under contention.
 *
 * Run with `pnpm test:emulator`. Skipped when FIRESTORE_EMULATOR_HOST is unset.
 */
import { randomUUID } from "node:crypto";
import { deleteApp, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BALANCE_DOC_ID, FirestoreCreditRepository, getUserCreditsCollection } from "../src";
import { getUserJournalCollection } from "../src/repository/journal.js";
import { retryEmulatorClosedTransactions } from "./emulator-transactions.js";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const DAY = 86_400_000;

describe.skipIf(!emulator)("signup bonus (emulator)", { timeout: 60_000 }, () => {
  let app: App;
  let db: Firestore;
  let repo: FirestoreCreditRepository;

  beforeAll(() => {
    app = initializeApp({ projectId: "credits-firestore-test" }, `bonus-${randomUUID()}`);
    db = retryEmulatorClosedTransactions(getFirestore(app));
    repo = new FirestoreCreditRepository(db, { getDowngradeBalanceCap: () => 0 });
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  const newUser = () => `user-${randomUUID()}`;
  const newClaim = () => db.collection("signup-claims").doc(randomUUID());
  const balanceRef = (userId: string) => getUserCreditsCollection(db, userId).doc(BALANCE_DOC_ID);
  const stored = async (userId: string) => (await balanceRef(userId).get()).data()!;
  const lines = async (userId: string) =>
    (await getUserJournalCollection(db, userId).get()).docs.map((doc) => doc.data());

  const grant = (userId: string, cycle: string) =>
    repo.grantSubscriptionCycle({
      userId,
      grantKey: `cycle/${userId}/${cycle}`,
      tier: "premium",
      credits: 100,
      subscriptionExpiresAt: new Date(Date.now() + 30 * DAY),
      monthlyResetAt: new Date(Date.now() + 30 * DAY),
      description: `Subscription cycle ${cycle}`,
    });

  it("stores the bonus with the claim and journals it with bucket bonus", async () => {
    const userId = newUser();
    const claim = newClaim();

    const credits = await repo.initializeUserCredits(userId, "free", 0, {
      signupBonus: 65,
      signupGrantClaim: claim,
    });

    expect(credits).toMatchObject({ balance: 0, bonusCredits: 65, monthlyLimit: 0 });
    expect(await stored(userId)).toMatchObject({
      balance: 0,
      bonusCredits: 65,
      monthlyLimit: 0,
      signupGrant: 65,
    });
    expect((await claim.get()).exists).toBe(true);
    expect(await lines(userId)).toEqual([
      expect.objectContaining({
        entryType: "credit",
        amount: 65,
        balanceBefore: 0,
        balanceAfter: 65,
        source: "bonus",
        referenceId: `signup-${userId}`,
        referenceType: "adjustment",
        metadata: { tier: "free", bucket: "bonus" },
      }),
    ]);
  });

  it("a taken claim gives bonus 0, no claim write, and one journal line", async () => {
    const userId = newUser();
    const claim = newClaim();
    await claim.create({ claimedAt: "earlier" });

    const credits = await repo.initializeUserCredits(userId, "free", 25, {
      signupBonus: 65,
      signupGrantClaim: claim,
    });

    expect(credits).toMatchObject({ balance: 25, bonusCredits: 0 });
    expect((await claim.get()).data()).toEqual({ claimedAt: "earlier" });
    expect(await stored(userId)).not.toHaveProperty("signupGrant");
    expect(await lines(userId)).toEqual([
      expect.objectContaining({ amount: 25, metadata: { tier: "free", bucket: "balance" } }),
    ]);
  });

  it("concurrent accounts on one claim: one bonus, one bonus line, every allotment", async () => {
    const claim = newClaim();
    const users = Array.from({ length: 5 }, newUser);

    await Promise.all(
      users.map((userId) =>
        repo.initializeUserCredits(userId, "free", 10, { signupBonus: 65, signupGrantClaim: claim })
      )
    );

    const accounts = await Promise.all(users.map(stored));
    const bonusLines = (await Promise.all(users.map(lines)))
      .flat()
      .filter((line) => line.metadata?.bucket === "bonus");
    expect(accounts.map((account) => account.balance)).toEqual([10, 10, 10, 10, 10]);
    expect(accounts.map((account) => account.bonusCredits).sort()).toEqual([0, 0, 0, 0, 65]);
    expect(bonusLines).toHaveLength(1);
    expect(bonusLines[0]).toMatchObject({ amount: 65, balanceBefore: 10, balanceAfter: 75 });
  });

  it("without signupBonus the legacy call is unchanged", async () => {
    const userId = newUser();

    await repo.initializeUserCredits(userId, "free", 25, { signupGrantClaim: newClaim() });

    expect(await stored(userId)).toMatchObject({ balance: 25, bonusCredits: 0, signupGrant: 25 });
    expect(await lines(userId)).toEqual([
      expect.objectContaining({ amount: 25, metadata: { tier: "free" } }),
    ]);
  });

  describe("65 signup, spend 20, then what replaces the balance", () => {
    async function subscribed() {
      const userId = newUser();
      await repo.initializeUserCredits(userId, "free", 0, {
        signupBonus: 65,
        signupGrantClaim: newClaim(),
      });
      await repo.deductCreditsAtomic(userId, 20);
      expect(await stored(userId)).toMatchObject({ balance: 0, bonusCredits: 45 });

      const result = await grant(userId, "1");
      expect(result.outcome).toBe("granted");
      const account = await stored(userId);
      expect(account).toMatchObject({ tier: "premium", balance: 100, bonusCredits: 45 });
      expect(account.balance + account.bonusCredits).toBe(145);
      return userId;
    }

    it("the cycle grant of 100 gives balance 100, bonus 45, total 145", async () => {
      const userId = await subscribed();

      const grantLine = (await lines(userId)).find(
        (line) => line.source === "subscription_grant"
      );
      expect(grantLine).toMatchObject({ amount: 100, balanceBefore: 45, balanceAfter: 145 });
    });

    it("a renewal keeps bonus 45", async () => {
      const userId = await subscribed();
      await repo.deductCreditsAtomic(userId, 30);

      expect((await grant(userId, "2")).outcome).toBe("granted");

      expect(await stored(userId)).toMatchObject({ balance: 100, bonusCredits: 45 });
    });

    it("the expiry cap to a free grant of 0 keeps bonus 45", async () => {
      const userId = await subscribed();
      await balanceRef(userId).update({
        subscriptionExpiresAt: new Date(Date.now() - 30 * DAY).toISOString(),
      });

      const result = await repo.checkAndHandleSubscriptionExpiry(userId);

      expect(result.wasDowngraded).toBe(true);
      expect(await stored(userId)).toMatchObject({ tier: "free", balance: 0, bonusCredits: 45 });
    });

    it("a paid updateUserTier keeps bonus 45", async () => {
      const userId = await subscribed();

      await repo.updateUserTier(userId, { tier: "basic", monthlyLimit: 300, balance: 300 });

      expect(await stored(userId)).toMatchObject({ tier: "basic", balance: 300, bonusCredits: 45 });
    });
  });
});
