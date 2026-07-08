/**
 * Tests for CreditsService.addCredits — crediting a user's balance and the
 * optional journal customization (source / referenceType / metadata) that lets
 * a single journal double as the app's revenue ledger.
 */
import { describe, it, expect } from "vitest";
import { CreditsService, createInMemoryCreditRepository } from "../../src";

describe("CreditsService.addCredits", () => {
  it("adds bonus credits and journals a default 'purchase' credit entry", async () => {
    const repo = createInMemoryCreditRepository();
    const service = new CreditsService(repo);
    await repo.initializeUserCredits("u1", "free", 0);

    await service.addCredits("u1", 50, "Credit package", "pay-1");

    const credits = await repo.getUserCredits("u1");
    expect(credits?.bonusCredits).toBe(50);

    const entries = await repo.getJournalEntries({ userId: "u1" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: "credit",
      amount: 50,
      balanceAfter: 50,
      source: "purchase",
      referenceType: "transaction",
      metadata: { paymentRef: "pay-1" },
    });
  });

  it("forwards source + referenceType + metadata onto the journal entry", async () => {
    const repo = createInMemoryCreditRepository();
    const service = new CreditsService(repo);
    await repo.initializeUserCredits("u2", "free", 0);

    await service.addCredits("u2", 100, "Monthly subscription", "pay-2", {
      source: "subscription_grant",
      referenceType: "subscription",
      metadata: {
        grossAmountMinor: 3990,
        creditsGranted: 100,
        revenueSource: "subscription_cycle",
      },
    });

    const entries = await repo.getJournalEntries({ userId: "u2" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: "credit",
      amount: 100,
      source: "subscription_grant",
      referenceType: "subscription",
      metadata: {
        // paymentRef is merged in alongside the caller-supplied metadata
        paymentRef: "pay-2",
        grossAmountMinor: 3990,
        creditsGranted: 100,
        revenueSource: "subscription_cycle",
      },
    });
  });

  it("omits journal metadata entirely when neither paymentRef nor metadata is given", async () => {
    const repo = createInMemoryCreditRepository();
    const service = new CreditsService(repo);
    await repo.initializeUserCredits("u3", "free", 0);

    await service.addCredits("u3", 10, "Admin grant", undefined, {
      source: "admin_adjustment",
    });

    const entries = await repo.getJournalEntries({ userId: "u3" });
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("admin_adjustment");
    expect(entries[0].metadata).toBeUndefined();
  });
});
