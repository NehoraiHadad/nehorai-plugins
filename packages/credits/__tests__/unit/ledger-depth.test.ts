/**
 * The ledger depth audit (2.3.0), run on the in-memory repository. Each block states
 * the defect it pins. The Firestore side is in
 * `credits-firestore/__tests__/ledger-depth.emulator.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CreditErrorCode,
  CreditsService,
  createInMemoryCreditRepository,
  heldExpiredBacking,
  multiplyAmount,
  spendableBalance,
} from "../../src/index.js";

const USER = "u1";
const OP = "story_generation";
const soon = () => new Date(Date.now() + 60_000);

const stored = (repo: unknown) => (repo as any).store.users.get(USER);
const holdsOf = (repo: unknown) => (repo as any).store.reservations.get(USER);

async function hold(repo: any, amount: number): Promise<string> {
  const made = await repo.reserveCreditsV2({
    userId: USER,
    amount,
    operationType: OP,
    expiresAt: soon(),
  });
  if (made.outcome !== "created") throw new Error(made.outcome);
  return made.reservation.id;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("item 1: 0 <= expiredHoldBacking <= balance", () => {
  it("the increment of the report is refused, so it never stored -10", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "premium", 100);
    await hold(repo, 80);
    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 500, balanceCap: 0 });
    await repo.updateUserCredits(USER, { bonusCreditsIncrement: 100 });

    await expect(repo.updateUserCredits(USER, { balanceIncrement: -90 })).rejects.toThrow(
      "Balance cannot be negative"
    );
    expect(stored(repo)).toMatchObject({ balance: 80, expiredHoldBacking: 80 });
  });

  it("reads a bad stored value as nothing held", () => {
    expect(heldExpiredBacking(20, -10)).toBe(0);
    expect(heldExpiredBacking(20, Number.NaN)).toBe(0);
    expect(heldExpiredBacking(20, undefined)).toBe(0);
    expect(heldExpiredBacking(20, 30)).toBe(20);
    expect(heldExpiredBacking(-5, 30)).toBe(0);
    expect(spendableBalance(20, -10)).toBe(20);
  });

  it("a stored -10 mints nothing through reserve and release", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "premium", 0);
    stored(repo).expiredHoldBacking = -10;
    await repo.updateUserCredits(USER, { bonusCreditsIncrement: 100 });

    for (let i = 0; i < 3; i += 1) {
      const id = await hold(repo, 10);
      await repo.releaseReservationV2(USER, id);
      expect(stored(repo).balance).toBe(0);
    }
    expect(stored(repo).expiredHoldBacking).toBe(0);
  });

  it("a stored -10 does not raise a reset that keeps the balance", async () => {
    const repo = createInMemoryCreditRepository({
      resolveMonthlyReset: ({ balance }) => ({ balance }),
    });
    await repo.initializeUserCredits(USER, "premium", 20);
    stored(repo).expiredHoldBacking = -10;

    for (let i = 0; i < 2; i += 1) {
      const result = await repo.atomicMonthlyReset(USER, "premium", stored(repo).monthlyResetAt);
      expect(result).toMatchObject({ wasReset: true });
      expect(stored(repo).balance).toBe(20);
    }
    expect(stored(repo).expiredHoldBacking).toBe(0);
  });

  it("a stored -10 does not let a deduct spend what is not there, and is healed", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "premium", 20);
    stored(repo).expiredHoldBacking = -10;

    await expect(repo.deductCreditsAtomic(USER, 25)).rejects.toThrow("Insufficient");
    await repo.deductCreditsAtomic(USER, 5);
    expect(stored(repo)).toMatchObject({ balance: 15, expiredHoldBacking: 0 });
  });

  it("a stored value above the balance closes without going negative", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "premium", 50);
    const id = await hold(repo, 50);
    Object.assign(stored(repo), { expiredHoldBacking: 80 });

    await repo.releaseReservationV2(USER, id);

    expect(stored(repo)).toMatchObject({ balance: 0, reserved: 0, expiredHoldBacking: 0 });
  });

  it("a top-up does not grow a value that was already above the balance", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "premium", 50);
    await hold(repo, 50);
    Object.assign(stored(repo), { expiredHoldBacking: 80 });

    await repo.updateUserCredits(USER, { balanceIncrement: 10 });

    expect(stored(repo)).toMatchObject({ balance: 60, expiredHoldBacking: 50 });
  });

  it("a negative absolute balance on a tier write is refused, not marked", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "premium", 100);
    await expect(
      repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 500, balance: -10 })
    ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });
    expect(stored(repo).balance).toBe(100);
    expect(stored(repo).expiredHoldBacking).toBeUndefined();
  });
});

describe("item 2: an account whose marks were never attributed", () => {
  /**
   * Balance 80, 60 of it marked, two old holds with no share recorded, bonus 100.
   * The new hold comes from a server whose clock lags 5 seconds behind the old holds.
   */
  async function legacyAccount(thenCap = false) {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T00:00:10.000Z") });
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "premium", 80);
    const a = await hold(repo, 50);
    vi.setSystemTime(new Date("2026-11-01T00:00:10.002Z"));
    const b = await hold(repo, 30);
    await repo.updateUserCredits(USER, { bonusCreditsIncrement: 100 });
    Object.assign(stored(repo), { expiredHoldBacking: 60 });

    vi.setSystemTime(new Date("2026-11-01T00:00:05.000Z"));
    const lagged = await hold(repo, 10);
    vi.setSystemTime(new Date("2026-11-01T00:00:20.000Z"));
    if (thenCap) {
      await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 500, balanceCap: 20 });
    }
    return { repo, a, b, lagged };
  }

  it("the lagged hold takes none of the old backing and is placed after it", async () => {
    const { repo, a, b, lagged } = await legacyAccount();
    const placed = (id: string) => holdsOf(repo).get(id).holdPlacedAt;
    expect(placed(lagged) > placed(a)).toBe(true);
    expect(placed(lagged) > placed(b)).toBe(true);
    expect(stored(repo).expiredBackingFrontier).toMatchObject({ id: b, share: 10 });
  });

  it.each([
    ["without a later cap", false],
    ["with a later attribution by a cap", true],
  ])("the old holds carry the 60 and the total is 110 (%s)", async (_name, thenCap) => {
    const { repo, a, b, lagged } = await legacyAccount(thenCap);

    await repo.commitReservationV2(USER, lagged);
    await repo.releaseReservationV2(USER, a);
    await repo.releaseReservationV2(USER, b);

    // The hold pays from spendable before bonus: 20 was spendable, so 10 of it pays
    // the hold, and the 60 marked leave with the two old holds.
    expect(stored(repo)).toMatchObject({
      balance: 10,
      bonusCredits: 100,
      reserved: 0,
      expiredHoldBacking: 0,
    });
  });
});

