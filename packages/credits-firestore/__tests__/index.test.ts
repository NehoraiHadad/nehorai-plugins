/**
 * Unit tests for @nehorai/credits-firestore
 * Tests the Firestore repository implementation utilities and path helpers
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  // Timestamp utilities
  timestampToISO,
  timestampToDate,
  toISOString,
  toDate,
  // Path helpers
  getUserCreditsPath,
  getUserTransactionsPath,
  getUserReservationsPath,
  getUserJournalPath,
  // State machine
  isValidTransition,
  getValidNextStates,
  isTerminalState,
  validateTransition,
  // Validation
  validateBalanceUpdate,
  assertValidBalanceUpdate,
  // Credit calculations (re-exported from core)
  calculateAvailableCredits,
  // In-memory repository for interface testing
  createInMemoryCreditRepository,
  // Factory function
  createFirestoreCreditRepository,
  FirestoreCreditRepository,
  // Constants
  COLLECTIONS,
  BALANCE_DOC_ID,
  DEFAULT_FREE_CREDITS,
} from "../src";

// =============================================================================
// Timestamp Utilities Tests
// =============================================================================

describe("Timestamp Utilities", () => {
  describe("timestampToISO", () => {
    it("converts Firestore Timestamp to ISO string", () => {
      const date = new Date("2024-01-15T10:30:00.000Z");
      const firestoreTimestamp = {
        toDate: () => date,
      };

      const result = timestampToISO(firestoreTimestamp);
      expect(result).toBe("2024-01-15T10:30:00.000Z");
    });

    it("handles Date objects", () => {
      const date = new Date("2024-01-15T10:30:00.000Z");
      const result = timestampToISO(date);
      expect(result).toBe("2024-01-15T10:30:00.000Z");
    });

    it("handles ISO strings (passthrough)", () => {
      const isoString = "2024-01-15T10:30:00.000Z";
      const result = timestampToISO(isoString);
      expect(result).toBe(isoString);
    });

    it("handles null/undefined with current date", () => {
      const before = new Date().toISOString();
      const result = timestampToISO(null);
      const after = new Date().toISOString();

      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(result >= before).toBe(true);
      expect(result <= after).toBe(true);
    });
  });

  describe("timestampToDate", () => {
    it("converts Firestore Timestamp to Date", () => {
      const expectedDate = new Date("2024-01-15T10:30:00.000Z");
      const firestoreTimestamp = {
        toDate: () => expectedDate,
      };

      const result = timestampToDate(firestoreTimestamp);
      expect(result).toEqual(expectedDate);
    });

    it("handles Date objects (passthrough)", () => {
      const date = new Date("2024-01-15T10:30:00.000Z");
      const result = timestampToDate(date);
      expect(result).toEqual(date);
    });

    it("handles ISO strings", () => {
      const isoString = "2024-01-15T10:30:00.000Z";
      const result = timestampToDate(isoString);
      expect(result.toISOString()).toBe(isoString);
    });
  });

  describe("toISOString (shared utility)", () => {
    it("converts Firestore Timestamp", () => {
      const date = new Date("2024-06-01T12:00:00.000Z");
      const timestamp = { toDate: () => date };
      expect(toISOString(timestamp)).toBe("2024-06-01T12:00:00.000Z");
    });

    it("converts Date", () => {
      const date = new Date("2024-06-01T12:00:00.000Z");
      expect(toISOString(date)).toBe("2024-06-01T12:00:00.000Z");
    });

    it("passes through strings", () => {
      expect(toISOString("2024-06-01T12:00:00.000Z")).toBe("2024-06-01T12:00:00.000Z");
    });
  });

  describe("toDate (shared utility)", () => {
    it("returns same Date for Date input", () => {
      const date = new Date("2024-06-01T12:00:00.000Z");
      expect(toDate(date)).toBe(date);
    });

    it("parses string to Date", () => {
      const result = toDate("2024-06-01T12:00:00.000Z");
      expect(result.toISOString()).toBe("2024-06-01T12:00:00.000Z");
    });

    it("converts Firestore Timestamp", () => {
      const date = new Date("2024-06-01T12:00:00.000Z");
      const timestamp = { toDate: () => date };
      expect(toDate(timestamp)).toBe(date);
    });
  });
});

// =============================================================================
// Path Utilities Tests
// =============================================================================

describe("Path Utilities", () => {
  it("generates correct user credits path", () => {
    expect(getUserCreditsPath("user-123")).toBe("users/user-123/credits");
  });

  it("generates correct user transactions path", () => {
    expect(getUserTransactionsPath("user-123")).toBe("users/user-123/transactions");
  });

  it("generates correct user reservations path", () => {
    expect(getUserReservationsPath("user-123")).toBe("users/user-123/reservations");
  });

  it("generates correct user journal path", () => {
    expect(getUserJournalPath("user-123")).toBe("users/user-123/credits/data/journal");
  });

  it("handles special characters in user IDs", () => {
    expect(getUserCreditsPath("user@example.com")).toBe("users/user@example.com/credits");
  });
});

// =============================================================================
// Constants Tests
// =============================================================================

describe("Constants", () => {
  it("exports COLLECTIONS constant", () => {
    expect(COLLECTIONS).toBeDefined();
    expect(COLLECTIONS.users).toBe("users");
    expect(COLLECTIONS.credits).toBe("credits");
    expect(COLLECTIONS.transactions).toBe("transactions");
    expect(COLLECTIONS.reservations).toBe("reservations");
  });

  it("exports BALANCE_DOC_ID constant", () => {
    expect(BALANCE_DOC_ID).toBe("balance");
  });

  it("exports DEFAULT_FREE_CREDITS constant", () => {
    expect(DEFAULT_FREE_CREDITS).toBe(25);
  });
});

// =============================================================================
// Credit Calculation Tests
// =============================================================================

describe("calculateAvailableCredits", () => {
  it("calculates available credits correctly", () => {
    // balance + bonusCredits - reserved
    expect(calculateAvailableCredits(100, 50, 20)).toBe(130);
  });

  it("handles zero values", () => {
    expect(calculateAvailableCredits(0, 0, 0)).toBe(0);
  });

  it("handles high reserved values (negative result)", () => {
    expect(calculateAvailableCredits(100, 50, 200)).toBe(-50);
  });

  it("handles only balance", () => {
    expect(calculateAvailableCredits(100, 0, 0)).toBe(100);
  });

  it("handles only bonus credits", () => {
    expect(calculateAvailableCredits(0, 100, 0)).toBe(100);
  });
});

// =============================================================================
// State Machine Tests
// =============================================================================

describe("Reservation State Machine", () => {
  describe("isValidTransition", () => {
    // Initial state is "reserved" (not "pending")
    it("allows reserved -> committed", () => {
      expect(isValidTransition("reserved", "committed")).toBe(true);
    });

    it("allows reserved -> released", () => {
      expect(isValidTransition("reserved", "released")).toBe(true);
    });

    it("allows reserved -> expired", () => {
      expect(isValidTransition("reserved", "expired")).toBe(true);
    });

    it("disallows committed -> released", () => {
      expect(isValidTransition("committed", "released")).toBe(false);
    });

    it("disallows released -> committed", () => {
      expect(isValidTransition("released", "committed")).toBe(false);
    });

    it("disallows expired -> committed", () => {
      expect(isValidTransition("expired", "committed")).toBe(false);
    });

    it("disallows same state transition", () => {
      expect(isValidTransition("reserved", "reserved")).toBe(false);
    });
  });

  describe("validateTransition", () => {
    it("does not throw for valid transition", () => {
      expect(() => {
        validateTransition("reserved", "committed", "res-123");
      }).not.toThrow();
    });

    it("throws for invalid transition", () => {
      expect(() => {
        validateTransition("committed", "released", "res-123");
      }).toThrow("Invalid reservation transition");
    });
  });

  describe("getValidNextStates", () => {
    it("returns valid next states for reserved", () => {
      const nextStates = getValidNextStates("reserved");
      expect(nextStates).toContain("committed");
      expect(nextStates).toContain("released");
      expect(nextStates).toContain("expired");
    });

    it("returns empty array for committed (terminal)", () => {
      expect(getValidNextStates("committed")).toEqual([]);
    });

    it("returns empty array for released (terminal)", () => {
      expect(getValidNextStates("released")).toEqual([]);
    });

    it("returns empty array for expired (terminal)", () => {
      expect(getValidNextStates("expired")).toEqual([]);
    });
  });

  describe("isTerminalState", () => {
    it("returns true for committed", () => {
      expect(isTerminalState("committed")).toBe(true);
    });

    it("returns true for released", () => {
      expect(isTerminalState("released")).toBe(true);
    });

    it("returns true for expired", () => {
      expect(isTerminalState("expired")).toBe(true);
    });

    it("returns false for reserved", () => {
      expect(isTerminalState("reserved")).toBe(false);
    });
  });
});

// =============================================================================
// Validation Tests
// =============================================================================

describe("Balance Validation", () => {
  // Create a default current state for testing
  const defaultCurrent = {
    userId: "user-123",
    balance: 100,
    bonusCredits: 50,
    reserved: 10,
    tier: "free" as const,
    monthlyLimit: 25,
    monthlyUsed: 0,
    monthlyResetAt: new Date().toISOString(),
    subscriptionExpiresAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  describe("validateBalanceUpdate", () => {
    it("validates correct balance update", () => {
      const result = validateBalanceUpdate(defaultCurrent, {
        balance: 90,
      });
      expect(result.valid).toBe(true);
    });

    it("rejects negative balance", () => {
      const result = validateBalanceUpdate(defaultCurrent, {
        balance: -10,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("negative"))).toBe(true);
    });

    it("rejects reserved exceeding balance", () => {
      const result = validateBalanceUpdate(defaultCurrent, {
        balance: 5,
        reserved: 20,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("exceeds"))).toBe(true);
    });

    it("validates balance increment", () => {
      const result = validateBalanceUpdate(defaultCurrent, {
        balanceIncrement: -50,
      });
      expect(result.valid).toBe(true);
    });

    it("validates empty update", () => {
      const result = validateBalanceUpdate(defaultCurrent, {});
      expect(result.valid).toBe(true);
    });
  });

  describe("assertValidBalanceUpdate", () => {
    it("does not throw for valid update", () => {
      expect(() => {
        assertValidBalanceUpdate(defaultCurrent, { balance: 90 });
      }).not.toThrow();
    });

    it("throws for invalid update", () => {
      expect(() => {
        assertValidBalanceUpdate(defaultCurrent, { balance: -10 });
      }).toThrow("Invalid balance update");
    });
  });
});

// =============================================================================
// In-Memory Repository Tests (interface validation)
// =============================================================================

describe("InMemoryCreditRepository (interface validation)", () => {
  let repo: ReturnType<typeof createInMemoryCreditRepository>;

  beforeEach(() => {
    repo = createInMemoryCreditRepository();
  });

  describe("User Credits", () => {
    it("initializes user credits", async () => {
      const credits = await repo.initializeUserCredits("user-123", "free", 25);

      expect(credits.userId).toBe("user-123");
      expect(credits.balance).toBe(25);
      expect(credits.tier).toBe("free");
      expect(credits.bonusCredits).toBe(0);
      expect(credits.reserved).toBe(0);
    });

    it("gets user credits after initialization", async () => {
      await repo.initializeUserCredits("user-123", "free", 25);
      const credits = await repo.getUserCredits("user-123");

      expect(credits).not.toBeNull();
      expect(credits?.userId).toBe("user-123");
    });

    it("returns null for non-existent user", async () => {
      const credits = await repo.getUserCredits("non-existent");
      expect(credits).toBeNull();
    });

    it("updates user credits", async () => {
      await repo.initializeUserCredits("user-123", "free", 25);
      await repo.updateUserCredits("user-123", { bonusCredits: 100 });

      const credits = await repo.getUserCredits("user-123");
      expect(credits?.bonusCredits).toBe(100);
    });

    it("updates user tier", async () => {
      await repo.initializeUserCredits("user-123", "free", 25);
      await repo.updateUserTier("user-123", {
        tier: "premium",
        monthlyLimit: 500,
      });

      const credits = await repo.getUserCredits("user-123");
      expect(credits?.tier).toBe("premium");
      expect(credits?.monthlyLimit).toBe(500);
    });
  });

  describe("Reservations", () => {
    beforeEach(async () => {
      await repo.initializeUserCredits("user-123", "free", 100);
    });

    it("creates reservation atomically", async () => {
      const expiresAt = new Date(Date.now() + 60000);
      const reservation = await repo.reserveCreditsAtomic(
        "user-123",
        10,
        "story_generation",
        expiresAt
      );

      expect(reservation.id).toBeDefined();
      expect(reservation.amount).toBe(10);
      expect(reservation.operationType).toBe("story_generation");
      expect(reservation.status).toBe("reserved");
    });

    it("increments reserved credits when reserving", async () => {
      const expiresAt = new Date(Date.now() + 60000);
      await repo.reserveCreditsAtomic("user-123", 10, "story_generation", expiresAt);

      const credits = await repo.getUserCredits("user-123");
      expect(credits?.reserved).toBe(10);
    });

    it("commits reservation atomically", async () => {
      const expiresAt = new Date(Date.now() + 60000);
      const reservation = await repo.reserveCreditsAtomic(
        "user-123",
        10,
        "story_generation",
        expiresAt
      );

      await repo.commitReservationAtomic("user-123", reservation.id);

      const updatedReservation = await repo.getReservation("user-123", reservation.id);
      expect(updatedReservation?.status).toBe("committed");

      const credits = await repo.getUserCredits("user-123");
      expect(credits?.reserved).toBe(0);
      expect(credits?.balance).toBeLessThan(100);
    });

    it("releases reservation atomically", async () => {
      const expiresAt = new Date(Date.now() + 60000);
      const reservation = await repo.reserveCreditsAtomic(
        "user-123",
        10,
        "story_generation",
        expiresAt
      );

      await repo.releaseReservationAtomic("user-123", reservation.id);

      const updatedReservation = await repo.getReservation("user-123", reservation.id);
      expect(updatedReservation?.status).toBe("released");

      const credits = await repo.getUserCredits("user-123");
      expect(credits?.reserved).toBe(0);
      expect(credits?.balance).toBe(100); // No deduction
    });

    it("fails to reserve with insufficient credits", async () => {
      const expiresAt = new Date(Date.now() + 60000);

      await expect(
        repo.reserveCreditsAtomic("user-123", 200, "story_generation", expiresAt)
      ).rejects.toThrow();
    });
  });

  describe("Transactions", () => {
    beforeEach(async () => {
      await repo.initializeUserCredits("user-123", "free", 100);
    });

    it("adds credits atomically", async () => {
      await repo.addCreditsAtomic("user-123", 50, "Bonus credits", "payment-123");

      const credits = await repo.getUserCredits("user-123");
      expect(credits?.bonusCredits).toBe(50);
    });

    it("creates transaction record", async () => {
      await repo.createTransaction({
        userId: "user-123",
        amount: 25,
        type: "credit_purchase",
        description: "Purchased credits",
      });

      const transactions = await repo.getTransactions("user-123");
      expect(transactions.length).toBeGreaterThan(0);
      expect(transactions[0].amount).toBe(25);
    });
  });

  describe("Usage Logs", () => {
    it("logs usage", async () => {
      const log = await repo.logUsage({
        userId: "user-123",
        operationType: "story_generation",
        provider: "gemini",
        creditsUsed: 5,
        success: true,
        requestId: "req-123",
      });

      expect(log.id).toBeDefined();
      expect(log.operationType).toBe("story_generation");
      expect(log.creditsUsed).toBe(5);
    });

    it("queries usage logs", async () => {
      await repo.logUsage({
        userId: "user-123",
        operationType: "story_generation",
        provider: "gemini",
        creditsUsed: 5,
        success: true,
        requestId: "req-123",
      });

      const logs = await repo.getUsageLogs({ userId: "user-123" });
      expect(logs.length).toBe(1);
    });

    it("counts usage logs", async () => {
      await repo.logUsage({
        userId: "user-123",
        operationType: "story_generation",
        provider: "gemini",
        creditsUsed: 5,
        success: true,
        requestId: "req-123",
      });
      await repo.logUsage({
        userId: "user-123",
        operationType: "image_generation",
        provider: "gemini",
        creditsUsed: 10,
        success: true,
        requestId: "req-124",
      });

      const count = await repo.getUsageLogsCount({ userId: "user-123" });
      expect(count).toBe(2);
    });
  });

  describe("Journal Entries", () => {
    beforeEach(async () => {
      await repo.initializeUserCredits("user-123", "free", 100);
    });

    it("creates journal entry", async () => {
      const entry = await repo.createJournalEntry({
        userId: "user-123",
        entryType: "debit",
        amount: 10,
        balanceAfter: 90,
        source: "operation_commit",
        description: "Credits deducted",
      });

      expect(entry.id).toBeDefined();
      expect(entry.entryType).toBe("debit");
      expect(entry.amount).toBe(10);
    });

    it("queries journal entries", async () => {
      await repo.createJournalEntry({
        userId: "user-123",
        entryType: "debit",
        amount: 10,
        balanceAfter: 90,
        source: "operation_commit",
        description: "Test entry",
      });

      const entries = await repo.getJournalEntries({ userId: "user-123" });
      expect(entries.length).toBe(1);
    });

    it("counts journal entries", async () => {
      await repo.createJournalEntry({
        userId: "user-123",
        entryType: "debit",
        amount: 10,
        balanceAfter: 90,
        source: "operation_commit",
        description: "Entry 1",
      });
      await repo.createJournalEntry({
        userId: "user-123",
        entryType: "credit",
        amount: 50,
        balanceAfter: 140,
        source: "admin_add",
        description: "Entry 2",
      });

      const count = await repo.getJournalEntriesCount({ userId: "user-123" });
      expect(count).toBe(2);
    });
  });
});

// =============================================================================
// Factory Function Tests
// =============================================================================

describe("Factory Functions", () => {
  it("exports createFirestoreCreditRepository", () => {
    expect(typeof createFirestoreCreditRepository).toBe("function");
  });

  it("exports FirestoreCreditRepository class", () => {
    expect(FirestoreCreditRepository).toBeDefined();
  });

  it("creates repository with mock Firestore instance", () => {
    const mockDb = {} as Parameters<typeof createFirestoreCreditRepository>[0];
    const repo = createFirestoreCreditRepository(mockDb);

    expect(repo).toBeDefined();
    expect(typeof repo.getUserCredits).toBe("function");
    expect(typeof repo.initializeUserCredits).toBe("function");
    expect(typeof repo.reserveCreditsAtomic).toBe("function");
    expect(typeof repo.commitReservationAtomic).toBe("function");
    expect(typeof repo.releaseReservationAtomic).toBe("function");
  });

  it("accepts custom options", () => {
    const mockDb = {} as Parameters<typeof createFirestoreCreditRepository>[0];
    const customOptions = {
      getMonthlyLimit: (tier: string) => (tier === "premium" ? 500 : 25),
    };

    const repo = createFirestoreCreditRepository(mockDb, customOptions);
    expect(repo).toBeDefined();
  });
});
