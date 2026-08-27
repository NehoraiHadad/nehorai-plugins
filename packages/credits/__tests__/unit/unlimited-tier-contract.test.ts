/**
 * One mapping for the unlimited-tier sentinel, on every path that writes it.
 *
 * `getConfigMonthlyLimit` returns `Infinity` for an unlimited tier and no
 * numeric column can hold that, so every writer has to resolve it the same way.
 * Three separate places used to resolve it *differently*: the SQL adapter's
 * auto-create wrote `0`, `CreditsService.updateTier` wrote `0` under a
 * "0 means unlimited" convention that no read path anywhere in the library
 * implements, and the grace-period downgrade read the raw `monthlyCredits`
 * config field, where `0` means unlimited in the other direction.
 *
 * Every assertion here is against the literal canonical value. Comparing an
 * adapter against `storedMonthlyLimit(...)` of its own output would pass even
 * if both reverted to zero.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CREDIT_AMOUNT_MAX,
  CreditsService,
  createInMemoryCreditRepository,
  getConfigMonthlyLimit,
  initializeConfig,
  resetConfig,
  storedMonthlyLimit,
} from "../../src/index.js";

const CANONICAL = 9999999999.99;
const USER = "u-unlimited-contract";

describe("the unlimited-tier storage mapping", () => {
  afterEach(() => {
    resetConfig();
  });

  it("is the top of the representable range, and is the exported ceiling", () => {
    expect(storedMonthlyLimit(Number.POSITIVE_INFINITY)).toBe(CANONICAL);
    expect(CREDIT_AMOUNT_MAX).toBe(CANONICAL);
  });

  it("only applies to a tier that is actually unlimited", () => {
    expect(getConfigMonthlyLimit("unlimited")).toBe(Number.POSITIVE_INFINITY);
    expect(getConfigMonthlyLimit("free")).not.toBe(Number.POSITIVE_INFINITY);
    expect(storedMonthlyLimit(500)).toBe(500);
  });

  it("is what initialization persists", async () => {
    const repo = createInMemoryCreditRepository();
    const credits = await repo.initializeUserCredits(USER, "unlimited", 0);
    expect(credits.monthlyLimit).toBe(CANONICAL);
    expect(credits.monthlyLimit).not.toBe(0);
  });

  it("is what a tier upgrade persists", async () => {
    const repo = createInMemoryCreditRepository();
    const service = new CreditsService(repo);
    await repo.initializeUserCredits(USER, "free", 10);

    await service.updateTier(USER, "unlimited");

    const credits = await repo.getUserCredits(USER);
    // The defect this pins: `updateTier` stored 0 here, so upgrading a user to
    // unlimited gave them an allowance of zero.
    expect(credits?.monthlyLimit).toBe(CANONICAL);
    expect(credits?.monthlyLimit).not.toBe(0);
    expect(credits?.tier).toBe("unlimited");
  });

  it("leaves a finite tier upgrade on its configured limit", async () => {
    const repo = createInMemoryCreditRepository();
    const service = new CreditsService(repo);
    await repo.initializeUserCredits(USER, "free", 10);

    await service.updateTier(USER, "premium");

    const credits = await repo.getUserCredits(USER);
    expect(credits?.monthlyLimit).toBe(getConfigMonthlyLimit("premium"));
    expect(credits?.monthlyLimit).not.toBe(CANONICAL);
  });
});

/**
 * The grace-period downgrade reads the *default* tier's configuration, and an
 * app is free to make its default tier unlimited. In tier config `0` means
 * unlimited, so reading `monthlyCredits` directly downgraded such a user onto a
 * limit — and a balance, since the balance is clamped to it — of zero.
 */
describe("downgrading onto an unlimited default tier", () => {
  const EXPIRED_USER = "u-downgrade-unlimited";

  beforeEach(() => {
    initializeConfig({
      tierConfigs: {
        free: {
          tier: "free",
          monthlyCredits: 10,
          priceUsd: 0,
          features: [],
          isFree: true,
        },
        premium: {
          tier: "premium",
          monthlyCredits: 500,
          priceUsd: 19.99,
          features: [],
        },
        unlimited: {
          tier: "unlimited",
          monthlyCredits: 0,
          priceUsd: 49.99,
          features: [],
          unlimited: true,
          isDefault: true,
        },
      },
    } as never);
  });

  afterEach(() => {
    resetConfig();
  });

  it("stores the canonical limit and keeps the balance", async () => {
    const repo = createInMemoryCreditRepository();
    await repo.initializeUserCredits(EXPIRED_USER, "premium", 250);
    // Expired well past any grace period.
    await repo.updateUserCredits(EXPIRED_USER, {
      subscriptionExpiresAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
    });

    const result = await repo.checkAndHandleSubscriptionExpiry(EXPIRED_USER);
    expect(result.wasDowngraded).toBe(true);

    const credits = await repo.getUserCredits(EXPIRED_USER);
    expect(credits?.monthlyLimit).toBe(CANONICAL);
    expect(credits?.monthlyLimit).not.toBe(0);
    // The balance is clamped to the limit, so a zero limit would have zeroed it.
    expect(credits?.balance).toBe(250);
  });
});
