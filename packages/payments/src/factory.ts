/**
 * @nehorai/payments - Service Factory
 *
 * Factory functions for creating payment service instances.
 * Framework-agnostic - can be used in any TypeScript application.
 *
 * Unlike the Podcasto-specific factory, this does NOT import any
 * provider implementations. Providers are registered by the caller.
 *
 * Usage:
 * ```typescript
 * import { createPaymentServices } from '@nehorai/payments';
 * import { StripeProvider } from '@nehorai/payments-stripe';
 *
 * const providers = new Map();
 * providers.set('stripe', new StripeProvider(config));
 *
 * const services = createPaymentServices({
 *   providers,
 *   config: myConfig,
 * });
 * ```
 */

import type { PaymentProvider } from './types/index.js'
import type { IPaymentProvider, IWebhookHandler } from './providers/interfaces/index.js'
import type { IPaymentRepositories } from './repository/interfaces/index.js'
import { PaymentOrchestrator } from './services/payment-orchestrator.js'
import {
  RoutingEngine,
  createRoutingEngine,
  resetRoutingEngine,
  type RoutingRules,
} from './services/routing-engine.js'
import {
  CircuitBreaker,
  createCircuitBreaker,
  resetCircuitBreaker,
  type CircuitBreakerConfig,
} from './services/circuit-breaker.js'
import type { ICircuitBreakerStorage } from './services/circuit-breaker-storage.interface.js'
import { InMemoryCircuitBreakerStorage } from './services/in-memory-storage.js'
import {
  type PaymentConfig,
  createPartialConfig,
} from './config/payment-config.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Full configuration for creating payment services
 */
export interface PaymentServicesConfig {
  /** Provider instances - callers must create and pass these in */
  providers: Map<PaymentProvider, IPaymentProvider>
  /** Webhook handler instances (optional) */
  webhookHandlers?: Map<PaymentProvider, IWebhookHandler>
  /** Payment configuration */
  config?: PaymentConfig
  /** Circuit breaker configuration */
  circuitBreaker?: Partial<CircuitBreakerConfig>
  /** Circuit breaker storage implementation */
  circuitBreakerStorage?: ICircuitBreakerStorage
  /** Routing rules for intelligent provider selection */
  routingRules?: RoutingRules
  /** Repository implementations (for database operations) */
  repositories?: IPaymentRepositories
}

/**
 * Created payment services
 */
export interface PaymentServices {
  /** Main payment orchestrator */
  orchestrator: PaymentOrchestrator
  /** Provider routing engine */
  routingEngine: RoutingEngine
  /** Circuit breaker for resilience */
  circuitBreaker: CircuitBreaker
  /** Map of available providers */
  providers: Map<PaymentProvider, IPaymentProvider>
  /** Map of webhook handlers */
  webhookHandlers: Map<PaymentProvider, IWebhookHandler>
  /** Current configuration */
  config: PaymentConfig
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create all payment services.
 *
 * Providers are passed in by the caller (no auto-discovery).
 * This factory only wires up the core services.
 *
 * @param options - Configuration options including provider instances
 * @returns PaymentServices instance with all components
 */
export function createPaymentServices(options: PaymentServicesConfig): PaymentServices {
  const config = options.config ?? createPartialConfig({})
  const providers = options.providers
  const webhookHandlers = options.webhookHandlers ?? new Map<PaymentProvider, IWebhookHandler>()

  if (providers.size === 0) {
    throw new Error('No payment providers provided. Pass at least one provider instance.')
  }

  // Create circuit breaker storage (use injected or default to in-memory)
  const circuitBreakerStorage = options.circuitBreakerStorage ?? new InMemoryCircuitBreakerStorage()

  // Create circuit breaker with storage
  const circuitBreaker = createCircuitBreaker({
    storage: circuitBreakerStorage,
    config: options.circuitBreaker,
  })

  // Create routing engine with injected config, circuit breaker, and routing rules
  const routingEngine = createRoutingEngine({
    config,
    circuitBreaker,
    routingRules: options.routingRules,
  })

  // Create orchestrator with all dependencies
  const orchestrator = new PaymentOrchestrator({
    providers,
    routingEngine,
    circuitBreaker,
  })

  return {
    orchestrator,
    routingEngine,
    circuitBreaker,
    providers,
    webhookHandlers,
    config,
  }
}

/**
 * Register a provider and optional webhook handler to existing services.
 *
 * Returns a new PaymentServices with the provider added.
 * The original services object is not mutated.
 */
export function registerProvider(
  services: PaymentServices,
  name: PaymentProvider,
  provider: IPaymentProvider,
  webhookHandler?: IWebhookHandler
): PaymentServices {
  const newProviders = new Map(services.providers)
  newProviders.set(name, provider)

  const newWebhookHandlers = new Map(services.webhookHandlers)
  if (webhookHandler) {
    newWebhookHandlers.set(name, webhookHandler)
  }

  // Re-create orchestrator with updated providers
  const orchestrator = new PaymentOrchestrator({
    providers: newProviders,
    routingEngine: services.routingEngine,
    circuitBreaker: services.circuitBreaker,
  })

  return {
    ...services,
    orchestrator,
    providers: newProviders,
    webhookHandlers: newWebhookHandlers,
  }
}

// ============================================================================
// Singleton Pattern
// ============================================================================

let servicesInstance: PaymentServices | null = null

/**
 * Get or create singleton PaymentOS services instance
 */
export function getPaymentServices(config?: PaymentServicesConfig): PaymentServices {
  if (!servicesInstance) {
    if (!config) {
      throw new Error('PaymentServices not initialized. Call with config on first use.')
    }
    servicesInstance = createPaymentServices(config)
  }
  return servicesInstance
}

/**
 * Reset singleton instance (useful for testing)
 */
export function resetPaymentServices(): void {
  servicesInstance = null
  resetCircuitBreaker()
  resetRoutingEngine()
}
