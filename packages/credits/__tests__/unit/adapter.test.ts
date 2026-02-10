import { describe, it, expect } from "vitest";
import {
  createGenericAdapter,
  createInMemoryCreditRepository,
  type ICreditsAuthProvider,
  type DeferredExecutor,
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
});
