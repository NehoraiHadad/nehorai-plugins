/**
 * Basic tests to verify plugin exports work
 */
import { describe, it, expect } from "vitest";
import {
  CreditError,
  CreditErrorCode,
  createInsufficientCreditsError,
  calculateAvailableCredits,
  createInMemoryCreditRepository,
  CreditsService,
  getConfig,
} from "../../src";

describe("@nehorai/credits core", () => {
  describe("CreditError", () => {
    it("should create an error with correct code", () => {
      const error = new CreditError("Test error", CreditErrorCode.INSUFFICIENT_CREDITS);
      expect(error.code).toBe(CreditErrorCode.INSUFFICIENT_CREDITS);
      expect(error.message).toBe("Test error");
    });

    it("should create insufficient credits error via factory", () => {
      // Args order: required, available
      const error = createInsufficientCreditsError(5, 10);
      expect(error.code).toBe(CreditErrorCode.INSUFFICIENT_CREDITS);
      expect(error.details?.required).toBe(5);
      expect(error.details?.available).toBe(10);
    });
  });

  describe("calculateAvailableCredits", () => {
    it("should calculate available credits correctly", () => {
      // Args: balance, bonusCredits, reserved
      const available = calculateAvailableCredits(100, 50, 20);
      expect(available).toBe(130); // 100 + 50 - 20
    });
  });

  describe("InMemoryCreditRepository", () => {
    it("should create repository and initialize user", async () => {
      const repo = createInMemoryCreditRepository();

      // initializeUserCredits takes: userId, tier, initialBalance
      const credits = await repo.initializeUserCredits("user-123", "free", 25);
      expect(credits.userId).toBe("user-123");
      expect(credits.balance).toBe(25);
    });

    it("should get user credits after initialization", async () => {
      const repo = createInMemoryCreditRepository();

      await repo.initializeUserCredits("user-456", "free", 25);
      const credits = await repo.getUserCredits("user-456");

      expect(credits).not.toBeNull();
      expect(credits?.userId).toBe("user-456");
    });
  });

  describe("CreditsService", () => {
    it("should check credits correctly", async () => {
      const repo = createInMemoryCreditRepository();
      const service = new CreditsService(repo);

      // Initialize user with 25 credits
      await repo.initializeUserCredits("user-123", "free", 25);

      const result = await service.checkCredits("user-123", 5);
      expect(result.hasCredits).toBe(true);
    });

    it("should reserve and commit credits", async () => {
      const repo = createInMemoryCreditRepository();
      const service = new CreditsService(repo);

      await repo.initializeUserCredits("user-789", "free", 25);

      // Reserve credits
      const reservation = await service.reserveCredits("user-789", 5, "story_generation");
      expect(reservation.id).toBeDefined();
      expect(reservation.amount).toBe(5);

      // Commit the reservation
      await service.commitCredits("user-789", reservation.id);

      // Verify credits were deducted
      const credits = await repo.getUserCredits("user-789");
      expect(credits?.balance).toBeLessThan(25); // Started with 25
    });
  });

  describe("Config", () => {
    it("should have default operation costs", () => {
      const config = getConfig();
      expect(config.operationCosts.story_generation).toBe(5);
      expect(config.operationCosts.image_generation).toBe(10);
    });

    it("should have tier configurations", () => {
      const config = getConfig();
      expect(config.tierConfigs.free).toBeDefined();
      expect(config.tierConfigs.free?.monthlyCredits).toBe(25);
      expect(config.tierConfigs.premium?.monthlyCredits).toBe(500);
    });
  });
});
