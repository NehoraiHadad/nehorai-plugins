/**
 * @nehorai/payments - Circuit Breaker Storage Interface
 *
 * Abstracts storage for circuit breaker state, enabling:
 * - In-memory storage (default, for single-instance deployments)
 * - Database storage (for multi-instance/serverless deployments)
 * - Redis storage (for high-performance distributed systems)
 */

import type { PaymentProvider } from '../types/index.js'

// ============================================================================
// Circuit Breaker State (Storage-Agnostic)
// ============================================================================

/**
 * Circuit breaker states
 */
export type StoredCircuitState = 'closed' | 'open' | 'half_open'

/**
 * Circuit breaker state record
 *
 * This is the state that gets persisted by storage implementations.
 */
export interface CircuitBreakerStateRecord {
  provider: PaymentProvider
  state: StoredCircuitState
  failureCount: number
  successCount: number
  lastFailure: Date | null
  openedAt: Date | null
  nextRetryAt: Date | null
}

// ============================================================================
// Storage Interface
// ============================================================================

/**
 * Storage interface for circuit breaker state
 *
 * Implement this interface to provide custom storage backends:
 * - InMemoryCircuitBreakerStorage (default)
 * - Database-backed storage (uses provider_health table)
 * - Redis-backed storage (for high-performance needs)
 */
export interface ICircuitBreakerStorage {
  getState(provider: PaymentProvider): Promise<CircuitBreakerStateRecord | null>

  setState(provider: PaymentProvider, state: CircuitBreakerStateRecord): Promise<void>

  getAllStates(): Promise<Map<PaymentProvider, CircuitBreakerStateRecord>>

  deleteState(provider: PaymentProvider): Promise<void>

  getOpenCircuits(): Promise<PaymentProvider[]>

  isHealthy(): Promise<boolean>
}

// ============================================================================
// Default State Factory
// ============================================================================

/**
 * Create default (closed) state for a provider
 */
export function createDefaultState(provider: PaymentProvider): CircuitBreakerStateRecord {
  return {
    provider,
    state: 'closed',
    failureCount: 0,
    successCount: 0,
    lastFailure: null,
    openedAt: null,
    nextRetryAt: null,
  }
}

/**
 * Check if state indicates circuit is open
 */
export function isCircuitOpen(state: CircuitBreakerStateRecord | null): boolean {
  return state?.state === 'open'
}

/**
 * Check if circuit should attempt half-open transition
 */
export function shouldAttemptHalfOpen(state: CircuitBreakerStateRecord | null): boolean {
  if (!state || state.state !== 'open') return false
  if (!state.nextRetryAt) return false

  return Date.now() >= state.nextRetryAt.getTime()
}
