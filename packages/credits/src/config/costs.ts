import type { SubscriptionTier, TierConfig } from "../core/types";
import {
  getConfig,
  getConfigOperationCost,
  getConfigTierConfig,
  getConfigMonthlyLimit,
  getValidOperationTypes,
  isValidOperationType,
} from "./index";

/**
 * Get operation costs as a record
 * Returns all configured operation costs from the current config
 */
export function getOperationCosts(): Record<string, number> {
  return { ...getConfig().operationCosts };
}

/**
 * Get the credit cost for an operation type
 * Uses the configuration system for dynamic costs
 *
 * @param type - Operation type (must be configured in the system)
 * @returns Credit cost for the operation
 * @throws Error if the operation type is not configured
 */
export function getOperationCost(type: string): number {
  return getConfigOperationCost(type);
}

// Re-export validation helpers for convenience
export { getValidOperationTypes, isValidOperationType };

/**
 * Tier configurations with monthly limits and pricing
 *
 * NOTE: This is kept for backward compatibility.
 * The actual configs are loaded from configuration.
 * Use getTierConfig() instead of accessing this directly.
 */
export const TIER_CONFIGS: Record<SubscriptionTier, TierConfig> = {
  get free() {
    return getConfig().tierConfigs.free!;
  },
  get basic() {
    return getConfig().tierConfigs.basic!;
  },
  get premium() {
    return getConfig().tierConfigs.premium!;
  },
  get unlimited() {
    return getConfig().tierConfigs.unlimited!;
  },
};

/**
 * Get tier configuration
 * Uses the configuration system for dynamic configs
 *
 * @param tier - Subscription tier
 * @returns Tier configuration
 */
export function getTierConfig(tier: SubscriptionTier): TierConfig {
  return getConfigTierConfig(tier);
}

/**
 * Get monthly credit limit for a tier
 * Returns Infinity for unlimited tier
 * Uses the configuration system for dynamic limits
 *
 * @param tier - Subscription tier
 * @returns Monthly credit limit
 */
export function getMonthlyLimit(tier: SubscriptionTier): number {
  return getConfigMonthlyLimit(tier);
}

/**
 * Default credits for new users (free tier)
 * Uses the configuration system
 */
export const DEFAULT_FREE_CREDITS = 25; // Static fallback, actual value from getConfig().defaultFreeCredits

/**
 * Get default free credits from configuration
 */
export function getDefaultFreeCredits(): number {
  return getConfig().defaultFreeCredits;
}

/**
 * Reservation expiry time in milliseconds
 * Uses the configuration system
 */
export const RESERVATION_EXPIRY_MS = 5 * 60 * 1000; // Static fallback

/**
 * Get reservation expiry time from configuration
 */
export function getReservationExpiryMs(): number {
  return getConfig().reservationExpiryMs;
}
