import { describe, it, expect, afterEach, vi } from "vitest";
import {
  initializeConfig,
  resetConfig,
  getConfig,
  getValidTiers,
  isValidTier,
  isFreeTier,
  isUnlimitedTier,
  getDefaultTier,
  getConfigTierConfig,
  getConfigMonthlyLimit,
  getUnlimitedSentinelBalance,
  UNLIMITED_BALANCE_SENTINEL,
  parseTier,
  tierSchema,
} from "../../src";
import type { CreditSystemConfig } from "../../src";

afterEach(() => {
  resetConfig();
  vi.restoreAllMocks();
});

describe("dynamic tiers - built-in behavior", () => {
  it("getValidTiers reflects the built-in tiers", () => {
    expect(getValidTiers().sort()).toEqual(["basic", "free", "premium", "unlimited"]);
  });

  it("isValidTier returns true for built-in tiers and false otherwise", () => {
    expect(isValidTier("free")).toBe(true);
    expect(isValidTier("premium")).toBe(true);
    expect(isValidTier("nope")).toBe(false);
  });

  it("isFreeTier identifies the free tier", () => {
    expect(isFreeTier("free")).toBe(true);
    expect(isFreeTier("premium")).toBe(false);
  });

  it("isUnlimitedTier identifies the unlimited tier", () => {
    expect(isUnlimitedTier("unlimited")).toBe(true);
    expect(isUnlimitedTier("basic")).toBe(false);
  });

  it("getDefaultTier returns free", () => {
    expect(getDefaultTier()).toBe("free");
  });

  it("getUnlimitedSentinelBalance returns the back-compat sentinel", () => {
    expect(getUnlimitedSentinelBalance()).toBe(999999);
    expect(UNLIMITED_BALANCE_SENTINEL).toBe(999999);
  });
});

describe("dynamic tiers - config-defined tier", () => {
  function configWithPro(): Partial<CreditSystemConfig> {
    const builtins = getConfig().tierConfigs;
    return {
      tierConfigs: {
        ...builtins,
        pro: { tier: "pro", monthlyCredits: 1000, priceUsd: 9.99, features: [] },
      },
    };
  }

  it("recognizes a config-added tier", () => {
    initializeConfig(configWithPro());
    expect(isValidTier("pro")).toBe(true);
    expect(getValidTiers()).toContain("pro");
    expect(getConfigMonthlyLimit("pro")).toBe(1000);
    expect(getConfigTierConfig("pro").monthlyCredits).toBe(1000);
  });

  it("a config tier is not free and not unlimited based on its values", () => {
    initializeConfig(configWithPro());
    expect(isFreeTier("pro")).toBe(false);
    expect(isUnlimitedTier("pro")).toBe(false);
  });
});

describe("dynamic tiers - unknown tier fallback", () => {
  it("getConfigTierConfig falls back to default tier and warns (no throw)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let result;
    expect(() => {
      result = getConfigTierConfig("does-not-exist");
    }).not.toThrow();
    expect(result).toEqual(getConfigTierConfig("free"));
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("does-not-exist");
  });
});

describe("dynamic tiers - parseTier / tierSchema", () => {
  it("parseTier returns valid tiers", () => {
    expect(parseTier("premium")).toBe("premium");
  });

  it("parseTier throws on unknown tiers", () => {
    expect(() => parseTier("nope")).toThrow();
  });

  it("tierSchema validates against live config keys", () => {
    initializeConfig({
      tierConfigs: {
        ...getConfig().tierConfigs,
        pro: { tier: "pro", monthlyCredits: 1000, priceUsd: 9.99, features: [] },
      },
    });
    expect(tierSchema.parse("pro")).toBe("pro");
  });
});

describe("dynamic tiers - back-compat", () => {
  it("a tier with monthlyCredits 0 and no unlimited flag resolves to Infinity", () => {
    initializeConfig({
      tierConfigs: {
        ...getConfig().tierConfigs,
        legacyUnlimited: {
          tier: "legacyUnlimited",
          monthlyCredits: 0,
          priceUsd: 99,
          features: [],
        },
      },
    });
    expect(getConfigMonthlyLimit("legacyUnlimited")).toBe(Infinity);
    expect(isUnlimitedTier("legacyUnlimited")).toBe(true);
  });
});
