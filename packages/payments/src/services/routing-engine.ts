/**
 * @nehorai/payments - Routing Engine Service
 *
 * Intelligent payment routing based on configurable rules:
 * - Card BIN rules (match card ranges to preferred providers)
 * - Provider health (circuit breaker state)
 * - Transaction fees / provider priorities
 * - Currency support
 *
 * Unlike the Podcasto-specific version, this accepts generic RoutingRules
 * config instead of hardcoded Israeli card BIN ranges.
 */

import type { PaymentProvider } from '../types/index.js'
import type { IRoutingEngine, RoutingContext, RoutingDecision } from '../providers/interfaces/index.js'
import {
  type PaymentConfig,
  type ConfiguredProviderAvailability,
  getConfiguredProviders,
  createPartialConfig,
} from '../config/payment-config.js'
import { getCircuitBreaker, type CircuitBreaker } from './circuit-breaker.js'

// ============================================================================
// Routing Rules Types
// ============================================================================

/**
 * Rule for matching card BIN ranges to preferred providers
 */
export interface CardBinRule {
  ranges: Array<{ start: string; end: string; issuer?: string; country?: string }>
  preferredProvider: string
  priority?: number
}

/**
 * Provider priority configuration
 */
export interface ProviderPriorityRule {
  provider: string
  priority: number
  maxFeePercent: number
  supportsCurrency: string[]
  supportsRecurring: boolean
  isLocalGateway?: boolean
}

/**
 * Currency-specific routing rule
 */
export interface CurrencyRule {
  currency: string
  preferredProvider: string
}

/**
 * Generic routing rules configuration.
 * Injected at construction time instead of hardcoded.
 */
export interface RoutingRules {
  cardBinRules?: CardBinRule[]
  providerPriorities?: ProviderPriorityRule[]
  currencyRules?: CurrencyRule[]
}

// ============================================================================
// Types
// ============================================================================

/**
 * Routing engine dependencies (for dependency injection)
 */
export interface RoutingEngineDeps {
  /** Payment configuration (optional, defaults to empty config) */
  config?: PaymentConfig
  /** Circuit breaker instance (optional, defaults to singleton) */
  circuitBreaker?: CircuitBreaker
  /** Routing rules (optional, no rules means simple round-robin) */
  routingRules?: RoutingRules
}

// ============================================================================
// Internal Routing Helpers
// ============================================================================

function matchCardBinToRule(
  bin: string,
  rules: CardBinRule[]
): { rule: CardBinRule; issuer?: string; country?: string } | null {
  if (!bin || bin.length < 6) return null
  const binPrefix = bin.substring(0, 6)

  for (const rule of rules) {
    for (const range of rule.ranges) {
      if (binPrefix >= range.start && binPrefix <= range.end) {
        return { rule, issuer: range.issuer, country: range.country }
      }
    }
  }
  return null
}

function getOptimalProviderFromPriorities(
  matchedBin: boolean,
  currency: string,
  requiresRecurring: boolean,
  availableProviders: PaymentProvider[],
  priorities: ProviderPriorityRule[]
): PaymentProvider | null {
  const candidates = priorities.filter((p) =>
    availableProviders.includes(p.provider)
  )
  if (candidates.length === 0) return availableProviders[0] ?? null

  const suitable = candidates.filter((p) => {
    if (!p.supportsCurrency.includes(currency)) return false
    if (requiresRecurring && !p.supportsRecurring) return false
    return true
  })

  if (suitable.length === 0) {
    return candidates.sort((a, b) => a.priority - b.priority)[0]?.provider ?? null
  }

  // If card matched a BIN rule, prefer local gateways
  if (matchedBin) {
    const localProviders = suitable.filter((p) => p.isLocalGateway)
    if (localProviders.length > 0) {
      return localProviders.sort((a, b) => a.priority - b.priority)[0].provider
    }
  }

  return suitable.sort((a, b) => a.priority - b.priority)[0].provider
}

function getFallbackProvidersFromPriorities(
  primaryProvider: PaymentProvider,
  availableProviders: PaymentProvider[],
  priorities: ProviderPriorityRule[]
): PaymentProvider[] {
  return priorities
    .filter((p) =>
      p.provider !== primaryProvider &&
      availableProviders.includes(p.provider)
    )
    .sort((a, b) => a.priority - b.priority)
    .map((p) => p.provider)
}

function getProviderFeeFromPriorities(
  provider: PaymentProvider,
  priorities: ProviderPriorityRule[]
): number {
  const config = priorities.find((p) => p.provider === provider)
  return config?.maxFeePercent ?? 3.0
}

