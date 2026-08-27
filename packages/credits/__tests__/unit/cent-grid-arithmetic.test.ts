/**
 * Derived amounts must land on the cent grid the ledger validates against.
 *
 * Every balance the library computes — a total, a remainder, an incremented
 * column — is checked against `numeric(12, 2)` before it is written. Deriving
 * those values with `+` and `-` breaks that check on ordinary inputs: `0.1 +
 * 0.2` is `0.30000000000000004` and `0.3 - 0.1` is `0.19999999999999998`,
 * neither of which is on the grid. The guard then rejects a completely legal
 * operation as `INVALID_AMOUNT` and blames the caller for a rounding artefact.
 *
 * These are not overflow tests. Every amount here is small and legal; what is
 * being pinned is that normal arithmetic still works.
 */

import { describe, expect, it } from "vitest";
import {
  createInMemoryCreditRepository,
  getTotalCredits,
  sumAmounts,
  toCents,
} from "../../src/index.js";

describe("sumAmounts", () => {
  it("keeps sums that float addition would push off the grid", () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the premise
    expect(sumAmounts(0.1, 0.2)).toBe(0.3);
    expect(toCents(sumAmounts(0.1, 0.2))).toBe(30);
  });

  it("keeps differences that float subtraction would push off the grid", () => {
    expect(0.3 - 0.1).not.toBe(0.2); // the premise
    expect(sumAmounts(0.3, -0.1)).toBe(0.2);
    expect(toCents(sumAmounts(0.3, -0.1))).toBe(20);
  });

  it("sums more than two terms exactly", () => {
    expect(sumAmounts(0.1, 0.2, 0.3, -0.15)).toBe(0.45);
    expect(sumAmounts(1.1, 2.2, -3.3)).toBe(0);
  });

  it("returns the float sum when an input is already off the grid", () => {
    // Not a repair function: a corrupt stored value must still fail validation
    // at the call site rather than be rounded into legitimacy here.
    const corrupt = 0.005;
    expect(toCents(corrupt)).toBeNull();
    expect(sumAmounts(corrupt, 1)).toBe(corrupt + 1);
  });

  it("passes non-finite input straight through to the caller's validation", () => {
    expect(sumAmounts(Number.POSITIVE_INFINITY, 1)).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(sumAmounts(Number.NaN, 1))).toBe(true);
  });
});

