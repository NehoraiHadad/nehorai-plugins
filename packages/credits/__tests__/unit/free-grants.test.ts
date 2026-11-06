/**
 * The free-tier policy hooks and the atomic tier write, on the in-memory adapter.
 *
 * Applications run their contract tests here, so this has to match the Firestore
 * adapter (`credits-firestore/__tests__/free-grants*.test.ts`) and, for
 * `balanceCap` and the current-tier reset, the SQL adapter
 * (`credits-drizzle/__tests__/integration/free-grants.test.ts`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CreditErrorCode,
  CreditsService,
  createInMemoryCreditRepository,
  getNextMonthlyReset,
  initializeConfig,
  NO_EXPIRED_BACKING_PREFIX,
  allocateExpiredBacking,
  holdExpiredBacking,
  planBalanceCap,
  planHoldCommit,
  planBalanceTarget,
  resetConfig,
} from "../../src";

const USER = "u-free-grants";
const OP = "story_generation";
const PAST_DUE = new Date(Date.now() - 86_400_000).toISOString();
const LONG_EXPIRED = new Date(Date.now() - 400 * 86_400_000).toISOString();

type RepoOptions = NonNullable<Parameters<typeof createInMemoryCreditRepository>[0]>;

async function repoWith(
  account: { tier: string; balance: number; bonusCredits?: number; monthlyUsed?: number },
  options: RepoOptions = {}
) {
  const repo = createInMemoryCreditRepository(options);
  await repo.initializeUserCredits(USER, account.tier, account.balance);
  await repo.updateUserCredits(USER, {
    bonusCredits: account.bonusCredits ?? 0,
    monthlyUsed: account.monthlyUsed ?? 0,
    monthlyResetAt: PAST_DUE,
  });
  return repo;
}

async function hold(repo: ReturnType<typeof createInMemoryCreditRepository>, amount: number) {
  const reserved = await repo.reserveCreditsV2({
    userId: USER,
    amount,
    operationType: OP,
    expiresAt: new Date(Date.now() + 60_000),
  });
  if (reserved.outcome !== "created") throw new Error("expected a hold");
  return reserved.reservation.id;
}

describe("atomicMonthlyReset uses the tier stored on the account", () => {
  it("gives a free account its own limit when the argument still names the paid tier", async () => {
    // The race: the caller read premium, the account was downgraded, then the reset ran.
    const repo = await repoWith({ tier: "free", balance: 3 });

    const result = await repo.atomicMonthlyReset(USER, "premium", PAST_DUE);

    expect(result.wasReset).toBe(true);
    expect(result.credits.tier).toBe("free");
    expect(result.credits.balance).toBe(25);
  });

  it("names the stored tier in the reset's journal line", async () => {
    const repo = await repoWith({ tier: "free", balance: 3 });

    await repo.atomicMonthlyReset(USER, "premium", PAST_DUE);

    const [entry] = await repo.getJournalEntries({ userId: USER, source: "monthly_reset" });
    expect(entry?.metadata).toMatchObject({ tier: "free" });
    expect(entry?.description).toContain("free tier");
  });
});

describe("resolveMonthlyReset", () => {
  it("null: no reset and no write", async () => {
    const repo = await repoWith(
      { tier: "free", balance: 7, bonusCredits: 4, monthlyUsed: 2 },
      { resolveMonthlyReset: () => null }
    );
    const before = await repo.getUserCredits(USER);

    const result = await repo.atomicMonthlyReset(USER, "free", PAST_DUE);

    expect(result.wasReset).toBe(false);
    expect(result.credits).toEqual(before);
    expect(await repo.getUserCredits(USER)).toEqual(before);
    expect(await repo.getJournalEntries({ userId: USER })).toHaveLength(0);
  });

  it("receives the stored tier and balance, not the argument", async () => {
    const resolveMonthlyReset = vi.fn(() => null);
    const repo = await repoWith({ tier: "free", balance: 7 }, { resolveMonthlyReset });

    await repo.atomicMonthlyReset(USER, "premium", PAST_DUE);

    expect(resolveMonthlyReset).toHaveBeenCalledWith({ tier: "free", balance: 7 });
  });

  it("a result without monthlyLimit leaves the stored limit alone", async () => {
    const repo = await repoWith(
      { tier: "free", balance: 7, bonusCredits: 4, monthlyUsed: 2 },
      { resolveMonthlyReset: () => ({ balance: 40 }) }
    );
    const before = await repo.getUserCredits(USER);

    const result = await repo.atomicMonthlyReset(USER, "free", PAST_DUE);

    expect(result.wasReset).toBe(true);
    expect(result.credits.balance).toBe(40);
    expect(result.credits.monthlyLimit).toBe(before!.monthlyLimit);
    expect(result.credits.monthlyUsed).toBe(0);
    expect(result.credits.bonusCredits).toBe(4);
    expect(new Date(result.credits.monthlyResetAt).getTime()).toBeGreaterThan(Date.now());
    expect(await repo.getUserCredits(USER)).toEqual(result.credits);
  });

  it("a result with monthlyLimit writes it, including 0", async () => {
    const repo = await repoWith(
      { tier: "free", balance: 7 },
      { resolveMonthlyReset: () => ({ balance: 7, monthlyLimit: 0 }) }
    );

    const result = await repo.atomicMonthlyReset(USER, "free", PAST_DUE);

    expect(result.wasReset).toBe(true);
    expect(result.credits.balance).toBe(7);
    expect(result.credits.monthlyLimit).toBe(0);
    expect((await repo.getUserCredits(USER))?.monthlyLimit).toBe(0);
  });

  it("a throw aborts: nothing is written and the reset stays due", async () => {
    const repo = await repoWith(
      { tier: "free", balance: 7, monthlyUsed: 2 },
      {
        resolveMonthlyReset: () => {
          throw new Error("no settings");
        },
      }
    );
    const before = await repo.getUserCredits(USER);

    await expect(repo.atomicMonthlyReset(USER, "free", PAST_DUE)).rejects.toThrow("no settings");

    expect(await repo.getUserCredits(USER)).toEqual(before);
  });

  it("is not consulted when another request already performed the reset", async () => {
    const resolveMonthlyReset = vi.fn(() => ({ balance: 40 }));
    const repo = await repoWith({ tier: "free", balance: 7 }, { resolveMonthlyReset });

    const stale = await repo.atomicMonthlyReset(USER, "free", LONG_EXPIRED);

    expect(stale.wasReset).toBe(false);
    expect(resolveMonthlyReset).not.toHaveBeenCalled();
  });

  it.each([
    ["a negative balance", { balance: -1 }],
    ["an off-grid balance", { balance: 1.005 }],
    ["an infinite balance", { balance: Infinity }],
    ["a negative monthlyLimit", { balance: 1, monthlyLimit: -1 }],
  ])("refuses %s and writes nothing", async (_name, decision) => {
    const repo = await repoWith(
      { tier: "free", balance: 7 },
      { resolveMonthlyReset: () => decision }
    );
    const before = await repo.getUserCredits(USER);

    await expect(repo.atomicMonthlyReset(USER, "free", PAST_DUE)).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
    });
    expect(await repo.getUserCredits(USER)).toEqual(before);
  });

  it("does not cut through the credits backing a live hold", async () => {
    const repo = await repoWith(
      { tier: "premium", balance: 100 },
      { resolveMonthlyReset: () => ({ balance: 10 }) }
    );
    const reservationId = await hold(repo, 60);

    const result = await repo.atomicMonthlyReset(USER, "premium", PAST_DUE);

    expect(result.credits.balance).toBe(60);
    expect((await repo.commitReservationV2(USER, reservationId)).outcome).toBe("committed");
  });

  it("drives the two-number free tier through the service", async () => {
    // Monthly grant 0: free accounts never reset. Above 0: top up, never lower.
    const policy = (monthlyGrant: number): RepoOptions => ({
      resolveMonthlyReset: ({ tier, balance }) => {
        if (tier !== "free") return { balance: 500 };
        return monthlyGrant === 0 ? null : { balance: Math.max(balance, monthlyGrant) };
      },
    });

    const neverResets = await repoWith({ tier: "free", balance: 3 }, policy(0));
    const unchanged = await new CreditsService(neverResets).getUserCredits(USER);
    expect(unchanged?.balance).toBe(3);
    expect(unchanged?.monthlyResetAt).toBe(PAST_DUE);

    const toppedUp = await repoWith({ tier: "free", balance: 3 }, policy(10));
    expect((await new CreditsService(toppedUp).getUserCredits(USER))?.balance).toBe(10);

    const notLowered = await repoWith({ tier: "free", balance: 30 }, policy(10));
    expect((await new CreditsService(notLowered).getUserCredits(USER))?.balance).toBe(30);
  });
});

describe("getDowngradeBalanceCap", () => {
  async function expiredPaidAccount(balance: number, options: RepoOptions = {}) {
    const repo = await repoWith({ tier: "premium", balance }, options);
    await repo.updateUserCredits(USER, { subscriptionExpiresAt: LONG_EXPIRED });
    return repo;
  }

  it("sets both the balance cap and monthlyLimit", async () => {
    const repo = await expiredPaidAccount(400, { getDowngradeBalanceCap: () => 10 });

    const result = await repo.checkAndHandleSubscriptionExpiry(USER, 3);

    expect(result.wasDowngraded).toBe(true);
    expect(result.credits.tier).toBe("free");
    expect(result.credits.balance).toBe(10);
    expect(result.credits.monthlyLimit).toBe(10);
  });

  it("accepts 0, which is not the same as the option being absent", async () => {
    const repo = await expiredPaidAccount(400, { getDowngradeBalanceCap: () => 0 });

    const result = await repo.checkAndHandleSubscriptionExpiry(USER, 3);

    expect(result.credits.balance).toBe(0);
    expect(result.credits.monthlyLimit).toBe(0);
  });

  it("does not raise a balance already under the cap", async () => {
    const repo = await expiredPaidAccount(4, { getDowngradeBalanceCap: () => 10 });

    const result = await repo.checkAndHandleSubscriptionExpiry(USER, 3);

    expect(result.credits.balance).toBe(4);
    expect(result.credits.monthlyLimit).toBe(10);
  });

  it("keeps the default tier's configured limit without the option", async () => {
    const repo = await expiredPaidAccount(400);

    const result = await repo.checkAndHandleSubscriptionExpiry(USER, 3);

    expect(result.credits.balance).toBe(25);
    expect(result.credits.monthlyLimit).toBe(25);
  });

  it("does not cut through the credits backing a live hold", async () => {
    const repo = await expiredPaidAccount(100, { getDowngradeBalanceCap: () => 0 });
    const reservationId = await hold(repo, 60);

    const result = await repo.checkAndHandleSubscriptionExpiry(USER, 3);

    expect(result.credits.balance).toBe(60);
    expect((await repo.commitReservationV2(USER, reservationId)).outcome).toBe("committed");
  });

  it("refuses a negative cap and writes nothing", async () => {
    const repo = await expiredPaidAccount(400, { getDowngradeBalanceCap: () => -1 });
    const before = await repo.getUserCredits(USER);

    await expect(repo.checkAndHandleSubscriptionExpiry(USER, 3)).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
    });
    expect(await repo.getUserCredits(USER)).toEqual(before);
  });
});

describe("updateUserTier with balanceCap", () => {
  it("lowers a paid account's balance", async () => {
    const repo = await repoWith({ tier: "premium", balance: 400 });

    await repo.updateUserTier(USER, { tier: "free", monthlyLimit: 25, balanceCap: 25 });

    const credits = await repo.getUserCredits(USER);
    expect(credits?.tier).toBe("free");
    expect(credits?.monthlyLimit).toBe(25);
    expect(credits?.balance).toBe(25);
  });

  it("leaves a charge that landed first in place", async () => {
    // The race: read 20, a charge takes it to 0, the downgrade used to write 20 back.
    const repo = await repoWith({ tier: "premium", balance: 20 });
    await repo.deductCreditsAtomic(USER, 20);

    await repo.updateUserTier(USER, { tier: "free", monthlyLimit: 25, balanceCap: 25 });

    expect((await repo.getUserCredits(USER))?.balance).toBe(0);
  });

  it("is ignored for an account already free, and the rest of the write applies", async () => {
    const repo = await repoWith({ tier: "free", balance: 400 });

    await repo.updateUserTier(USER, { tier: "free", monthlyLimit: 50, balanceCap: 25 });

    const credits = await repo.getUserCredits(USER);
    expect(credits?.balance).toBe(400);
    expect(credits?.monthlyLimit).toBe(50);
  });

  it("does not cut through the credits backing a live hold", async () => {
    const repo = await repoWith({ tier: "premium", balance: 100 });
    const reservationId = await hold(repo, 60);

    await repo.updateUserTier(USER, { tier: "free", monthlyLimit: 25, balanceCap: 25 });

    expect((await repo.getUserCredits(USER))?.balance).toBe(60);
    expect((await repo.commitReservationV2(USER, reservationId)).outcome).toBe("committed");
  });

  it("refuses balance and balanceCap together and writes nothing", async () => {
    const repo = await repoWith({ tier: "premium", balance: 400 });

    await expect(
      repo.updateUserTier(USER, { tier: "free", monthlyLimit: 25, balance: 25, balanceCap: 25 })
    ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });

    const credits = await repo.getUserCredits(USER);
    expect(credits?.tier).toBe("premium");
    expect(credits?.balance).toBe(400);
  });

  it.each([-1, 1.005, Infinity, NaN])("refuses a cap of %s", async (balanceCap) => {
    const repo = await repoWith({ tier: "premium", balance: 400 });

    await expect(
      repo.updateUserTier(USER, { tier: "free", monthlyLimit: 25, balanceCap })
    ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });
  });
});

describe("a signup grant of 0", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    resetConfig();
  });

  it("is a valid configuration and seeds an empty account", async () => {
    initializeConfig({ defaultFreeCredits: 0 });
    const repo = createInMemoryCreditRepository();
    const service = new CreditsService(repo);

    const credits = await service.getOrCreateUserCredits(USER);

    expect(credits.balance).toBe(0);
    expect((await service.checkCredits(USER, 1)).hasCredits).toBe(false);
  });

  it("loads from CREDITS_DEFAULT_FREE at import", async () => {
    vi.stubEnv("CREDITS_DEFAULT_FREE", "0");
    vi.resetModules();

    const credits = await import("../../src");

    expect(credits.getDefaultFreeCredits()).toBe(0);
  });

  it("still refuses a negative grant", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => initializeConfig({ defaultFreeCredits: -1 })).toThrow(
      "Invalid credit system configuration"
    );
  });
});

describe("getNextMonthlyReset", () => {
  it.each([
    ["31 January", new Date(2027, 0, 31, 15, 30), new Date(2027, 1, 1)],
    ["31 March", new Date(2027, 2, 31), new Date(2027, 3, 1)],
    ["31 May", new Date(2027, 4, 31), new Date(2027, 5, 1)],
    ["30 January", new Date(2027, 0, 30), new Date(2027, 1, 1)],
    ["29 January before a leap February", new Date(2028, 0, 29), new Date(2028, 1, 1)],
    ["31 December", new Date(2027, 11, 31, 23, 59), new Date(2028, 0, 1)],
    ["1 June", new Date(2027, 5, 1), new Date(2027, 6, 1)],
  ])("%s gives the next month's first day", (_name, from, expected) => {
    expect(getNextMonthlyReset(from)).toEqual(expected);
  });
});

describe("initializeUserCredits on an existing account", () => {
  it("leaves balance, bonus and reserved alone", async () => {
    const repo = await repoWith({ tier: "free", balance: 25, bonusCredits: 10 });
    await hold(repo, 20);

    const again = await repo.initializeUserCredits(USER, "free", 25);

    expect(again).toMatchObject({ balance: 25, bonusCredits: 10, reserved: 20 });
    expect(await repo.getUserCredits(USER)).toMatchObject({
      balance: 25,
      bonusCredits: 10,
      reserved: 20,
    });
  });
});

describe("balance plans", () => {
  it("a target floored by holds marks what the floor kept", () => {
    expect(planBalanceTarget(25, 80, 0)).toEqual({ balance: 80, expiredHoldBacking: 55 });
    expect(planBalanceTarget(100, 80, 0)).toEqual({ balance: 100, expiredHoldBacking: 0 });
  });

  it("a cap marks only what stays above it", () => {
    expect(planBalanceCap(100, 0, 80, 0)).toEqual({ balance: 80, expiredHoldBacking: 80 });
    expect(planBalanceCap(100, 25, 0, 0)).toEqual({ balance: 25, expiredHoldBacking: 0 });
    expect(planBalanceCap(10, 25, 5, 0)).toEqual({ balance: 10, expiredHoldBacking: 0 });
  });

  it("a cap never raises an underbacked balance", () => {
    expect(planBalanceCap(10, 0, 50, 0)).toEqual({ balance: 10, expiredHoldBacking: 10 });
  });

  it("a second cap changes nothing", () => {
    const first = planBalanceCap(100, 20, 80, 0);
    expect(planBalanceCap(first.balance, 20, 80, 0, first.expiredHoldBacking)).toEqual(first);
  });
});

describe("allocateExpiredBacking", () => {
  const row = (id: string, amount: number, placed: number) => ({
    id,
    amount,
    holdPlacedAt: new Date(placed).toISOString(),
  });
  const shares = (holds: ReturnType<typeof row>[], total: number) => {
    const { frontier } = allocateExpiredBacking(holds, total);
    return Object.fromEntries(holds.map((hold) => [hold.id, holdExpiredBacking(hold, frontier)]));
  };

  it("fills the oldest hold first and caps each at its amount", () => {
    expect(shares([row("b", 30, 2), row("a", 50, 1), row("c", 20, 3)], 60)).toEqual({
      a: 50,
      b: 10,
      c: 0,
    });
  });

  it("orders holds placed in the same millisecond by id", () => {
    expect(shares([row("b", 30, 1), row("a", 50, 1)], 60)).toEqual({ a: 50, b: 10 });
  });

  it("extends the prefix when the total rises, so nothing moves between holds", () => {
    const holds = [row("a", 50, 1), row("b", 30, 2)];
    expect(shares(holds, 30)).toEqual({ a: 30, b: 0 });
    expect(shares(holds, 60)).toEqual({ a: 50, b: 10 });
  });

  it("trims the newest when the total falls", () => {
    expect(shares([row("a", 50, 1), row("b", 30, 2)], 55)).toEqual({ a: 50, b: 5 });
  });

  it("gives a row without holdPlacedAt nothing", () => {
    const record = { id: "record", amount: 90 };
    const { frontier, total } = allocateExpiredBacking([record, row("a", 10, 1)], 10);
    expect(total).toBe(10);
    expect(frontier).toMatchObject({ id: "a", share: 10 });
    expect(holdExpiredBacking(record, frontier)).toBe(0);
  });

  it("keeps marks the holds cannot carry, so a close frees nothing it should not", () => {
    const { total, frontier } = allocateExpiredBacking([row("a", 10, 1)], 40);
    expect(total).toBe(40);
    expect(frontier).toMatchObject({ id: "a", share: 10 });
    expect(allocateExpiredBacking([], 40)).toEqual({
      total: 40,
      frontier: NO_EXPIRED_BACKING_PREFIX,
    });
    expect(allocateExpiredBacking([], 0)).toEqual({ total: 0, frontier: null });
  });
});

describe("planHoldCommit", () => {
  it("pays its own share, then spendable, then bonus", () => {
    // Balance 50 = 30 spendable + 20 marked, of which this hold owns 5.
    expect(planHoldCommit(50, 100, 20, 5, 45)).toEqual({
      covered: true,
      balance: 15,
      bonusCredits: 90,
      expiredHoldBacking: 15,
    });
  });

  it("refuses when spendable and bonus cannot pay, without touching other shares", () => {
    expect(planHoldCommit(20, 5, 20, 0, 10).covered).toBe(false);
  });

  it("matches the plain drain when nothing is marked", () => {
    expect(planHoldCommit(30, 50, 0, 0, 40)).toEqual({
      covered: true,
      balance: 0,
      bonusCredits: 40,
      expiredHoldBacking: 0,
    });
  });
});

describe("expired credits backing a hold (memory)", () => {
  async function expired(amounts = { balance: 100, held: 80, cap: 0 }) {
    const repo = await repoWith(
      { tier: "premium", balance: amounts.balance },
      { getDowngradeBalanceCap: () => amounts.cap }
    );
    await repo.updateUserCredits(USER, { subscriptionExpiresAt: LONG_EXPIRED });
    const reservationId = await hold(repo, amounts.held);
    expect((await repo.checkAndHandleSubscriptionExpiry(USER, 3)).wasDowngraded).toBe(true);
    return { repo, reservationId };
  }

  it("a later hold whose clock runs behind still takes no share", async () => {
    const { repo, reservationId } = await expired();
    await repo.updateUserCredits(USER, { bonusCreditsIncrement: 100 });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 86_400_000 });
    let later: string;
    try {
      later = await hold(repo, 10);
    } finally {
      vi.useRealTimers();
    }

    await repo.releaseReservationV2(USER, later);
    expect(await repo.getUserCredits(USER)).toMatchObject({ balance: 80, expiredHoldBacking: 80 });
    await repo.commitReservationV2(USER, reservationId);

    expect(await repo.getUserCredits(USER)).toMatchObject({
      balance: 0,
      bonusCredits: 100,
      expiredHoldBacking: 0,
    });
  });

  it("a release leaves none of them spendable", async () => {
    const { repo, reservationId } = await expired();
    expect(await repo.getUserCredits(USER)).toMatchObject({
      balance: 80,
      reserved: 80,
      expiredHoldBacking: 80,
    });

    await repo.releaseReservationV2(USER, reservationId);

    expect(await repo.getUserCredits(USER)).toMatchObject({
      balance: 0,
      reserved: 0,
      expiredHoldBacking: 0,
    });
  });

  it("an expiry leaves none of them spendable", async () => {
    const { repo, reservationId } = await expired();

    await repo.expireReservationV2(USER, reservationId, {
      asOf: new Date(Date.now() + 120_000),
    });

    expect((await repo.getUserCredits(USER))!.balance).toBe(0);
  });

  it("a commit consumes them", async () => {
    const { repo, reservationId } = await expired();

    expect((await repo.commitReservationV2(USER, reservationId)).outcome).toBe("committed");

    expect(await repo.getUserCredits(USER)).toMatchObject({ balance: 0, expiredHoldBacking: 0 });
  });

  it("the cap survives a release", async () => {
    const { repo, reservationId } = await expired({ balance: 100, held: 80, cap: 20 });

    await repo.releaseReservationV2(USER, reservationId);

    expect((await repo.getUserCredits(USER))!.balance).toBe(20);
  });

  it("balanceCap marks them too", async () => {
    const repo = await repoWith({ tier: "premium", balance: 100 });
    const reservationId = await hold(repo, 80);

    await repo.updateUserTier(USER, { tier: "free", monthlyLimit: 0, balanceCap: 0 });
    await repo.releaseReservationV2(USER, reservationId);

    expect((await repo.getUserCredits(USER))!.balance).toBe(0);
  });

  it("an account without them keeps no field", async () => {
    const repo = await repoWith({ tier: "premium", balance: 100 });
    const reservationId = await hold(repo, 80);

    await repo.releaseReservationV2(USER, reservationId);

    const credits = await repo.getUserCredits(USER);
    expect(credits!.balance).toBe(100);
    expect(credits).not.toHaveProperty("expiredHoldBacking");
  });

  it("an absolute balance clears the mark", async () => {
    const { repo, reservationId } = await expired();
    await repo.updateUserCredits(USER, { balance: 200 });

    await repo.releaseReservationV2(USER, reservationId);

    expect((await repo.getUserCredits(USER))!.balance).toBe(200);
  });

  it("a reset resolver sees spendable credits, and keeping them keeps the mark", async () => {
    const seen: number[] = [];
    const repo = await repoWith(
      { tier: "premium", balance: 100 },
      {
        getDowngradeBalanceCap: () => 20,
        resolveMonthlyReset: ({ balance }) => {
          seen.push(balance);
          return { balance };
        },
      }
    );
    await repo.updateUserCredits(USER, { subscriptionExpiresAt: LONG_EXPIRED });
    const reservationId = await hold(repo, 80);
    await repo.checkAndHandleSubscriptionExpiry(USER, 3);

    await repo.atomicMonthlyReset(USER, "free", PAST_DUE);

    expect(seen).toEqual([20]);
    await repo.releaseReservationV2(USER, reservationId);
    expect((await repo.getUserCredits(USER))!.balance).toBe(20);
  });
});
