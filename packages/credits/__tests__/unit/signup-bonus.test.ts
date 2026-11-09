/**
 * A signup gift passed as `signupBonus` lands in `bonusCredits`, so the writes that
 * replace or cap `balance` (a tier raise, a tier cap, the expiry downgrade) keep it.
 * Passed as `initialBalance`, the legacy way, it landed in `balance` and the first
 * subscription replaced it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CreditErrorCode,
  CreditsService,
  createInMemoryCreditRepository,
  signupGrantJournalInput,
  signupJournalInput,
} from "../../src";

const USER = "u1";

function setup() {
  const repo = createInMemoryCreditRepository({ getDowngradeBalanceCap: () => 0 });
  const lines = () => repo.getJournalEntries({ userId: USER });
  const credits = async () => (await repo.getUserCredits(USER))!;
  return { repo, lines, credits };
}

describe("initializeUserCredits with signupBonus", () => {
  it("stores the bonus in bonusCredits and the allotment in balance", async () => {
    const { repo, credits } = setup();

    const created = await repo.initializeUserCredits(USER, "free", 0, { signupBonus: 65 });

    expect(created).toMatchObject({ balance: 0, bonusCredits: 65 });
    expect(await credits()).toMatchObject({ balance: 0, bonusCredits: 65 });
  });

  it("journals one line: the total, with the buckets split in metadata", async () => {
    const { repo, lines } = setup();

    await repo.initializeUserCredits(USER, "free", 10, { signupBonus: 65 });

    expect(await lines()).toEqual([
      expect.objectContaining({
        entryType: "credit",
        amount: 75,
        balanceBefore: 0,
        balanceAfter: 75,
        source: "bonus",
        referenceId: `signup-${USER}`,
        referenceType: "adjustment",
        metadata: { tier: "free", buckets: { balance: 10, bonus: 65 } },
      }),
    ]);
  });

  it("writes the bonus alone when the allotment is 0", async () => {
    const { repo, lines } = setup();

    await repo.initializeUserCredits(USER, "free", 0, { signupBonus: 65 });

    expect(await lines()).toEqual([
      expect.objectContaining({
        amount: 65,
        balanceBefore: 0,
        balanceAfter: 65,
        metadata: { tier: "free", buckets: { balance: 0, bonus: 65 } },
      }),
    ]);
  });

  it("a bonus of 0 writes the allotment alone", async () => {
    const { repo, lines, credits } = setup();

    await repo.initializeUserCredits(USER, "free", 25, { signupBonus: 0 });

    expect(await credits()).toMatchObject({ balance: 25, bonusCredits: 0 });
    expect(await lines()).toEqual([
      expect.objectContaining({
        amount: 25,
        balanceAfter: 25,
        metadata: { tier: "free", buckets: { balance: 25, bonus: 0 } },
      }),
    ]);
  });

  it("an allotment and a bonus of 0 write no line", async () => {
    const { repo, lines } = setup();

    await repo.initializeUserCredits(USER, "free", 0, { signupBonus: 0 });

    expect(await lines()).toEqual([]);
  });

  describe("with the clock frozen, so every line shares a timestamp", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("the latest usage-history line shows the full total", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-11-09T10:00:00.000Z"));
      const { repo } = setup();
      const service = new CreditsService(repo);

      await repo.initializeUserCredits(USER, "free", 10, { signupBonus: 65 });
      const history = await service.getUsageHistory(USER, 1);

      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ balanceAfter: 75, creditsChange: 75 });
    });
  });

  it("an existing account keeps its credits and gets no line", async () => {
    const { repo, lines, credits } = setup();
    await repo.initializeUserCredits(USER, "free", 0, { signupBonus: 65 });

    await repo.initializeUserCredits(USER, "free", 0, { signupBonus: 65 });

    expect(await credits()).toMatchObject({ balance: 0, bonusCredits: 65 });
    expect(await lines()).toHaveLength(1);
  });

  it.each([-1, 0.005, Number.NaN])("refuses a bonus of %s and writes nothing", async (bonus) => {
    const { repo, lines } = setup();

    await expect(
      repo.initializeUserCredits(USER, "free", 0, { signupBonus: bonus })
    ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });

    expect(await repo.getUserCredits(USER)).toBeNull();
    expect(await lines()).toEqual([]);
  });

  it("without signupBonus, the legacy call is unchanged", async () => {
    const { repo, lines, credits } = setup();

    await repo.initializeUserCredits(USER, "free", 25);

    expect(await credits()).toMatchObject({ balance: 25, bonusCredits: 0 });
    expect(await lines()).toEqual([
      expect.objectContaining({ amount: 25, metadata: { tier: "free" } }),
    ]);
    expect(signupJournalInput(USER, "free", 25)).toEqual(
      signupGrantJournalInput(USER, "free", 25)
    );
    expect(signupJournalInput(USER, "free", 25)).toEqual({
      userId: USER,
      entryType: "credit",
      amount: 25,
      balanceBefore: 0,
      balanceAfter: 25,
      source: "bonus",
      referenceId: `signup-${USER}`,
      referenceType: "adjustment",
      description: "Signup grant for free tier.",
      metadata: { tier: "free" },
    });
  });
});

describe("the signup bonus survives what replaces the balance", () => {
  async function spentAccount() {
    const context = setup();
    await context.repo.initializeUserCredits(USER, "free", 0, { signupBonus: 65 });
    await context.repo.deductCreditsAtomic(USER, 20);
    expect(await context.credits()).toMatchObject({ balance: 0, bonusCredits: 45 });
    return context;
  }

  it("a tier raise to 100 gives balance 100, bonus 45, total 145", async () => {
    const { repo, credits } = await spentAccount();

    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 100, balance: 100 });

    const after = await credits();
    expect(after).toMatchObject({ balance: 100, bonusCredits: 45 });
    expect(after.balance + after.bonusCredits).toBe(145);
  });

  it("a renewal that replaces the balance keeps bonus 45", async () => {
    const { repo, credits } = await spentAccount();
    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 100, balance: 100 });
    await repo.deductCreditsAtomic(USER, 30);

    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 100, balance: 100 });

    expect(await credits()).toMatchObject({ balance: 100, bonusCredits: 45 });
  });

  it("the expiry downgrade caps the balance and keeps bonus 45", async () => {
    const { repo, credits } = await spentAccount();
    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 100, balance: 100 });
    await repo.updateUserCredits(USER, {
      subscriptionExpiresAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
    });

    const result = await repo.checkAndHandleSubscriptionExpiry(USER);

    expect(result.wasDowngraded).toBe(true);
    expect(await credits()).toMatchObject({ tier: "free", balance: 0, bonusCredits: 45 });
  });

  it("a tier cap keeps bonus 45", async () => {
    const { repo, credits } = await spentAccount();
    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 100, balance: 100 });

    await repo.updateUserTier(USER, { tier: "free", monthlyLimit: 0, balanceCap: 0 });

    expect(await credits()).toMatchObject({ balance: 0, bonusCredits: 45 });
  });

  it("the legacy call loses the gift at the first raise", async () => {
    const { repo, credits } = setup();
    await repo.initializeUserCredits(USER, "free", 65);
    await repo.deductCreditsAtomic(USER, 20);

    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 100, balance: 100 });

    expect(await credits()).toMatchObject({ balance: 100, bonusCredits: 0 });
  });
});
