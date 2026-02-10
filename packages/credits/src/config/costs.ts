import type { SubscriptionTier, TierConfig } from "../core/types.js";
import {
  getConfig,
  getConfigOperationCost,
  getConfigTierConfig,
  getConfigMonthlyLimit,
  getValidOperationTypes,
  isValidOperationType,
  getOperationLabel,
} from "./index.js";

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
 * Get default free credits from configuration
 */
export function getDefaultFreeCredits(): number {
  return getConfig().defaultFreeCredits;
}

/**
 * Get reservation expiry time from configuration
 */
export function getReservationExpiryMs(): number {
  return getConfig().reservationExpiryMs;
}

/**
 * Information about an operation's cost and display label
 */
export interface OperationCostInfo {
  key: string;
  cost: number;
  label: string;
}

/**
 * Get all operation costs with their display labels.
 * Returns a record keyed by operation type with cost + label.
 */
export function getOperationCostsWithLabels(): Record<string, OperationCostInfo> {
  const config = getConfig();
  const result: Record<string, OperationCostInfo> = {};
  for (const [key, cost] of Object.entries(config.operationCosts)) {
    result[key] = {
      key,
      cost,
      label: getOperationLabel(key),
    };
  }
  return result;
}
