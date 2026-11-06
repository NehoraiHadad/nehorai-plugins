/**
 * The journal lines of the two writes that used to move a balance without one: creating
 * an account with its signup grant, and a tier write.
 */
import { describe, expect, it } from "vitest";
import {
  CreditErrorCode,
  CreditsService,
  createInMemoryCreditRepository,
  getConfig,
  getUnlimitedSentinelBalance,
  signupGrantJournalInput,
  tierChangeJournalInput,
} from "../../src";

const USER = "u1";

function setup() {
  const repo = createInMemoryCreditRepository();
  return { repo, service: new CreditsService(repo) };
}

const lines = (repo: ReturnType<typeof setup>["repo"]) => repo.getJournalEntries({ userId: USER });

describe("the signup grant", () => {
  it("getOrCreateUserCredits journals the grant the balance starts with", async () => {
    const { repo, service } = setup();

    const credits = await service.getOrCreateUserCredits(USER);

    const grant = getConfig().defaultFreeCredits;
    expect(credits.balance).toBe(grant);
    expect(await lines(repo)).toEqual([
      expect.objectContaining({
        userId: USER,
        entryType: "credit",
        amount: grant,
        balanceBefore: 0,
        balanceAfter: grant,
        source: "bonus",
        referenceId: `signup-${USER}`,
        referenceType: "adjustment",
      }),
    ]);
  });

  it("writes one line across repeated and concurrent creation", async () => {
    const { repo, service } = setup();

    await Promise.all([
      service.getOrCreateUserCredits(USER),
      service.getOrCreateUserCredits(USER),
      repo.initializeUserCredits(USER, "free", 25),
    ]);
    await service.getOrCreateUserCredits(USER);
    await repo.initializeUserCredits(USER, "free", 25);

    expect(await lines(repo)).toHaveLength(1);
  });

  it("writes no line for a grant of 0", async () => {
    const { repo } = setup();

    await repo.initializeUserCredits(USER, "free", 0);

    expect(await lines(repo)).toEqual([]);
    expect(signupGrantJournalInput(USER, "free", 0)).toBeNull();
  });

  it("writes no line when a negative grant is refused", async () => {
    const { repo } = setup();

    await expect(repo.initializeUserCredits(USER, "free", -1)).rejects.toMatchObject({
      code: CreditErrorCode.INVALID_AMOUNT,
    });

    expect(await lines(repo)).toEqual([]);
  });

  it("journals the seed under a first credit, so the two lines chain", async () => {
    const { repo } = setup();

    await repo.addCreditsAtomic(USER, 10, "first credit");

    const entries = await lines(repo);
    const seed = entries.find((entry) => entry.source === "bonus")!;
    const credit = entries.find((entry) => entry.source === "purchase")!;
    expect(entries).toHaveLength(2);
    expect(seed.balanceBefore).toBe(0);
    expect(credit.balanceBefore).toBe(seed.balanceAfter);
  });
});

