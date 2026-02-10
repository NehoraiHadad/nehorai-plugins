import { describe, it, expect, beforeEach } from "vitest";
import {
  registerConfigProvider,
  clearConfigProvider,
  getConfig,
  initializeConfig,
  resetConfig,
  getValidOperationTypes,
  isValidOperationType,
  getConfigOperationCost,
  getConfigMonthlyLimit,
  getConfigTierConfig,
  isFeatureEnabled,
  getOperationLabel,
  getOperationLabels,
  getOperationCostsWithLabels,
  type ICreditConfigProvider,
  type CreditSystemConfig,
} from "../../src";

/** Helper to create a custom config for testing */
function createCustomConfig(): CreditSystemConfig {
  return {
    operationCosts: {
      custom_op: 42,
      another_op: 7,
    },
    operationLabels: {
      custom_op: "Custom Operation",
      another_op: "Another Operation",
    },
    tierConfigs: {
      free: {
        tier: "free",
        monthlyCredits: 10,
        priceUsd: 0,
        features: ["10 credits"],
      },
      basic: {
        tier: "basic",
        monthlyCredits: 100,
        priceUsd: 4.99,
        features: ["100 credits"],
      },
      premium: {
        tier: "premium",
        monthlyCredits: 300,
        priceUsd: 14.99,
        features: ["300 credits"],
      },
      unlimited: {
        tier: "unlimited",
        monthlyCredits: 0,
        priceUsd: 39.99,
        features: ["Unlimited"],
      },
    },
    reservationExpiryMs: 10 * 60 * 1000,
    defaultFreeCredits: 50,
    subscriptionGracePeriodDays: 7,
    lowBalanceThreshold: 5,
    lowBalanceNotificationCooldownHours: 12,
    features: {
      journalEntries: false,
      notifications: true,
      subscriptionExpiry: false,
      usageHistory: true,
    },
  };
}