// ============================================================================
// Routing Engine Implementation
// ============================================================================

/**
 * Routing Engine Implementation
 *
 * Routes payments to optimal providers with automatic failover.
 * Uses injected RoutingRules instead of hardcoded locale-specific logic.
 */
export class RoutingEngine implements IRoutingEngine {
  private config: PaymentConfig
  private circuitBreaker: CircuitBreaker
  private routingRules: RoutingRules

  constructor(deps: RoutingEngineDeps = {}) {
    this.config = deps.config ?? createPartialConfig({})
    this.circuitBreaker = deps.circuitBreaker ?? getCircuitBreaker()
    this.routingRules = deps.routingRules ?? {}
  }

  /**
   * Determine optimal provider for a transaction
   */
  async route(context: RoutingContext): Promise<RoutingDecision> {
    const availability = getConfiguredProviders(this.config)
    const availableProviders = this.getProviderList(availability)

    if (availableProviders.length === 0) {
      throw new Error('No payment providers configured')
    }

    // If using saved payment method, must use same provider
    if (context.savedPaymentMethodId && context.savedPaymentMethodProvider) {
      return this.routeToSavedMethodProvider(context, availableProviders)
    }

    // Check card BIN against rules
    const binMatch = context.cardBin && this.routingRules.cardBinRules
      ? matchCardBinToRule(context.cardBin, this.routingRules.cardBinRules)
      : null

    // Check currency rules
    const currencyRule = this.routingRules.currencyRules?.find(
      (r) => r.currency === context.amount.currency
    )

    // Get healthy providers
    const healthyProviders = await this.getHealthyProviders(availableProviders)
    const availableHealthy = availableProviders.filter((p) => healthyProviders.includes(p))
    const effectiveProviders = availableHealthy.length > 0 ? availableHealthy : availableProviders

    // If BIN matched a rule and the preferred provider is available, use it
    if (binMatch && effectiveProviders.includes(binMatch.rule.preferredProvider)) {
      const provider = binMatch.rule.preferredProvider
      const fallbacks = this.getFallbackProviders(provider, availableProviders)
      const feePercent = this.getProviderFee(provider)

      return {
        provider,
        reason: binMatch.issuer
          ? `Card (${binMatch.issuer}) matched BIN rule, routed to preferred provider`
          : 'Card matched BIN rule, routed to preferred provider',
        fallbackProviders: fallbacks,
        estimatedFeePercent: feePercent,
        metadata: {
          matchedBinRule: true,
          cardIssuer: binMatch.issuer,
          cardCountry: binMatch.country,
        },
      }
    }

    // If currency rule matches and provider is available, use it
    if (currencyRule && effectiveProviders.includes(currencyRule.preferredProvider)) {
      const provider = currencyRule.preferredProvider
      const fallbacks = this.getFallbackProviders(provider, availableProviders)
      const feePercent = this.getProviderFee(provider)

      return {
        provider,
        reason: `Currency ${context.amount.currency} routed to preferred provider`,
        fallbackProviders: fallbacks,
        estimatedFeePercent: feePercent,
      }
    }

    // Use provider priorities if configured
    const priorities = this.routingRules.providerPriorities
    if (priorities && priorities.length > 0) {
      const provider = getOptimalProviderFromPriorities(
        !!binMatch,
        context.amount.currency,
        context.isRecurring,
        effectiveProviders,
        priorities
      )

      if (provider) {
        const fallbacks = getFallbackProvidersFromPriorities(provider, availableProviders, priorities)
        const feePercent = getProviderFeeFromPriorities(provider, priorities)

        return {
          provider,
          reason: `Selected ${provider} based on priority rules`,
          fallbackProviders: fallbacks,
          estimatedFeePercent: feePercent,
          metadata: {
            matchedBinRule: !!binMatch,
            cardIssuer: binMatch?.issuer,
            cardCountry: binMatch?.country,
          },
        }
      }
    }

    // Fallback: use first available provider
    const provider = effectiveProviders[0]
    const fallbacks = effectiveProviders.slice(1)

    return {
      provider,
      reason: `Default routing to ${provider}`,
      fallbackProviders: fallbacks,
      estimatedFeePercent: this.getProviderFee(provider),
    }
  }

