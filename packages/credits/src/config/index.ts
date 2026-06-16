import { z } from "zod";
import type { SubscriptionTier, TierConfig } from "../core/types.js";
import { getConfigProvider } from "./provider.js";

/**
 * Schema for tier configuration
 */
const tierConfigSchema = z.object({
  tier: z.string().min(1),
  monthlyCredits: z.number().min(0),
  priceUsd: z.number().min(0),
  features: z.array(z.string()),
  isFree: z.boolean().optional(),
  unlimited: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

/**
 * Schema for credit system configuration
 */
const creditSystemConfigSchema = z.object({
  /**
   * Operation costs in credits
   * Keys are operation type names (any non-empty string)
   * Values are positive numbers representing credit cost
   */
  operationCosts: z.record(
    z.string().min(1),
    z.number().positive()
  ),

  /**
   * Display labels for operation types (English canonical labels).
   * Falls back to auto-generating from snake_case keys if not provided.
   */
  operationLabels: z.record(
    z.string().min(1),
    z.string().min(1)
  ).optional().default({}),

  /**
   * Tier configurations
   */
  tierConfigs: z.record(
    z.string().min(1),
    tierConfigSchema
  ),

  /**
   * Reservation expiry time in milliseconds
   */
  reservationExpiryMs: z.number().positive().default(5 * 60 * 1000),

  /**
   * Default credits for new users (free tier)
   */
  defaultFreeCredits: z.number().positive().default(25),

  /**
   * Grace period in days after subscription expires before downgrade
   */
  subscriptionGracePeriodDays: z.number().min(0).default(3),

  /**
   * Low balance notification threshold
   */
  lowBalanceThreshold: z.number().min(0).default(10),

  /**
   * Cooldown in hours between low balance notifications
   */
  lowBalanceNotificationCooldownHours: z.number().positive().default(24),

  /**
   * Feature flags for optional features
   */
  features: z.object({
    journalEntries: z.boolean().default(true),
    notifications: z.boolean().default(true),
    subscriptionExpiry: z.boolean().default(true),
    usageHistory: z.boolean().default(true),
  }).default({
    journalEntries: true,
    notifications: true,
    subscriptionExpiry: true,
    usageHistory: true,
  }),
});

/**
 * Credit system configuration type
 */
export type CreditSystemConfig = z.infer<typeof creditSystemConfigSchema>;

/**
 * Default configuration
 */
const DEFAULT_CONFIG: CreditSystemConfig = {
  operationCosts: {
    story_generation: 5,
    conversation: 2,
    image_generation: 10,
    template_generation: 10,
  },
  operationLabels: {
    story_generation: "Story generation",
    conversation: "Conversation",
    image_generation: "Image generation",
    template_generation: "Template generation",
  },
  tierConfigs: {
    free: {
      tier: "free",
      monthlyCredits: 25,
      priceUsd: 0,
      isFree: true,
      isDefault: true,
      features: [
        "25 credits per month",
        "Basic story generation",
        "Standard image quality",
      ],
    },
    basic: {
      tier: "basic",
      monthlyCredits: 200,
      priceUsd: 9.99,
      features: [
        "200 credits per month",
        "All story features",
        "High quality images",
        "Priority support",
      ],
    },
    premium: {
      tier: "premium",
      monthlyCredits: 500,
      priceUsd: 19.99,
      features: [
        "500 credits per month",
        "All features",
        "Highest quality images",
        "Early access to new features",
        "Priority support",
      ],
    },
    unlimited: {
      tier: "unlimited",
      monthlyCredits: 0, // 0 = unlimited
      unlimited: true,
      priceUsd: 49.99,
      features: [
        "Unlimited credits",
        "All features",
        "Highest quality images",
        "Early access to new features",
        "Dedicated support",
      ],
    },
  },
  reservationExpiryMs: 5 * 60 * 1000, // 5 minutes
  defaultFreeCredits: 25,
  subscriptionGracePeriodDays: 3,
  lowBalanceThreshold: 10,
  lowBalanceNotificationCooldownHours: 24,
  features: {
    journalEntries: true,
    notifications: true,
    subscriptionExpiry: true,
    usageHistory: true,
  },
};

/**
 * Current configuration (can be overridden)
 */
let currentConfig: CreditSystemConfig = DEFAULT_CONFIG;

/**
 * Load configuration from environment variables
 * Can be extended to load from other sources (file, remote config, etc.)
 *
 * Operation costs are loaded from CREDITS_OPERATION_COSTS as JSON:
 * CREDITS_OPERATION_COSTS={"story_generation":5,"image_generation":10}
 */
export function loadConfigFromEnv(): Partial<CreditSystemConfig> {
  const envConfig: Partial<CreditSystemConfig> = {};

  // Load operation costs from env as JSON
  const operationCostsEnv = process.env.CREDITS_OPERATION_COSTS;
  if (operationCostsEnv) {
    try {
      const parsed = JSON.parse(operationCostsEnv);
      if (typeof parsed === "object" && parsed !== null) {
        envConfig.operationCosts = {
          ...DEFAULT_CONFIG.operationCosts,
          ...parsed,
        };
      }
    } catch {
      console.warn("[Credits Config] Failed to parse CREDITS_OPERATION_COSTS env var as JSON");
    }
  }

  // Load other settings from env
  const reservationExpiry = process.env.CREDITS_RESERVATION_EXPIRY_MS;
  if (reservationExpiry) {
    envConfig.reservationExpiryMs = parseInt(reservationExpiry, 10);
  }

  const defaultCredits = process.env.CREDITS_DEFAULT_FREE;
  if (defaultCredits) {
    envConfig.defaultFreeCredits = parseInt(defaultCredits, 10);
  }

  const gracePeriod = process.env.CREDITS_GRACE_PERIOD_DAYS;
  if (gracePeriod) {
    envConfig.subscriptionGracePeriodDays = parseInt(gracePeriod, 10);
  }

  const lowBalanceThreshold = process.env.CREDITS_LOW_BALANCE_THRESHOLD;
  if (lowBalanceThreshold) {
    envConfig.lowBalanceThreshold = parseInt(lowBalanceThreshold, 10);
  }

  // Load feature flags
  const featuresEnv = process.env.CREDITS_FEATURES;
  if (featuresEnv) {
    try {
      const features = JSON.parse(featuresEnv);
      envConfig.features = {
        ...DEFAULT_CONFIG.features,
        ...features,
      };
    } catch {
      console.warn("[Credits Config] Failed to parse CREDITS_FEATURES env var");
    }
  }

  return envConfig;
}

/**
 * Initialize configuration
 * Merges default config with environment overrides
 */
export function initializeConfig(overrides?: Partial<CreditSystemConfig>): CreditSystemConfig {
  const envConfig = loadConfigFromEnv();

  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...envConfig,
    ...overrides,
    operationCosts: {
      ...DEFAULT_CONFIG.operationCosts,
      ...envConfig.operationCosts,
      ...overrides?.operationCosts,
    },
    operationLabels: {
      ...DEFAULT_CONFIG.operationLabels,
      ...envConfig.operationLabels,
      ...overrides?.operationLabels,
    },
    tierConfigs: {
      ...DEFAULT_CONFIG.tierConfigs,
      ...envConfig.tierConfigs,
      ...overrides?.tierConfigs,
    },
    features: {
      ...DEFAULT_CONFIG.features,
      ...envConfig.features,
      ...overrides?.features,
    },
  };

  // Validate configuration
  const result = creditSystemConfigSchema.safeParse(mergedConfig);
  if (!result.success) {
    console.error("[Credits Config] Invalid configuration:", result.error.issues);
    throw new Error("Invalid credit system configuration");
  }

  currentConfig = result.data;
  return currentConfig;
}

/**
 * Get the current configuration.
 * If an external provider is registered, delegates to it.
 * Otherwise falls back to the local currentConfig.
 */
export function getConfig(): CreditSystemConfig {
  const provider = getConfigProvider();
  if (provider) {
    return provider.getConfig();
  }
  return currentConfig;
}

/**
 * Get all valid operation types from configuration
 * Returns the keys of the operationCosts object
 */
export function getValidOperationTypes(): string[] {
  return Object.keys(getConfig().operationCosts);
}

/**
 * Check if an operation type is valid (configured in the system)
 * @param type - The operation type to check
 * @returns true if the operation type is configured
 */
export function isValidOperationType(type: string): boolean {
  return type in getConfig().operationCosts;
}

/**
 * Get operation cost from configuration
 * @throws Error if the operation type is not configured
 */
export function getConfigOperationCost(operationType: string): number {
  const cost = getConfig().operationCosts[operationType];
  if (cost === undefined) {
    throw new Error(
      `Unknown operation type: ${operationType}. Valid types: ${getValidOperationTypes().join(", ")}`
    );
  }
  return cost;
}

/**
 * Get all valid tier ids from configuration
 * Returns the keys of the tierConfigs object
 */
export function getValidTiers(): string[] {
  return Object.keys(getConfig().tierConfigs);
}

/**
 * Check if a tier id is valid (configured in the system)
 */
export function isValidTier(tier: string): boolean {
  return tier in getConfig().tierConfigs;
}

/**
 * Check if a tier is the free/default tier.
 * Falls back to priceUsd === 0 when the isFree flag is not set.
 */
export function isFreeTier(tier: SubscriptionTier): boolean {
  const c = getConfig().tierConfigs[tier];
  if (!c) return false;
  return c.isFree ?? c.priceUsd === 0;
}

/**
 * Check if a tier is unlimited.
 * Falls back to monthlyCredits === 0 when the unlimited flag is not set.
 */
export function isUnlimitedTier(tier: SubscriptionTier): boolean {
  const c = getConfig().tierConfigs[tier];
  if (!c) return false;
  return c.unlimited ?? c.monthlyCredits === 0;
}

/**
 * Get the tier assigned to brand-new users.
 * Prefers the tier flagged isDefault, then the first isFree tier, then "free".
 */
export function getDefaultTier(): SubscriptionTier {
  const entries = Object.entries(getConfig().tierConfigs);
  const def =
    entries.find(([, c]) => c.isDefault)?.[0] ??
    entries.find(([, c]) => c.isFree ?? c.priceUsd === 0)?.[0];
  return def ?? "free";
}

/**
 * Magic balance assigned to unlimited tiers on upgrade.
 * Kept at 999999 for back-compat with stored/displayed balances.
 */
export const UNLIMITED_BALANCE_SENTINEL = 999999;

/**
 * Get the magic balance assigned to unlimited tiers on upgrade.
 */
export function getUnlimitedSentinelBalance(): number {
  return UNLIMITED_BALANCE_SENTINEL;
}

/**
 * Get tier configuration from configuration.
 * Falls back to the default tier (with a warning) if the tier is unknown.
 */
export function getConfigTierConfig(tier: SubscriptionTier): TierConfig {
  const cfg = getConfig().tierConfigs[tier];
  if (cfg) return cfg;
  const fallback = getDefaultTier();
  console.warn(
    `[Credits Config] Unknown tier "${tier}". Falling back to "${fallback}". Valid: ${getValidTiers().join(", ")}`
  );
  return getConfig().tierConfigs[fallback]!;
}

/**
 * Get monthly limit for a tier from configuration
 * Returns Infinity for unlimited tier
 */
export function getConfigMonthlyLimit(tier: SubscriptionTier): number {
  return isUnlimitedTier(tier) ? Infinity : getConfigTierConfig(tier).monthlyCredits;
}

/**
 * Runtime zod validator for tier ids. Validates against the LIVE config keys
 * at parse time, so apps that add tiers via config get correct validation.
 */
export const tierSchema = z
  .string()
  .refine(isValidTier, { message: "Unknown subscription tier" }) as unknown as z.ZodType<SubscriptionTier>;

/**
 * Parse/validate a tier id against the live config keys.
 * @throws ZodError if the tier is not configured
 */
export function parseTier(value: unknown): SubscriptionTier {
  return tierSchema.parse(value);
}

/**
 * Check if a feature is enabled
 */
export function isFeatureEnabled(feature: keyof CreditSystemConfig["features"]): boolean {
  return getConfig().features[feature];
}

/**
 * Convert a snake_case string to Title Case.
 * E.g., "story_generation" -> "Story Generation"
 */
function snakeCaseToTitleCase(str: string): string {
  return str
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Get the display label for an operation type.
 * Falls back to converting snake_case to Title Case if no label is configured.
 */
export function getOperationLabel(operationType: string): string {
  const labels = getConfig().operationLabels;
  if (labels && operationType in labels) {
    return labels[operationType];
  }
  return snakeCaseToTitleCase(operationType);
}

/**
 * Get all operation labels as a record.
 * For any operation in operationCosts that lacks a label, generates one from the key.
 */
export function getOperationLabels(): Record<string, string> {
  const config = getConfig();
  const result: Record<string, string> = {};
  for (const key of Object.keys(config.operationCosts)) {
    result[key] = config.operationLabels?.[key]
      ?? snakeCaseToTitleCase(key);
  }
  return result;
}

/**
 * Reset configuration to defaults (for testing)
 */
export function resetConfig(): void {
  currentConfig = DEFAULT_CONFIG;
}

// Initialize configuration on module load
initializeConfig();