describe("ICreditConfigProvider", () => {
  beforeEach(() => {
    clearConfigProvider();
    resetConfig();
  });

  it("getConfig() returns defaults when no provider registered", () => {
    const config = getConfig();
    expect(config.operationCosts.story_generation).toBe(5);
    expect(config.defaultFreeCredits).toBe(25);
  });

  it("registerConfigProvider makes getConfig() delegate to provider", () => {
    const customConfig = createCustomConfig();
    const provider: ICreditConfigProvider = {
      getConfig: () => customConfig,
    };

    registerConfigProvider(provider);

    const config = getConfig();
    expect(config.operationCosts.custom_op).toBe(42);
    expect(config.defaultFreeCredits).toBe(50);
    expect(config.reservationExpiryMs).toBe(10 * 60 * 1000);
  });

  it("clearConfigProvider makes getConfig() fall back to defaults", () => {
    const customConfig = createCustomConfig();
    const provider: ICreditConfigProvider = {
      getConfig: () => customConfig,
    };

    registerConfigProvider(provider);
    expect(getConfig().defaultFreeCredits).toBe(50);

    clearConfigProvider();
    expect(getConfig().defaultFreeCredits).toBe(25);
  });

  it("provider override takes precedence over initializeConfig overrides", () => {
    // First, override via initializeConfig
    initializeConfig({ defaultFreeCredits: 100 });
    expect(getConfig().defaultFreeCredits).toBe(100);

    // Then register provider — should take precedence
    const customConfig = createCustomConfig();
    const provider: ICreditConfigProvider = {
      getConfig: () => customConfig,
    };
    registerConfigProvider(provider);
    expect(getConfig().defaultFreeCredits).toBe(50);

    // Clear provider — falls back to initializeConfig override
    clearConfigProvider();
    expect(getConfig().defaultFreeCredits).toBe(100);
  });

  describe("accessor functions use provider when registered", () => {
    beforeEach(() => {
      const customConfig = createCustomConfig();
      const provider: ICreditConfigProvider = {
        getConfig: () => customConfig,
      };
      registerConfigProvider(provider);
    });

    it("getValidOperationTypes returns provider operation types", () => {
      const types = getValidOperationTypes();
      expect(types).toContain("custom_op");
      expect(types).toContain("another_op");
      expect(types).not.toContain("story_generation");
    });

    it("isValidOperationType checks against provider config", () => {
      expect(isValidOperationType("custom_op")).toBe(true);
      expect(isValidOperationType("story_generation")).toBe(false);
    });

    it("getConfigOperationCost reads from provider config", () => {
      expect(getConfigOperationCost("custom_op")).toBe(42);
      expect(getConfigOperationCost("another_op")).toBe(7);
      expect(() => getConfigOperationCost("story_generation")).toThrow(
        "Unknown operation type"
      );
    });

    it("getConfigMonthlyLimit reads from provider config", () => {
      expect(getConfigMonthlyLimit("free")).toBe(10);
      expect(getConfigMonthlyLimit("basic")).toBe(100);
      expect(getConfigMonthlyLimit("unlimited")).toBe(Infinity);
    });

    it("getConfigTierConfig reads from provider config", () => {
      const tierConfig = getConfigTierConfig("free");
      expect(tierConfig.monthlyCredits).toBe(10);
      expect(tierConfig.priceUsd).toBe(0);
    });

    it("isFeatureEnabled reads from provider config", () => {
      expect(isFeatureEnabled("journalEntries")).toBe(false);
      expect(isFeatureEnabled("notifications")).toBe(true);
      expect(isFeatureEnabled("subscriptionExpiry")).toBe(false);
      expect(isFeatureEnabled("usageHistory")).toBe(true);
    });

    it("getOperationLabel reads from provider config", () => {
      expect(getOperationLabel("custom_op")).toBe("Custom Operation");
      expect(getOperationLabel("another_op")).toBe("Another Operation");
    });

    it("getOperationLabels reads from provider config", () => {
      const labels = getOperationLabels();
      expect(labels).toEqual({
        custom_op: "Custom Operation",
        another_op: "Another Operation",
      });
    });

    it("getOperationCostsWithLabels reads from provider config", () => {
      const costsWithLabels = getOperationCostsWithLabels();
      expect(costsWithLabels.custom_op).toEqual({
        key: "custom_op",
        cost: 42,
        label: "Custom Operation",
      });
      expect(costsWithLabels.another_op).toEqual({
        key: "another_op",
        cost: 7,
        label: "Another Operation",
      });
    });
  });

  describe("operationLabels in config", () => {
    it("default config includes operationLabels", () => {
      const config = getConfig();
      expect(config.operationLabels).toBeDefined();
      expect(config.operationLabels!.story_generation).toBe("Story generation");
      expect(config.operationLabels!.conversation).toBe("Conversation");
      expect(config.operationLabels!.image_generation).toBe("Image generation");
      expect(config.operationLabels!.template_generation).toBe("Template generation");
    });

    it("initializeConfig merges operationLabels", () => {
      const config = initializeConfig({
        operationLabels: {
          story_generation: "Custom Story Label",
        },
      });
      // Overridden label
      expect(config.operationLabels!.story_generation).toBe("Custom Story Label");
      // Default labels preserved
      expect(config.operationLabels!.conversation).toBe("Conversation");
      expect(config.operationLabels!.image_generation).toBe("Image generation");
    });
  });

  describe("getOperationLabel", () => {
    it("returns configured label for known operation type", () => {
      expect(getOperationLabel("story_generation")).toBe("Story generation");
      expect(getOperationLabel("conversation")).toBe("Conversation");
    });

    it("falls back to Title Case for unknown operation type", () => {
      expect(getOperationLabel("some_new_operation")).toBe("Some New Operation");
    });

    it("handles single-word operation type", () => {
      expect(getOperationLabel("refund")).toBe("Refund");
    });
  });

  describe("getOperationLabels", () => {
    it("returns labels for all configured operation costs", () => {
      const labels = getOperationLabels();
      expect(labels).toEqual({
        story_generation: "Story generation",
        conversation: "Conversation",
        image_generation: "Image generation",
        template_generation: "Template generation",
      });
    });

    it("generates fallback labels for operations without explicit labels", () => {
      initializeConfig({
        operationCosts: {
          story_generation: 5,
          brand_new_type: 3,
        },
        operationLabels: {
          story_generation: "Story generation",
          // brand_new_type has no label
        },
      });
      const labels = getOperationLabels();
      expect(labels.story_generation).toBe("Story generation");
      expect(labels.brand_new_type).toBe("Brand New Type");
    });
  });

  describe("getOperationCostsWithLabels", () => {
    it("returns cost info with labels for all operations", () => {
      const result = getOperationCostsWithLabels();
      expect(result.story_generation).toEqual({
        key: "story_generation",
        cost: 5,
        label: "Story generation",
      });
      expect(result.image_generation).toEqual({
        key: "image_generation",
        cost: 10,
        label: "Image generation",
      });
    });

    it("includes all configured operations", () => {
      const result = getOperationCostsWithLabels();
      const keys = Object.keys(result);
      expect(keys).toContain("story_generation");
      expect(keys).toContain("conversation");
      expect(keys).toContain("image_generation");
      expect(keys).toContain("template_generation");
      expect(keys).toHaveLength(4);
    });
  });
});
