/**
 * Unit tests for @nehorai/credits-nextjs
 * Tests the Next.js adapter for the credits system
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createWithCredits,
  createNextJsDeferredExecutor,
  NextAuthCreditsProvider,
  createNextAuthCreditsProvider,
  createCreditsWrapperFactory,
  createInMemoryCreditRepository,
  type ICreditsAuthProvider,
  type CreditsUser,
  type DeferredExecutor,
  type WithCreditsConfig,
} from "../src";

// =============================================================================
// Test Helpers
// =============================================================================

function createMockUser(overrides?: Partial<CreditsUser>): CreditsUser {
  return {
    id: "test-user-123",
    email: "test@example.com",
    name: "Test User",
    ...overrides,
  };
}

function createMockAuthProvider(user: CreditsUser | null = null): {
  provider: ICreditsAuthProvider;
  mocks: {
    getCurrentUser: ReturnType<typeof vi.fn>;
    verifyAdminAccess: ReturnType<typeof vi.fn>;
  };
} {
  const mocks = {
    getCurrentUser: vi.fn().mockResolvedValue(user),
    verifyAdminAccess: vi.fn().mockResolvedValue(false),
  };

  const provider: ICreditsAuthProvider = {
    getCurrentUser: mocks.getCurrentUser,
    verifyAdminAccess: mocks.verifyAdminAccess,
  };

  return { provider, mocks };
}

function createTestConfig(
  authProvider: ICreditsAuthProvider,
  repository = createInMemoryCreditRepository()
): WithCreditsConfig {
  return {
    repository,
    authProvider,
    deferred: {
      defer: vi.fn((fn) => fn().catch(() => {})),
    },
    operationCosts: {
      story_generation: 5,
      image_generation: 10,
    },
  };
}

// =============================================================================
// createNextJsDeferredExecutor Tests
// =============================================================================

describe("createNextJsDeferredExecutor", () => {
  it("creates a deferred executor that calls the provided after function", () => {
    const mockAfter = vi.fn();
    const executor = createNextJsDeferredExecutor(mockAfter);

    const fn = vi.fn().mockResolvedValue(undefined);
    executor.defer(fn);

    expect(mockAfter).toHaveBeenCalledWith(fn);
  });

  it("passes async functions directly to after()", () => {
    const mockAfter = vi.fn();
    const executor = createNextJsDeferredExecutor(mockAfter);

    const asyncFn = async () => {
      // do something
    };
    executor.defer(asyncFn);

    expect(mockAfter).toHaveBeenCalledWith(asyncFn);
  });
});

// =============================================================================
// NextAuthCreditsProvider Tests
// =============================================================================

describe("NextAuthCreditsProvider", () => {
  describe("getCurrentUser", () => {
    it("returns user from getCurrentUser function", async () => {
      const mockUser = { id: "user-123", email: "test@example.com", name: "Test" };
      const provider = createNextAuthCreditsProvider({
        getCurrentUser: vi.fn().mockResolvedValue(mockUser),
      });

      const result = await provider.getCurrentUser();

      expect(result).toEqual({
        id: "user-123",
        email: "test@example.com",
        name: "Test",
      });
    });

    it("returns null when getCurrentUser returns null", async () => {
      const provider = createNextAuthCreditsProvider({
        getCurrentUser: vi.fn().mockResolvedValue(null),
      });

      const result = await provider.getCurrentUser();

      expect(result).toBeNull();
    });

    it("returns null when user has no id", async () => {
      const provider = createNextAuthCreditsProvider({
        getCurrentUser: vi.fn().mockResolvedValue({ email: "test@example.com" }),
      });

      const result = await provider.getCurrentUser();

      expect(result).toBeNull();
    });

    it("handles null email and name", async () => {
      const provider = createNextAuthCreditsProvider({
        getCurrentUser: vi.fn().mockResolvedValue({ id: "user-123" }),
      });

      const result = await provider.getCurrentUser();

      expect(result).toEqual({
        id: "user-123",
        email: null,
        name: null,
      });
    });
  });

  describe("verifyAdminAccess", () => {
    it("returns true for admin user IDs", async () => {
      const provider = createNextAuthCreditsProvider({
        getCurrentUser: vi.fn().mockResolvedValue({ id: "admin-123" }),
        adminUsers: ["admin-123", "admin-456"],
      });

      const result = await provider.verifyAdminAccess("admin-123");

      expect(result).toBe(true);
    });

    it("returns true for admin emails", async () => {
      const provider = createNextAuthCreditsProvider({
        getCurrentUser: vi.fn().mockResolvedValue({
          id: "user-123",
          email: "admin@example.com",
        }),
        adminUsers: ["admin@example.com"],
      });

      const result = await provider.verifyAdminAccess("user-123");

      expect(result).toBe(true);
    });

    it("returns false for non-admin users", async () => {
      const provider = createNextAuthCreditsProvider({
        getCurrentUser: vi.fn().mockResolvedValue({
          id: "user-123",
          email: "user@example.com",
        }),
        adminUsers: ["admin@example.com"],
      });

      const result = await provider.verifyAdminAccess("user-123");

      expect(result).toBe(false);
    });

    it("accepts Set for adminUsers", async () => {
      const provider = createNextAuthCreditsProvider({
        getCurrentUser: vi.fn().mockResolvedValue({ id: "admin-123" }),
        adminUsers: new Set(["admin-123"]),
      });

      const result = await provider.verifyAdminAccess("admin-123");

      expect(result).toBe(true);
    });
  });
});

// =============================================================================
// createWithCredits Tests
// =============================================================================

describe("createWithCredits", () => {
  let repository: ReturnType<typeof createInMemoryCreditRepository>;
  let mockAuthProvider: ReturnType<typeof createMockAuthProvider>;
  let config: WithCreditsConfig;

  beforeEach(async () => {
    repository = createInMemoryCreditRepository();
    mockAuthProvider = createMockAuthProvider(createMockUser());
    config = createTestConfig(mockAuthProvider.provider, repository);

    // Initialize user with credits
    await repository.initializeUserCredits("test-user-123", "free", 100);
  });

  it("creates a withCredits function", () => {
    const withCredits = createWithCredits(config);
    expect(typeof withCredits).toBe("function");
  });

  describe("withCredits", () => {
    it("returns error if not authenticated", async () => {
      mockAuthProvider.mocks.getCurrentUser.mockResolvedValue(null);

      const withCredits = createWithCredits(config);
      const action = withCredits(
        { operationType: "story_generation" },
        async () => ({ success: true, data: "result" })
      );

      const result = await action({});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Authentication required");
      }
    });

    it("reserves credits before executing action", async () => {
      const actionFn = vi.fn().mockResolvedValue({ success: true, data: "result" });

      const withCredits = createWithCredits(config);
      const action = withCredits(
        { operationType: "story_generation" },
        actionFn
      );

      await action({ input: "test" });

      // Action should be called with user, data, and reservation
      expect(actionFn).toHaveBeenCalled();
      const [user, data, reservation] = actionFn.mock.calls[0];
      expect(user.id).toBe("test-user-123");
      expect(data).toEqual({ input: "test" });
      expect(reservation.amount).toBe(5); // story_generation cost
    });

    it("commits reservation on success", async () => {
      const withCredits = createWithCredits(config);
      const action = withCredits(
        { operationType: "story_generation" },
        async () => ({ success: true, data: "result" })
      );

      const result = await action({});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("result");
      }

      // Credits should be deducted
      const credits = await repository.getUserCredits("test-user-123");
      expect(credits?.balance).toBeLessThan(100);
    });

    it("releases reservation on action failure", async () => {
      const withCredits = createWithCredits(config);
      const action = withCredits(
        { operationType: "story_generation" },
        async () => ({ success: false, error: "Action failed" })
      );

      const result = await action({});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Action failed");
      }

      // Credits should NOT be deducted (reservation released)
      const credits = await repository.getUserCredits("test-user-123");
      expect(credits?.balance).toBe(100);
    });

    it("releases reservation on exception", async () => {
      const withCredits = createWithCredits(config);
      const action = withCredits(
        { operationType: "story_generation" },
        async () => {
          throw new Error("Unexpected error");
        }
      );

      const result = await action({});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe("Unexpected error");
      }

      // Credits should NOT be deducted (reservation released)
      const credits = await repository.getUserCredits("test-user-123");
      expect(credits?.balance).toBe(100);
    });

    it("uses custom cost when provided", async () => {
      const actionFn = vi.fn().mockResolvedValue({ success: true, data: "result" });

      const withCredits = createWithCredits(config);
      const action = withCredits(
        { operationType: "story_generation", customCost: 25 },
        actionFn
      );

      await action({});

      // Reservation should have custom cost
      const [, , reservation] = actionFn.mock.calls[0];
      expect(reservation.amount).toBe(25);
    });

    it("returns error when insufficient credits", async () => {
      // Update user to have only 3 credits
      await repository.updateUserCredits("test-user-123", { balance: 3 });

      const withCredits = createWithCredits(config);
      const action = withCredits(
        { operationType: "story_generation" }, // costs 5
        async () => ({ success: true, data: "result" })
      );

      const result = await action({});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Insufficient");
      }
    });

    it("handles preview mode - skips credit reservation", async () => {
      const actionFn = vi.fn().mockResolvedValue({ success: true, data: "preview result" });

      const withCredits = createWithCredits(config);
      const action = withCredits(
        { operationType: "story_generation" },
        actionFn
      );

      const result = await action({ preview: true });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("preview result");
      }

      // Action should be called with dummy reservation
      const [, , reservation] = actionFn.mock.calls[0];
      expect(reservation.id).toBe("preview-mode");
      expect(reservation.amount).toBe(0);

      // Credits should NOT be changed
      const credits = await repository.getUserCredits("test-user-123");
      expect(credits?.balance).toBe(100);
    });
  });
});

// =============================================================================
// createCreditsWrapperFactory Tests
// =============================================================================

describe("createCreditsWrapperFactory", () => {
  let repository: ReturnType<typeof createInMemoryCreditRepository>;
  let mockAuthProvider: ReturnType<typeof createMockAuthProvider>;
  let config: WithCreditsConfig;

  beforeEach(async () => {
    repository = createInMemoryCreditRepository();
    mockAuthProvider = createMockAuthProvider(createMockUser());
    config = createTestConfig(mockAuthProvider.provider, repository);

    await repository.initializeUserCredits("test-user-123", "free", 100);
  });

  it("creates a wrapper factory function", () => {
    const factory = createCreditsWrapperFactory(config);
    expect(typeof factory).toBe("function");
  });

  it("creates operation-specific wrappers with default options", async () => {
    const factory = createCreditsWrapperFactory(config);

    const withStoryCredits = factory({ operationType: "story_generation" });
    const actionFn = vi.fn().mockResolvedValue({ success: true, data: "story" });

    const action = withStoryCredits(actionFn);
    await action({});

    const [, , reservation] = actionFn.mock.calls[0];
    expect(reservation.operationType).toBe("story_generation");
  });

  it("allows overriding default options", async () => {
    const factory = createCreditsWrapperFactory(config);

    const withImageCredits = factory({
      operationType: "image_generation",
      resourceType: "image",
    });
    const actionFn = vi.fn().mockResolvedValue({ success: true, data: "image" });

    const action = withImageCredits(actionFn, { customCost: 20 });
    await action({});

    const [, , reservation] = actionFn.mock.calls[0];
    expect(reservation.amount).toBe(20);
  });
});