  /**
   * Get next provider after a failure
   */
  async getFailoverProvider(
    failedProvider: PaymentProvider,
    _context: RoutingContext
  ): Promise<PaymentProvider | null> {
    const availability = getConfiguredProviders(this.config)
    const availableProviders = this.getProviderList(availability)
    const healthyProviders = await this.getHealthyProviders(availableProviders)

    const fallbacks = this.getFallbackProviders(failedProvider, availableProviders)

    for (const provider of fallbacks) {
      if (healthyProviders.includes(provider)) {
        return provider
      }
    }

    return fallbacks[0] ?? null
  }

  /**
   * Check if a card BIN matches any configured rule
   */
  matchCardBin(bin: string): boolean {
    if (!this.routingRules.cardBinRules) return false
    return matchCardBinToRule(bin, this.routingRules.cardBinRules) !== null
  }

  /**
   * Get all available (healthy) providers
   */
  async getAvailableProviders(): Promise<PaymentProvider[]> {
    const availability = getConfiguredProviders(this.config)
    const configured = this.getProviderList(availability)
    return this.getHealthyProviders(configured)
  }

  /**
   * Quick recommendation without full context
   */
  async getQuickRecommendation(
    currency: string,
    isRecurring: boolean
  ): Promise<PaymentProvider | null> {
    const availability = getConfiguredProviders(this.config)
    const available = this.getProviderList(availability)

    if (available.length === 0) return null

    // Check currency rules first
    const currencyRule = this.routingRules.currencyRules?.find(
      (r) => r.currency === currency
    )
    if (currencyRule && available.includes(currencyRule.preferredProvider)) {
      return currencyRule.preferredProvider
    }

    // Use provider priorities if configured
    const priorities = this.routingRules.providerPriorities
    if (priorities && priorities.length > 0) {
      return getOptimalProviderFromPriorities(false, currency, isRecurring, available, priorities)
    }

    return available[0] ?? null
  }

  /**
   * Get current configuration (for testing/debugging)
   */
  getConfig(): PaymentConfig {
    return this.config
  }

  /**
   * Get circuit breaker instance (for testing/debugging)
   */
  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker
  }

  /**
   * Get routing rules (for testing/debugging)
   */
  getRoutingRules(): RoutingRules {
    return this.routingRules
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private getProviderList(availability: ConfiguredProviderAvailability): PaymentProvider[] {
    const providers: PaymentProvider[] = []
    for (const [name, isAvailable] of Object.entries(availability)) {
      if (isAvailable) providers.push(name)
    }
    return providers
  }

  private async getHealthyProviders(providers: PaymentProvider[]): Promise<PaymentProvider[]> {
    const healthy: PaymentProvider[] = []
    for (const provider of providers) {
      const isOpen = await this.circuitBreaker.isOpenAsync(provider)
      if (!isOpen) {
        healthy.push(provider)
      }
    }
    return healthy
  }

  private routeToSavedMethodProvider(
    context: RoutingContext,
    availableProviders: PaymentProvider[]
  ): RoutingDecision {
    const provider = context.savedPaymentMethodProvider!

    if (!availableProviders.includes(provider)) {
      throw new Error(`Saved payment method provider '${provider}' is not available`)
    }

    return {
      provider,
      reason: 'Using saved payment method provider',
      fallbackProviders: [],
      estimatedFeePercent: this.getProviderFee(provider),
    }
  }

  private getFallbackProviders(
    primaryProvider: PaymentProvider,
    availableProviders: PaymentProvider[]
  ): PaymentProvider[] {
    const priorities = this.routingRules.providerPriorities
    if (priorities && priorities.length > 0) {
      return getFallbackProvidersFromPriorities(primaryProvider, availableProviders, priorities)
    }
    return availableProviders.filter((p) => p !== primaryProvider)
  }

  private getProviderFee(provider: PaymentProvider): number {
    const priorities = this.routingRules.providerPriorities
    if (priorities && priorities.length > 0) {
      return getProviderFeeFromPriorities(provider, priorities)
    }
    return 3.0 // Default fee if no priorities configured
  }
}

// ============================================================================
// Singleton Pattern (Backward Compatible)
// ============================================================================

let routingEngineInstance: RoutingEngine | null = null

/**
 * Get or create singleton RoutingEngine instance
 */
export function getRoutingEngine(): RoutingEngine {
  if (!routingEngineInstance) {
    routingEngineInstance = new RoutingEngine()
  }
  return routingEngineInstance
}

/**
 * Create a new RoutingEngine with custom dependencies
 */
export function createRoutingEngine(deps: RoutingEngineDeps = {}): RoutingEngine {
  return new RoutingEngine(deps)
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetRoutingEngine(): void {
  routingEngineInstance = null
}