describe("a tier write", () => {
  async function account(balance: number, bonusCredits = 0) {
    const context = setup();
    await context.repo.initializeUserCredits(USER, "free", balance);
    if (bonusCredits > 0) await context.repo.updateUserCredits(USER, { bonusCredits });
    const signup = await lines(context.repo);
    return { ...context, signup: signup.length };
  }

  it("journals a raise like a grant: credit, the balance it set", async () => {
    const { repo, signup } = await account(25);

    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 100, balance: 100 });

    const entries = await lines(repo);
    expect(entries).toHaveLength(signup + 1);
    expect(entries.find((entry) => entry.source === "subscription_upgrade")).toMatchObject({
      entryType: "credit",
      amount: 100,
      balanceBefore: 25,
      balanceAfter: 100,
      referenceType: "subscription",
      metadata: { previousTier: "free", newTier: "premium", previousBalance: 25, newBalance: 100 },
    });
  });

  it("journals a cut like a downgrade: debit, amount 0, the totals moved", async () => {
    const { repo, signup } = await account(100);
    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 500 });

    await repo.updateUserTier(USER, { tier: "free", monthlyLimit: 25, balanceCap: 25 });

    const entries = await lines(repo);
    expect(entries).toHaveLength(signup + 1);
    expect(entries.find((entry) => entry.source === "subscription_downgrade")).toMatchObject({
      entryType: "debit",
      amount: 0,
      balanceBefore: 100,
      balanceAfter: 25,
    });
  });

  it("records totals with bonus credits and without subtracting reserved", async () => {
    const { repo } = await account(25, 10);
    const held = await repo.reserveCreditsAtomic(
      USER,
      5,
      "audio_generation",
      new Date(Date.now() + 60_000)
    );
    expect(held.amount).toBe(5);

    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 100, balance: 100 });

    const line = (await lines(repo)).find((entry) => entry.source === "subscription_upgrade");
    expect(line).toMatchObject({ amount: 100, balanceBefore: 35, balanceAfter: 110 });
  });

  it("journals the balance the holds floored, not the one requested", async () => {
    const { repo, signup } = await account(100);
    await repo.reserveCreditsAtomic(USER, 80, "audio_generation", new Date(Date.now() + 60_000));

    await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 500, balance: 25 });

    expect(await lines(repo)).toHaveLength(signup + 1);
    const line = (await lines(repo)).find((entry) => entry.source === "subscription_downgrade");
    expect(line).toMatchObject({ balanceBefore: 100, balanceAfter: 80 });
  });

  it.each([
    ["no balance in the write", { tier: "premium", monthlyLimit: 500 }],
    ["the same balance", { tier: "premium", monthlyLimit: 500, balance: 25 }],
    ["a cap above the balance", { tier: "premium", monthlyLimit: 500, balanceCap: 100 }],
  ])("writes no line with %s", async (_name, input) => {
    const { repo, signup } = await account(25);
    await repo.updateUserCredits(USER, { tier: "standard" });

    await repo.updateUserTier(USER, input);

    expect(await lines(repo)).toHaveLength(signup);
  });

  it("writes no line for a cap on an account already free", async () => {
    const { repo, signup } = await account(100);

    await repo.updateUserTier(USER, { tier: "free", monthlyLimit: 25, balanceCap: 25 });

    expect((await repo.getUserCredits(USER))?.balance).toBe(100);
    expect(await lines(repo)).toHaveLength(signup);
  });

  it("refuses before writing when the total cannot be recorded", async () => {
    const { repo, signup } = await account(25, 9_999_999_999);

    await expect(
      repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 100, balance: 100 })
    ).rejects.toMatchObject({ code: CreditErrorCode.INVALID_AMOUNT });

    expect(await repo.getUserCredits(USER)).toMatchObject({ tier: "free", balance: 25 });
    expect(await lines(repo)).toHaveLength(signup);
  });

  it("CreditsService.updateTier journals an upgrade once, with the tier's allotment", async () => {
    const { repo, service, signup } = await account(25);

    await service.updateTier(USER, "premium");

    const credits = await repo.getUserCredits(USER);
    const entries = await lines(repo);
    expect(entries).toHaveLength(signup + 1);
    expect(entries.find((entry) => entry.source === "subscription_upgrade")).toMatchObject({
      amount: credits?.balance,
      balanceBefore: 25,
      balanceAfter: credits?.balance,
    });
  });

  it("CreditsService.updateTier records the unlimited sentinel it sets", async () => {
    const { repo, service } = await account(25);

    await service.updateTier(USER, "unlimited");

    const line = (await lines(repo)).find((entry) => entry.source === "subscription_upgrade");
    expect(line?.balanceAfter).toBe(getUnlimitedSentinelBalance());
  });

  it("the expiry downgrade writes its own line and no second one", async () => {
    const { repo, service, signup } = await account(100);
    await repo.updateUserCredits(USER, {
      tier: "premium",
      subscriptionExpiresAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
    });

    await service.getUserCredits(USER);

    const entries = await lines(repo);
    expect(entries.filter((entry) => entry.source === "subscription_downgrade")).toHaveLength(1);
    expect(entries).toHaveLength(signup + 1);
  });

  describe("in the usage history", () => {
    const change = async (service: CreditsService, description: string) =>
      (await service.getUsageHistory(USER)).entries.find((entry) =>
        entry.description.startsWith(description)
      )?.creditsChange;

    it("a raise from 25 to 100 shows +75, though its amount is 100", async () => {
      const { repo, service } = await account(25);

      await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 100, balance: 100 });

      expect(await change(service, "Tier changed")).toBe(75);
    });

    it("a cut from 100 to 25 shows -75, though its amount is 0", async () => {
      const { repo, service } = await account(100);
      await repo.updateUserTier(USER, { tier: "premium", monthlyLimit: 500 });

      await repo.updateUserTier(USER, { tier: "free", monthlyLimit: 25, balanceCap: 25 });

      expect(await change(service, "Tier changed from premium")).toBe(-75);
    });

    it.each([
      ["debit", -10],
      ["credit", 10],
    ] as const)("a %s line with no balanceBefore keeps its signed amount", async (entryType, shown) => {
      const { repo, service } = await account(25);
      await repo.createJournalEntry({
        userId: USER,
        entryType,
        amount: 10,
        balanceAfter: 25,
        source: "admin_adjustment",
        referenceId: "legacy",
        referenceType: "adjustment",
        description: "Legacy line",
      });

      expect(await change(service, "Legacy line")).toBe(shown);
    });
  });

  it("tierChangeJournalInput returns null when the balance did not move", () => {
    expect(
      tierChangeJournalInput({
        userId: USER,
        previousTier: "free",
        newTier: "premium",
        previousBalance: 0.3,
        newBalance: 0.3,
        bonusCredits: 0,
      })
    ).toBeNull();
  });
});