describe("the in-memory adapter on amounts that break float arithmetic", () => {
  const USER = "u-cent-grid";

  async function seeded(balance: number, bonusCredits = 0) {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "free", balance);
    if (bonusCredits) await repo.updateUserCredits(USER, { bonusCredits });
    return repo;
  }

  it("adds bonus credits whose total is not a float-exact sum", async () => {
    const repo = await seeded(0.1);

    await repo.addCreditsAtomic(USER, 0.2, "top-up");

    const credits = await repo.getUserCredits(USER);
    expect(credits?.bonusCredits).toBe(0.2);
    expect(toCents(credits!.balance + credits!.bonusCredits)).toBeNull(); // the premise
  });

  it("deducts down to a remainder that is not a float-exact difference", async () => {
    const repo = await seeded(0.3);

    const result = await repo.deductCreditsAtomic(USER, 0.1);

    expect(result).toEqual({ previousBalance: 0.3, newBalance: 0.2 });
    expect((await repo.getUserCredits(USER))?.balance).toBe(0.2);
  });

  it("applies an increment whose result is not a float-exact sum", async () => {
    const repo = await seeded(0.1);

    await repo.updateUserCredits(USER, { balanceIncrement: 0.2 });

    expect((await repo.getUserCredits(USER))?.balance).toBe(0.3);
  });

  it("places two holds whose combined reserved total is not float-exact", async () => {
    const repo = await seeded(1);

    const first = await repo.reserveCreditsV2({
      userId: USER,
      amount: 0.1,
      operationType: "story_generation",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const second = await repo.reserveCreditsV2({
      userId: USER,
      amount: 0.2,
      operationType: "story_generation",
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("created");
    expect((await repo.getUserCredits(USER))?.reserved).toBe(0.3);
  });

  it("releases one of those holds back to a remainder that is not float-exact", async () => {
    const repo = await seeded(1);
    const small = await repo.reserveCreditsV2({
      userId: USER,
      amount: 0.1,
      operationType: "story_generation",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await repo.reserveCreditsV2({
      userId: USER,
      amount: 0.2,
      operationType: "story_generation",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const released = await repo.releaseReservationV2(USER, small.reservation!.id);

    expect(released.outcome).toBe("released");
    expect((await repo.getUserCredits(USER))?.reserved).toBe(0.2);
  });

  it("expires a hold back to a remainder that is not float-exact", async () => {
    const repo = await seeded(1);
    const stale = await repo.reserveCreditsV2({
      userId: USER,
      amount: 0.1,
      operationType: "story_generation",
      expiresAt: new Date(Date.now() - 1_000),
    });
    await repo.reserveCreditsV2({
      userId: USER,
      amount: 0.2,
      operationType: "story_generation",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const expired = await repo.expireReservationV2(USER, stale.reservation!.id);

    expect(expired.outcome).toBe("expired");
    expect((await repo.getUserCredits(USER))?.reserved).toBe(0.2);
  });

  it("deducts across balance and bonus credits when the split is not float-exact", async () => {
    // 0.30 - 0.20 leaves 0.09999999999999998 to take from bonus credits, and
    // 0.20 minus that is 0.10000000000000003 — two separate off-grid values in
    // one operation, neither of which the column can hold.
    const repo = await seeded(0.2, 0.2);

    const result = await repo.deductCreditsAtomic(USER, 0.3);

    expect(result).toEqual({ previousBalance: 0.4, newBalance: 0.1 });
    const credits = await repo.getUserCredits(USER);
    expect(credits?.balance).toBe(0);
    expect(credits?.bonusCredits).toBe(0.1);
  });

  it("reports a sweep total that is not a float-exact sum", async () => {
    const repo = await seeded(1);
    for (const amount of [0.1, 0.2]) {
      await repo.reserveCreditsV2({
        userId: USER,
        amount,
        operationType: "story_generation",
        expiresAt: new Date(Date.now() - 1_000),
      });
    }

    const result = await repo.findAndExpireReservations();

    // The running total is accumulated one hold at a time, so 0.1 + 0.2 lands
    // off the grid and the sweep reported 0.30000000000000004 back to the
    // operator who ran it.
    expect(result.expiredCount).toBe(2);
    expect(result.creditsReleased).toBe(0.3);
  });

  it("totals the ledger balance on the cent grid", async () => {
    const repo = await seeded(0.1, 0.2);
    const credits = await repo.getUserCredits(USER);

    expect(getTotalCredits(credits!)).toBe(0.3);
  });

  it("commits a reservation and journals a residue that is not float-exact", async () => {
    // The residue must be *two* non-zero columns whose float sum misses the
    // grid. Leaving 0 + 0.2 is not enough: a float sum reaches 0.2 just as
    // exactly. 0.20 - 0.10 leaves 0.1, and 0.1 + 0.2 is 0.30000000000000004.
    const repo = await seeded(0.2, 0.2);
    const held = await repo.reserveCreditsV2({
      userId: USER,
      amount: 0.1,
      operationType: "story_generation",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const outcome = await repo.commitReservationV2(USER, held.reservation!.id);

    expect(outcome).toMatchObject({ outcome: "committed", balanceAfter: 0.3 });
    const credits = await repo.getUserCredits(USER);
    expect(credits?.balance).toBe(0.1);
    expect(credits?.bonusCredits).toBe(0.2);
    expect(credits?.monthlyUsed).toBe(0.1);
    const entries = await repo.getJournalEntries({ userId: USER });
    expect(entries[0]?.balanceAfter).toBe(0.3);
  });
});
