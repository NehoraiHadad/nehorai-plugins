/**
 * @nehorai/payments - Services Exports
 *
 * All service classes with full dependency injection support.
 */

// ============================================================================
// Payment Orchestrator
// ============================================================================

export {
  PaymentOrchestrator,
  createPaymentOrchestrator,
  type InitiatePaymentParams,
  type PaymentInitiationResult,
  type ConfirmPaymentParams,
  type PaymentConfirmationResult,
  type CapturePaymentParams,
  type PaymentCaptureResult,
  type PaymentOrchestratorDeps,
} from './payment-orchestrator.js'

// ============================================================================
// Routing Engine
// ============================================================================

export {
  RoutingEngine,
  getRoutingEngine,
  createRoutingEngine,
  resetRoutingEngine,
  type RoutingEngineDeps,
  type RoutingRules,
  type CardBinRule,
  type ProviderPriorityRule,
  type CurrencyRule,
} from './routing-engine.js'

// ============================================================================
// Circuit Breaker
// ============================================================================

export {
  CircuitBreaker,
  getCircuitBreaker,
  createCircuitBreaker,
  resetCircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitState,
  type CircuitBreakerState,
  type CircuitBreakerDeps,
} from './circuit-breaker.js'

// ============================================================================
// Circuit Breaker Storage Interface
// ============================================================================

export type {
  ICircuitBreakerStorage,
  CircuitBreakerStateRecord,
  StoredCircuitState,
} from './circuit-breaker-storage.interface.js'

export {
  createDefaultState,
  isCircuitOpen,
  shouldAttemptHalfOpen,
} from './circuit-breaker-storage.interface.js'

// ============================================================================
// Storage Implementations
// ============================================================================

export {
  InMemoryCircuitBreakerStorage,
  getInMemoryStorage,
  resetInMemoryStorage,
  migrateFromLegacyMap,
} from './in-memory-storage.js'
