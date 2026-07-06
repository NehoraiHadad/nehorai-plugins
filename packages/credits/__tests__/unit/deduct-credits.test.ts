/**
 * Tests for CreditsService.deductCredits — the one-shot atomic
 * "deduct-if-sufficient" charge (as opposed to the reserve/commit/release
 * two-phase flow).
 */
import { describe, it, expect } from "vitest";
import {
  CreditsService,
  createInMemoryCreditRepository,
} from "../../src";

describe("CreditsService.deductCredits", () => {
  it("deducts on success and returns the new balance", async () => {
    const repo = createInMemoryCreditRepository();
    const service = new CreditsService(repo);
    await repo.initializeUserCredits("u-success", "free", 25);

    const result = await service.deductCredits("u-success", 10, {
      operationType: "story_generation",
    });

    expect(result).toEqual({ success: true, newBalance: 15 });

    const credits = await repo.getUserCredits("u-success");
    expect(credits?.balance).toBe(15);
  });

  it("creates a journal entry on success", async () => {
    const repo = createInMemoryCreditRepository();
    const service = new CreditsService(repo);
    await repo.initializeUserCredits("u-journal", "free", 25);

    await service.deductCredits("u-journal", 5, {
      operationType: "story_generation",
      metadata: { foo: "bar" },
    });

    const entries = await repo.getJournalEntries({ userId: "u-journal" });
    expect(entries).toHaveLength(1);
    expect(entries[0].entryType).toBe("debit");
    expect(entries[0].amount).toBe(5);
    expect(entries[0].balanceAfter).toBe(20);
    expect(entries[0].description).toBe("Deducted 5 credits for Story generation");
    expect(entries[0].metadata).toMatchObject({
      operationType: "story_generation",
      foo: "bar",
    });
  });

  it("logs usage on success when operationType is provided (same path as commitCredits)", async () => {
    const repo = createInMemoryCreditRepository();
    const service = new CreditsService(repo);
    await repo.initializeUserCredits("u-usage-log", "free", 25);

    await service.deductCredits("u-usage-log", 5, {
      operationType: "story_generation",
      resourceId: "res-1",
      resourceType: "story",
      requestId: "req-1",
      metadata: { note: "test" },
    });

    const logs = await repo.getUsageLogs({ userId: "u-usage-log" });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      userId: "u-usage-log",
      operationType: "story_generation",
      creditsUsed: 5,
      success: true,
      resourceId: "res-1",
      resourceType: "story",
      requestId: "req-1",
    });
  });

  it("does not log usage when operationType is omitted", async () => {
    const repo = createInMemoryCreditRepository();
    const service = new CreditsService(repo);
    await repo.initializeUserCredits("u-no-op-type", "free", 25);

    await service.deductCredits("u-no-op-type", 5);

    const logs = await repo.getUsageLogs({ userId: "u-no-op-type" });
    expect(logs).toHaveLength(0);

    // Journal entry is still recorded even without an operation type.
    const entries = await repo.getJournalEntries({ userId: "u-no-op-type" });
    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe("Deducted 5 credits");
  });

  it("returns a typed failure on insufficient balance without mutating it", async () => {
    const repo = createInMemoryCreditRepository();
    const service = new CreditsService(repo);
    await repo.initializeUserCredits("u-insufficient", "free", 5);

    const result = await service.deductCredits("u-insufficient", 10, {
      operationType: "image_generation",
    });

    expect(result).toEqual({
      success: false,
      reason: "insufficient",
      available: 5,
      required: 10,
      shortfall: 5,
    });

    const credits = await repo.getUserCredits("u-insufficient");
    expect(credits?.balance).toBe(5); // unchanged

    const entries = await repo.getJournalEntries({ userId: "u-insufficient" });
    expect(entries).toHaveLength(0); // no audit trail written on failure

    const logs = await repo.getUsageLogs({ userId: "u-insufficient" });
    expect(logs).toHaveLength(0);
  });

  it("accounts for reserved credits when computing availability", async () => {
    const repo = createInMemoryCreditRepository();
    const service = new CreditsService(repo);
    await repo.initializeUserCredits("u-reserved", "free", 10);

    // Reserve 4, leaving only 6 available.
    await service.reserveCredits("u-reserved", 4, "story_generation");

    const result = await service.deductCredits("u-reserved", 8);

    expect(result).toEqual({
      success: false,
      reason: "insufficient",
      available: 6,
      required: 8,
      shortfall: 2,
    });
  });

  it("only allows one of two concurrent deducts when funds cover exactly one", async () => {
    const repo = createInMemoryCreditRepository();
    const service = new CreditsService(repo);
    await repo.initializeUserCredits("u-concurrent", "free", 10);

    const [first, second] = await Promise.all([
      service.deductCredits("u-concurrent", 10),
      service.deductCredits("u-concurrent", 10),
    ]);

    const results = [first, second];
    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const credits = await repo.getUserCredits("u-concurrent");
    expect(credits?.balance).toBe(0);
  });

  it.each([0, -1, -10])(
    "throws when amount is not positive (%i)",
    async (amount) => {
      const repo = createInMemoryCreditRepository();
      const service = new CreditsService(repo);
      await repo.initializeUserCredits("u-invalid-amount", "free", 25);

      await expect(service.deductCredits("u-invalid-amount", amount)).rejects.toThrow(
        "deductCredits amount must be positive"
      );

      const credits = await repo.getUserCredits("u-invalid-amount");
      expect(credits?.balance).toBe(25); // unchanged
    }
  );
});
