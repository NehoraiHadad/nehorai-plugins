import { describe, it, expect, vi } from "vitest";
import {
  createGenericAdapter,
  createInMemoryCreditRepository,
  type ICreditsAuthProvider,
  type DeferredExecutor,
  type PortableReservation,
} from "../../src";

function createTestAdapter(operationCosts: Record<string, number>) {
  const repo = createInMemoryCreditRepository();
  const authProvider: ICreditsAuthProvider = {
    getCurrentUser: async () => ({ id: "user-1", email: "test@test.com" }),
  };
  const deferred: DeferredExecutor = {
    defer: (fn) => { fn().catch(() => {}); },
  };

  return { adapter: createGenericAdapter({ repository: repo, authProvider, deferred, operationCosts }), repo };
}

describe("Generic adapter", () => {
  it("throws on unknown operation type instead of silently returning cost=0", async () => {
    const { adapter } = createTestAdapter({ story_generation: 5 });

    const wrappedAction = adapter.withCredits(
      { operationType: "nonexistent_type" },
      async () => ({ success: true, data: "ok" }),
    );

    const result = await wrappedAction({});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown operation type");
    expect(result.error).toContain("nonexistent_type");
  });

  it("works correctly with a known operation type", async () => {
    const { adapter, repo } = createTestAdapter({ story_generation: 5 });
    await repo.initializeUserCredits("user-1", "free", 25);

    const wrappedAction = adapter.withCredits(
      { operationType: "story_generation" },
      async () => ({ success: true, data: "result" }),
    );

    const result = await wrappedAction({});
    expect(result.success).toBe(true);
    expect(result.data).toBe("result");
  });

  describe("an operation configured with a cost of 0", () => {
    const USER = "user-1";

    async function ledgerOf(repo: ReturnType<typeof createInMemoryCreditRepository>) {
      const credits = await repo.getUserCredits(USER);
      const journal = await repo.getJournalEntries({ userId: USER });
      return { credits, journal };
    }

    it("runs the handler and leaves the ledger untouched", async () => {
      const { adapter, repo } = createTestAdapter({ free_op: 0 });
      await repo.initializeUserCredits(USER, "free", 25);
      const before = await ledgerOf(repo);

      let seenReservation: PortableReservation | undefined;
      const wrappedAction = adapter.withCredits(
        { operationType: "free_op" },
        async (_user, _data, reservation) => {
          seenReservation = reservation;
          return { success: true, data: "ran" };
        },
      );

      const result = await wrappedAction({});

      expect(result).toEqual({ success: true, data: "ran" });
      expect(seenReservation?.id).toBe("free-operation");
      expect(seenReservation?.amount).toBe(0);
      expect(await repo.getReservation(USER, "free-operation")).toBeNull();
      expect(await ledgerOf(repo)).toEqual(before);
    });

    it("needs no balance, or even a credits row", async () => {
      const { adapter, repo } = createTestAdapter({ free_op: 0 });

      const result = await adapter.withCredits(
        { operationType: "free_op" },
        async () => ({ success: true, data: "ran" }),
      )({});

      expect(result.success).toBe(true);
      expect(await repo.getUserCredits(USER)).toBeNull();
    });

    it("logs usage with 0 credits", async () => {
      const { adapter, repo } = createTestAdapter({ free_op: 0 });

      await adapter.withCredits(
        { operationType: "free_op" },
        async () => ({ success: true, data: "ran" }),
      )({});
      await new Promise((resolve) => setTimeout(resolve, 0));

      const [log] = await repo.getUsageLogs({ userId: USER });
      expect(log.operationType).toBe("free_op");
      expect(log.creditsUsed).toBe(0);
      expect(log.success).toBe(true);
    });

    it("reports a failed handler without touching the ledger", async () => {
      const { adapter, repo } = createTestAdapter({ free_op: 0 });
      await repo.initializeUserCredits(USER, "free", 25);
      const before = await ledgerOf(repo);

      const result = await adapter.withCredits(
        { operationType: "free_op" },
        async () => ({ success: false, error: "nope" }),
      )({});

      expect(result).toEqual({ success: false, error: "nope" });
      expect(await ledgerOf(repo)).toEqual(before);
    });

    it("reports a thrown handler without touching the ledger", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const { adapter, repo } = createTestAdapter({ free_op: 0 });
      await repo.initializeUserCredits(USER, "free", 25);
      const before = await ledgerOf(repo);

      const result = await adapter.withCredits({ operationType: "free_op" }, async () => {
        throw new Error("kaboom");
      })({});

      expect(result).toEqual({ success: false, error: "kaboom" });
      expect(await ledgerOf(repo)).toEqual(before);
      consoleError.mockRestore();
    });

    it("still requires authentication", async () => {
      const repo = createInMemoryCreditRepository();
      const handler = vi.fn();
      const adapter = createGenericAdapter({
        repository: repo,
        authProvider: { getCurrentUser: async () => null },
        deferred: { defer: () => {} },
        operationCosts: { free_op: 0 },
      });

      const result = await adapter.withCredits({ operationType: "free_op" }, handler)({});

      expect(result.success).toBe(false);
      expect(handler).not.toHaveBeenCalled();
    });

    it("charges when customCost overrides it", async () => {
      const { adapter, repo } = createTestAdapter({ free_op: 0 });
      await repo.initializeUserCredits(USER, "free", 25);

      await adapter.withCredits(
        { operationType: "free_op", customCost: 5 },
        async () => ({ success: true, data: "ran" }),
      )({});

      expect((await repo.getUserCredits(USER))?.balance).toBe(20);
    });
  });

  it("refuses customCost: 0 instead of running a charged operation for nothing", async () => {
    const { adapter, repo } = createTestAdapter({ story_generation: 5 });
    await repo.initializeUserCredits("user-1", "free", 25);
    const handler = vi.fn();

    const result = await adapter.withCredits(
      { operationType: "story_generation", customCost: 0 },
      handler,
    )({});

    expect(result.success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a negative cost without running the handler", async () => {
    const { adapter, repo } = createTestAdapter({ bad_op: -1 });
    await repo.initializeUserCredits("user-1", "free", 25);
    const handler = vi.fn();

    const result = await adapter.withCredits({ operationType: "bad_op" }, handler)({});

    expect(result.success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
