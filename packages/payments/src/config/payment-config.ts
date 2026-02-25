/**
 * @nehorai/payments - Injectable Configuration
 *
 * Provides a framework-agnostic configuration interface that can be
 * populated from any source (env vars, secrets manager, database, etc.).
 *
 * Usage:
 * ```typescript
 * // Option 1: Create from custom source
 * const config = createConfig({
 *   providers: {
 *     stripe: { secretKey: 'sk_test_...' },
 *   },
 *   environment: 'sandbox',
 *   defaultCurrency: 'USD',
 * });
 *
 * // Option 2: Create from environment variables
 * const config = createConfigFromEnv({
 *   stripeSecretKey: 'STRIPE_SECRET_KEY',
 *   stripePublishableKey: 'STRIPE_PUBLISHABLE_KEY',
 *   stripeWebhookSecret: 'STRIPE_WEBHOOK_SECRET',
 *   environment: 'PAYMENT_ENVIRONMENT',
 *   defaultCurrency: 'DEFAULT_CURRENCY',
 * });
 * ```
 */

// ============================================================================
// Provider Configuration Types
// ============================================================================

/**
 * Generic provider configuration - key-value pairs
 * Providers can have any config shape.
 */
export interface ProviderConfig {
  /** Provider-specific configuration values */
  [key: string]: unknown
}

/**
 * Provider configurations map.
 * Keys are provider names, values are provider-specific config.
 */
export interface ProvidersConfig {
  [providerName: string]: ProviderConfig | undefined
}

/**
 * Main payment configuration interface
 *
 * This is the injectable configuration that can be provided from any source.
 */
export interface PaymentConfig {
  /** Provider-specific configurations */
  providers: ProvidersConfig
  /** Environment mode */
  environment: 'sandbox' | 'production'
  /** Default currency for transactions */
  defaultCurrency: string
}

/**
 * Provider availability derived from configuration
 */
export interface ConfiguredProviderAvailability {
  [providerName: string]: boolean
}

// ============================================================================
// Environment Variable Mapping
// ============================================================================

/**
 * Mapping of provider config keys to environment variable names.
 * Used by createConfigFromEnv().
 */
export interface EnvVarMapping {
  [envVarKey: string]: string
}

/**
 * Provider env var mapping: maps config keys to env var names
 */
export interface ProviderEnvMapping {
  providerName: string
  /** Map of config key -> env var name. Provider is considered configured if any key has a value. */
  keys: EnvVarMapping
  /** Keys that are all required for the provider to be considered configured */
  requiredKeys?: string[]
}

/**
 * Full env mapping configuration
 */
export interface EnvMappingConfig {
  providers: ProviderEnvMapping[]
  environmentVar?: string
  defaultCurrencyVar?: string
}

// ============================================================================
// Configuration Factory Functions
// ============================================================================

/**
 * Create payment configuration from environment variables
 *
 * @param mapping - Mapping of config keys to env var names
 * @returns PaymentConfig populated from process.env
 */
export function createConfigFromEnv(mapping?: EnvMappingConfig): PaymentConfig {
  if (!mapping) {
    return createPartialConfig({})
  }

  const providers: ProvidersConfig = {}

  for (const providerMapping of mapping.providers) {
    const config: ProviderConfig = {}
    let hasValue = false

    for (const [configKey, envVarName] of Object.entries(providerMapping.keys)) {
      const value = process.env[envVarName]
      if (value?.trim()) {
        config[configKey] = value
        hasValue = true
      }
    }

    // Check if required keys are all present
    if (providerMapping.requiredKeys) {
      const allRequired = providerMapping.requiredKeys.every(
        (key) => config[key] && typeof config[key] === 'string' && (config[key] as string).trim()
      )
      if (allRequired) {
        providers[providerMapping.providerName] = config
      }
    } else if (hasValue) {
      providers[providerMapping.providerName] = config
    }
  }

  const environment = (process.env[mapping.environmentVar ?? 'PAYMENT_ENVIRONMENT'] as 'sandbox' | 'production') ?? 'sandbox'
  const defaultCurrency = process.env[mapping.defaultCurrencyVar ?? 'DEFAULT_CURRENCY'] ?? 'USD'

  return {
    providers,
    environment,
    defaultCurrency,
  }
}

/**
 * Create payment configuration from a custom source
 *
 * @param config - Custom configuration object
 * @returns Validated PaymentConfig
 */
export function createConfig(config: PaymentConfig): PaymentConfig {
  validateConfig(config)
  return {
    providers: { ...config.providers },
    environment: config.environment,
    defaultCurrency: config.defaultCurrency,
  }
}

/**
 * Create a partial configuration (useful for testing)
 *
 * @param partial - Partial configuration
 * @returns Full configuration with defaults
 */
export function createPartialConfig(partial: Partial<PaymentConfig>): PaymentConfig {
  return {
    providers: partial.providers ?? {},
    environment: partial.environment ?? 'sandbox',
    defaultCurrency: partial.defaultCurrency ?? 'USD',
  }
}

// ============================================================================
// Configuration Utilities
// ============================================================================

/**
 * Check which providers are configured
 */
export function getConfiguredProviders(config: PaymentConfig): ConfiguredProviderAvailability {
  const availability: ConfiguredProviderAvailability = {}

  for (const [name, providerConfig] of Object.entries(config.providers)) {
    availability[name] = providerConfig !== undefined && Object.keys(providerConfig).length > 0
  }

  return availability
}

/**
 * Get list of configured provider names
 */
export function getConfiguredProviderList(config: PaymentConfig): string[] {
  const availability = getConfiguredProviders(config)
  return Object.entries(availability)
    .filter(([, isAvailable]) => isAvailable)
    .map(([name]) => name)
}

/**
 * Check if configuration is valid for production
 */
export function isProductionReady(config: PaymentConfig): boolean {
  const providers = getConfiguredProviderList(config)
  return config.environment === 'production' && providers.length > 0
}

/**
 * Validate configuration has at least one provider
 */
export function validateConfig(config: PaymentConfig): void {
  const providers = getConfiguredProviderList(config)

  if (providers.length === 0) {
    throw new Error(
      'Payment configuration error: At least one payment provider must be configured'
    )
  }
}