describe("item 3: the marks are held on one document", () => {
  it("a lowering write touches no hold", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "premium", 100);
    const ids = [await hold(repo, 50), await hold(repo, 30)];
    const before = ids.map((id) => JSON.stringify(holdsOf(repo).get(id)));

    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 500, balanceCap: 20 });

    expect(stored(repo).expiredHoldBacking).toBe(60);
    expect(ids.map((id) => JSON.stringify(holdsOf(repo).get(id)))).toEqual(before);
  });

  it("a hold document left with a 2.2.0 share is ignored", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "premium", 80);
    const a = await hold(repo, 50);
    const b = await hold(repo, 30);
    await repo.updateUserCredits(USER, { bonusCreditsIncrement: 100 });
    Object.assign(stored(repo), { expiredHoldBacking: 60 });
    Object.assign(holdsOf(repo).get(a), { expiredBacking: 50 });
    Object.assign(holdsOf(repo).get(b), { expiredBacking: 10 });

    await repo.releaseReservationV2(USER, a);
    await repo.releaseReservationV2(USER, b);

    expect(stored(repo)).toMatchObject({ balance: 20, bonusCredits: 100, expiredHoldBacking: 0 });
  });
});

describe("item 4: an event carries before and after, in the step that moved the credits", () => {
  const lastEntry = async (repo: any) => (await repo.getJournalEntries({ userId: USER }))[0];

  it("every transition records balance + bonus on both sides", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "premium", 100);
    await repo.updateUserCredits(USER, { bonusCreditsIncrement: 5 });
    await repo.addCreditsAtomic(USER, 10, "top up");
    expect(await lastEntry(repo)).toMatchObject({ balanceBefore: 105, balanceAfter: 115 });

    const committed = await hold(repo, 40);
    const outcome = await repo.commitReservationV2(USER, committed);
    expect(outcome).toMatchObject({ balanceAfter: 75 });
    const entries = await repo.getJournalEntries({ userId: USER, source: "operation_commit" });
    expect(entries[0]).toMatchObject({ balanceBefore: 115, balanceAfter: 75 });
  });

  it("a release that removes expired credits shows them leaving", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "premium", 100);
    const id = await hold(repo, 80);
    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 500, balanceCap: 0 });

    await repo.releaseReservationV2(USER, id);

    const entries = await repo.getJournalEntries({ userId: USER, source: "operation_release" });
    expect(entries[0]).toMatchObject({ balanceBefore: 80, balanceAfter: 0 });
  });

  it("a reset and a downgrade record both sides", async () => {
    const repo = createInMemoryCreditRepository({ getDowngradeBalanceCap: () => 0 });
    await repo.initializeUserCredits(USER, "premium", 100);
    await repo.updateUserCredits(USER, {
      bonusCreditsIncrement: 5,
      subscriptionExpiresAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
    });
    const expired = await repo.checkAndHandleSubscriptionExpiry(USER, 3);
    expect(expired).toMatchObject({ wasDowngraded: true, journaled: true });
    const entries = await repo.getJournalEntries({
      userId: USER,
      source: "subscription_downgrade",
    });
    expect(entries[0]).toMatchObject({ balanceBefore: 105, balanceAfter: 5 });
  });

  it("a journal failure cannot lose the line of a service deduct", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "premium", 100);
    const service = new CreditsService(repo);
    const direct = vi
      .spyOn(repo, "createJournalEntry")
      .mockRejectedValue(new Error("journal is down"));

    const result = await service.deductCredits(USER, 30, { requestId: "req-1" });

    expect(result).toMatchObject({ success: true, newBalance: 70 });
    expect(direct).not.toHaveBeenCalled();
    expect(stored(repo).balance).toBe(70);
    expect(await lastEntry(repo)).toMatchObject({
      referenceId: "req-1",
      balanceBefore: 100,
      balanceAfter: 70,
    });
  });
});

describe("item 5: whole-unit arithmetic", () => {
  it("multiplies a price in cents", () => {
    expect(1.1 * 3).not.toBe(3.3); // the premise
    expect(multiplyAmount(1.1, 3)).toBe(3.3);
    expect(multiplyAmount(0.07, 100)).toBe(7);
    expect(multiplyAmount(5, 0)).toBe(0);
  });

  it.each([
    ["an off-grid price", 1.005, 2],
    ["a negative price", -1, 2],
    ["a fractional quantity", 1, 1.5],
    ["a negative quantity", 1, -1],
    ["a result out of range", 9_999_999_999.99, 2],
  ])("refuses %s", (_name, unit, quantity) => {
    expect(() => multiplyAmount(unit, quantity)).toThrow(
      expect.objectContaining({ code: CreditErrorCode.INVALID_AMOUNT })
    );
  });

  it("a computed price reserves, where the float refuses", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(USER, "premium", 100);
    await expect(
      repo.reserveCreditsV2({ userId: USER, amount: 1.1 * 3, operationType: OP, expiresAt: soon() })
    ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });
    await expect(hold(repo, multiplyAmount(1.1, 3))).resolves.toBeTruthy();
  });
});
