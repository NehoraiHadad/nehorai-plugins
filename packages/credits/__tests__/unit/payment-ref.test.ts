/**
 * `paymentRef` as a global, semantic idempotency boundary.
 *
 * Three behaviours are under test, and each one used to be wrong in a way that
 * moved money:
 *
 * - **Scope.** The reference identifies a credit *event*, not a user's copy of
 *   one. Memory searched only the crediting user's transactions while SQL
 *   enforced a global unique index, so the same webhook replayed against a
 *   second account credited twice in memory and no-opped in SQL.
 * - **Payload.** Presence was enough. A reference arriving again with a
 *   different amount was accepted as a replay, so a corrected webhook credited
 *   the original amount and reported success.
 * - **Blankness.** `''` and `'   '` were falsy for the duplicate check and
 *   truthy for the write, so they were stored as references that could never
 *   match again.
 *
 * The SQL parity of every case here lives in
 * `credits-drizzle/__tests__/integration/payment-ref.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  CreditErrorCode,
  createInMemoryCreditRepository,
  isCreditedOutcome,
} from "../../src/index.js";
import type { InMemoryCreditRepository } from "../../src/repository/memory/index.js";

const ALICE = "u-alice";
const BOB = "u-bob";

async function repoWithUsers(): Promise<InMemoryCreditRepository> {
  const repo = createInMemoryCreditRepository();
  await repo.initializeUserCredits(ALICE, "free", 100);
  await repo.initializeUserCredits(BOB, "free", 100);
  return repo;
}

async function stateOf(repo: InMemoryCreditRepository, userId: string) {
  const credits = await repo.getUserCredits(userId);
  return {
    balance: credits?.balance,
    bonusCredits: credits?.bonusCredits,
    transactions: (await repo.getTransactions(userId, 100)).length,
    journal: (await repo.getJournalEntries({ userId, limit: 100 })).length,
  };
}

describe("a first delivery", () => {
  it("credits, and reports what it created", async () => {
    const repo = await repoWithUsers();
    const outcome = await repo.addCreditsV2({
      userId: ALICE,
      amount: 25,
      description: "Purchase",
      paymentRef: "pi_1",
    });

    expect(outcome.outcome).toBe("created");
    expect(isCreditedOutcome(outcome)).toBe(true);
    if (outcome.outcome !== "created") throw new Error("unreachable");
    expect(outcome.paymentRef).toBe("pi_1");
    expect(outcome.transaction?.amount).toBe(25);
    expect(outcome.journalEntryId).toBeDefined();
    expect(await stateOf(repo, ALICE)).toMatchObject({
      bonusCredits: 25,
      transactions: 1,
      journal: 1,
    });
  });
});

describe("the same delivery again", () => {
  it("is a replay: no second credit, no second row", async () => {
    const repo = await repoWithUsers();
    const input = { userId: ALICE, amount: 25, description: "Purchase", paymentRef: "pi_1" };

    const first = await repo.addCreditsV2(input);
    const second = await repo.addCreditsV2({ ...input, description: "Purchase of 25 credits" });

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("replayed");
    if (second.outcome !== "replayed") throw new Error("unreachable");
    // The stored transaction is handed back, so a caller can reconcile.
    expect(second.transaction.amount).toBe(25);
    expect(await stateOf(repo, ALICE)).toMatchObject({
      bonusCredits: 25,
      transactions: 1,
      journal: 1,
    });
  });

  it("is a replay even when only the description differs", async () => {
    const repo = await repoWithUsers();
    await repo.addCreditsV2({ userId: ALICE, amount: 5, description: "a", paymentRef: "pi_2" });
    const again = await repo.addCreditsV2({
      userId: ALICE,
      amount: 5,
      description: "b — regenerated copy",
      paymentRef: "pi_2",
    });
    expect(again.outcome).toBe("replayed");
  });
});

describe("the same reference for a different event", () => {
  const cases = [
    {
      label: "a different amount",
      second: { userId: ALICE, amount: 50, description: "Purchase", paymentRef: "pi_1" },
      mismatch: "amount",
    },
    {
      label: "a different user",
      second: { userId: BOB, amount: 25, description: "Purchase", paymentRef: "pi_1" },
      mismatch: "userId",
    },
    {
      label: "a different source",
      second: {
        userId: ALICE,
        amount: 25,
        description: "Purchase",
        paymentRef: "pi_1",
        options: { source: "admin_adjustment" as const },
      },
      mismatch: "source",
    },
  ];

  for (const { label, second, mismatch } of cases) {
    it(`conflicts on ${label}, and changes nothing`, async () => {
      const repo = await repoWithUsers();
      await repo.addCreditsV2({
        userId: ALICE,
        amount: 25,
        description: "Purchase",
        paymentRef: "pi_1",
      });
      const before = { alice: await stateOf(repo, ALICE), bob: await stateOf(repo, BOB) };

      const outcome = await repo.addCreditsV2(second);

      expect(outcome.outcome).toBe("conflict");
      if (outcome.outcome !== "conflict") throw new Error("unreachable");
      expect(outcome.mismatch).toBe(mismatch);
      expect(outcome.existing.userId).toBe(ALICE);
      expect(outcome.existing.amount).toBe(25);

      expect(await stateOf(repo, ALICE)).toEqual(before.alice);
      expect(await stateOf(repo, BOB)).toEqual(before.bob);
    });
  }

  it("throws through the legacy signature rather than reporting success", async () => {
    // `addCreditsAtomic` returns `void`, so a swallowed conflict is
    // indistinguishable from "credited" — which is the failure this closes.
    const repo = await repoWithUsers();
    await repo.addCreditsAtomic(ALICE, 25, "Purchase", "pi_1");

    await expect(repo.addCreditsAtomic(BOB, 25, "Purchase", "pi_1")).rejects.toMatchObject({
      code: CreditErrorCode.IDEMPOTENCY_CONFLICT,
      details: { paymentRef: "pi_1", mismatch: "userId", existingUserId: ALICE },
    });
    expect(await stateOf(repo, BOB)).toMatchObject({ bonusCredits: 0, transactions: 0 });
  });

  it("stays quiet through the legacy signature on a genuine replay", async () => {
    const repo = await repoWithUsers();
    await repo.addCreditsAtomic(ALICE, 25, "Purchase", "pi_1");
    await expect(repo.addCreditsAtomic(ALICE, 25, "Purchase", "pi_1")).resolves.toBeUndefined();
    expect(await stateOf(repo, ALICE)).toMatchObject({ bonusCredits: 25, transactions: 1 });
  });
});

describe("a blank reference is not a reference", () => {
  for (const blank of ["", "   ", "\t\n"]) {
    it(`credits every time for ${JSON.stringify(blank)}, and stores no reference`, async () => {
      const repo = await repoWithUsers();
      const first = await repo.addCreditsV2({
        userId: ALICE,
        amount: 10,
        description: "Purchase",
        paymentRef: blank,
      });
      const second = await repo.addCreditsV2({
        userId: ALICE,
        amount: 10,
        description: "Purchase",
        paymentRef: blank,
      });

      expect(first.outcome).toBe("created");
      expect(second.outcome).toBe("created");
      if (first.outcome !== "created") throw new Error("unreachable");
      expect(first.paymentRef).toBeUndefined();
      expect(first.transaction?.paymentRef).toBeUndefined();
      expect(await stateOf(repo, ALICE)).toMatchObject({ bonusCredits: 20, transactions: 2 });
    });
  }

  it("trims a padded reference to the same reference", async () => {
    const repo = await repoWithUsers();
    const first = await repo.addCreditsV2({
      userId: ALICE,
      amount: 10,
      description: "Purchase",
      paymentRef: "  pi_pad  ",
    });
    const second = await repo.addCreditsV2({
      userId: ALICE,
      amount: 10,
      description: "Purchase",
      paymentRef: "pi_pad",
    });

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("replayed");
    expect(await stateOf(repo, ALICE)).toMatchObject({ bonusCredits: 10, transactions: 1 });
  });
});

describe("the reference is global, not per user", () => {
  it("finds a reference stored against another account", async () => {
    // The bug: memory searched only the crediting user's transactions, so this
    // credited Bob for Alice's payment while SQL refused the same call.
    const repo = await repoWithUsers();
    await repo.addCreditsV2({
      userId: ALICE,
      amount: 25,
      description: "Purchase",
      paymentRef: "pi_shared",
    });

    const outcome = await repo.addCreditsV2({
      userId: BOB,
      amount: 25,
      description: "Purchase",
      paymentRef: "pi_shared",
    });

    expect(outcome.outcome).toBe("conflict");
    expect(await stateOf(repo, BOB)).toMatchObject({ bonusCredits: 0, transactions: 0 });
  });
});

describe("input validation still runs first", () => {
  for (const amount of [0, -1, 1.005, Number.POSITIVE_INFINITY, Number.NaN]) {
    it(`refuses ${String(amount)} before touching the reference`, async () => {
      const repo = await repoWithUsers();
      await expect(
        repo.addCreditsV2({
          userId: ALICE,
          amount,
          description: "Purchase",
          paymentRef: "pi_bad",
        })
      ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });
      expect(await stateOf(repo, ALICE)).toMatchObject({ transactions: 0 });
    });
  }
});
