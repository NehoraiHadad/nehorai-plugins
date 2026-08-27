/**
 * Balance reductions never cut through the credits that back live holds.
 *
 * Commit's funding guard is `balance + bonusCredits >= amount`, so any write
 * that lowers `balance` below `reserved - bonusCredits` strands every
 * outstanding reservation: the hold stays in `reserved`, and its commit throws
 * INSUFFICIENT_CREDITS forever. Three writers used to be able to do that — the
 * monthly reset, the subscription downgrade, and an explicit tier write — and
 * each is now floored at `backedBalanceFloor`.
 *
 * Also here: the first credit for a not-yet-seeded user creates the account at
 * tier defaults, matching the SQL adapter's `ensureUserCredits`, instead of
 * throwing in one adapter and landing in the other.
 *
 * The SQL parity of these cases lives in
 * `credits-drizzle/__tests__/integration/hold-backing.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryCreditRepository, getDefaultTier } from "../../src";

const USER = "u-backing";
const OP = "story_generation";
const soon = () => new Date(Date.now() + 60_000);

async function repoHolding(balance: number, hold: number) {
  const repo = createInMemoryCreditRepository();
  await repo.initializeUserCredits(USER, "premium", balance);
  const reserved = await repo.reserveCreditsV2({
    userId: USER,
    amount: hold,
    operationType: OP,
    expiresAt: soon(),
  });
  if (reserved.outcome !== "created") throw new Error("expected a hold");
  return { repo, reservationId: reserved.reservation.id };
}

describe("monthly reset with an outstanding hold", () => {
  it("keeps the hold committable when the tier target is below it", async () => {
    const { repo, reservationId } = await repoHolding(9000, 1000);
    const before = await repo.getUserCredits(USER);

    const reset = await repo.atomicMonthlyReset(USER, "premium", before!.monthlyResetAt);
    expect(reset.wasReset).toBe(true);
    // Premium resets to 500 — but 1000 credits are still on hold, so the
    // balance floors at the hold instead of stranding it.
    expect(reset.credits.balance).toBe(1000);
    expect(reset.credits.reserved).toBe(1000);

    const commit = await repo.commitReservationV2(USER, reservationId);
    expect(commit.outcome).toBe("committed");
    expect((await repo.getUserCredits(USER))?.reserved).toBe(0);
  });

  it("still resets to the exact tier target when nothing is held", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "premium", 9000);
    const before = await repo.getUserCredits(USER);

    const reset = await repo.atomicMonthlyReset(USER, "premium", before!.monthlyResetAt);
    expect(reset.credits.balance).toBe(500);
  });
});

describe("downgrades with an outstanding hold", () => {
  it("subscription expiry clamps to the new limit but not below the hold", async () => {
    const { repo, reservationId } = await repoHolding(1000, 800);
    await repo.updateUserCredits(USER, {
      subscriptionExpiresAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });

    const result = await repo.checkAndHandleSubscriptionExpiry(USER, 3);
    expect(result.wasDowngraded).toBe(true);
    // The free limit (25) is far below the 800-credit hold; the floor wins.
    expect(result.credits.balance).toBe(800);

    const commit = await repo.commitReservationV2(USER, reservationId);
    expect(commit.outcome).toBe("committed");
  });

  it("an explicit tier write is floored the same way", async () => {
    const { repo, reservationId } = await repoHolding(1000, 800);
    await repo.updateUserTier(USER, { tier: "free", monthlyLimit: 25, balance: 25 });

    expect((await repo.getUserCredits(USER))?.balance).toBe(800);
    const commit = await repo.commitReservationV2(USER, reservationId);
    expect(commit.outcome).toBe("committed");
  });
});

describe("first credit for an unknown user", () => {
  it("creates the account at tier defaults and credits it", async () => {
    const repo = createInMemoryCreditRepository();
    const outcome = await repo.addCreditsV2({
      userId: "u-new",
      amount: 25,
      description: "webhook outran provisioning",
      paymentRef: "pay-new",
    });

    expect(outcome.outcome).toBe("created");
    const credits = await repo.getUserCredits("u-new");
    expect(credits?.tier).toBe(getDefaultTier());
    expect(credits?.bonusCredits).toBe(25);
  });

  it("a conflicting delivery for an unknown user creates nothing", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "free", 100);
    await repo.addCreditsV2({
      userId: USER,
      amount: 25,
      description: "original",
      paymentRef: "pay-1",
    });

    const outcome = await repo.addCreditsV2({
      userId: "u-ghost",
      amount: 25,
      description: "reused reference, different user",
      paymentRef: "pay-1",
    });
    expect(outcome.outcome).toBe("conflict");
    expect(await repo.getUserCredits("u-ghost")).toBeNull();
  });
});
