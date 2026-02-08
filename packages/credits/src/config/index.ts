import { z } from "zod";
import type { SubscriptionTier, TierConfig } from "../core/types";

/**
 * Schema for tier configuration
 */
const tierConfigSchema = z.object({
  tier: z.enum(["free", "basic", "premium", "unlimited"]),
  monthlyCredits: z.number().min(0),
  priceUsd: z.number().min(0),
  features: z.array(z.string()),
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
   * Tier configurations
   */
  tierConfigs: z.record(
    z.enum(["free", "basic", "premium", "unlimited"]),
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
  tierConfigs: {
    free: {
      tier: "free",
      monthlyCredits: 25,
      priceUsd: 0,
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
 * Get the current configuration
 */
export function getConfig(): CreditSystemConfig {
  return currentConfig;
}

/**
 * Get all valid operation types from configuration
 * Returns the keys of the operationCosts object
 */
export function getValidOperationTypes(): string[] {
  return Object.keys(currentConfig.operationCosts);
}

/**
 * Check if an operation type is valid (configured in the system)
 * @param type - The operation type to check
 * @returns true if the operation type is configured
 */
export function isValidOperationType(type: string): boolean {
  return type in currentConfig.operationCosts;
}

/**
 * Get operation cost from configuration
 * @throws Error if the operation type is not configured
 */
export function getConfigOperationCost(operationType: string): number {
  const cost = currentConfig.operationCosts[operationType];
  if (cost === undefined) {
    throw new Error(
      `Unknown operation type: ${operationType}. Valid types: ${getValidOperationTypes().join(", ")}`
    );
  }
  return cost;
}

/**
 * Get tier configuration from configuration
 */
export function getConfigTierConfig(tier: SubscriptionTier): TierConfig {
  return currentConfig.tierConfigs[tier]!;
}

/**
 * Get monthly limit for a tier from configuration
 * Returns Infinity for unlimited tier
 */
export function getConfigMonthlyLimit(tier: SubscriptionTier): number {
  const config = currentConfig.tierConfigs[tier]!;
  return config.monthlyCredits === 0 ? Infinity : config.monthlyCredits;
}

/**
 * Check if a feature is enabled
 */
export function isFeatureEnabled(feature: keyof CreditSystemConfig["features"]): boolean {
  return currentConfig.features[feature];
}

/**
 * Reset configuration to defaults (for testing)
 */
export function resetConfig(): void {
  currentConfig = DEFAULT_CONFIG;
}

// Initialize configuration on module load
initializeConfig();
