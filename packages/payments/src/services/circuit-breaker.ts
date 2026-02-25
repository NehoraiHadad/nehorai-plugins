/**
 * @nehorai/payments - Circuit Breaker Service
 *
 * Implements the circuit breaker pattern for payment provider resilience.
 * Prevents cascading failures by temporarily disabling unhealthy providers.
 *
 * States:
 * - CLOSED: Normal operation, all requests pass through
 * - OPEN: Provider disabled, all requests fail fast
 * - HALF_OPEN: Testing if provider recovered
 */

import type { PaymentProvider } from '../types/index.js'
import type {
  ICircuitBreakerStorage,
  CircuitBreakerStateRecord,
} from './circuit-breaker-storage.interface.js'
import { createDefaultState } from './circuit-breaker-storage.interface.js'
import { InMemoryCircuitBreakerStorage } from './in-memory-storage.js'

// ============================================================================
// Configuration
// ============================================================================

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number
  /** Time in ms before attempting to close circuit */
  resetTimeoutMs: number
  /** Max requests allowed in half-open state */
  halfOpenMaxRequests: number
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 60000, // 1 minute
  halfOpenMaxRequests: 3,
}

// ============================================================================
// Types
// ============================================================================

export type CircuitState = 'closed' | 'open' | 'half_open'

export interface CircuitBreakerState {
  provider: PaymentProvider
  state: CircuitState
  failureCount: number
  successCount: number
  lastFailure: Date | null
  openedAt: Date | null
  nextRetryAt: Date | null
}

/**
 * Circuit breaker dependencies (for dependency injection)
 */
export interface CircuitBreakerDeps {
  /** Storage implementation (optional, defaults to in-memory) */
  storage?: ICircuitBreakerStorage
  /** Configuration overrides */
  config?: Partial<CircuitBreakerConfig>
}

// ============================================================================
// Circuit Breaker Service
// ============================================================================

export class CircuitBreaker {
  private config: CircuitBreakerConfig
  private storage: ICircuitBreakerStorage

  constructor(deps: CircuitBreakerDeps = {}) {
    this.config = { ...DEFAULT_CONFIG, ...deps.config }
    this.storage = deps.storage ?? new InMemoryCircuitBreakerStorage()
  }

  /**
   * Check if a request can be executed for a provider
   */
  async canExecute(provider: PaymentProvider): Promise<boolean> {
    const state = await this.getState(provider)

    switch (state.state) {
      case 'closed':
        return true

      case 'open':
        if (state.nextRetryAt && Date.now() >= state.nextRetryAt.getTime()) {
          await this.transitionTo(provider, 'half_open')
          return true
        }
        return false

      case 'half_open':
        return state.failureCount < this.config.halfOpenMaxRequests
    }
  }

  /**
   * Record a successful request
   */
  async recordSuccess(provider: PaymentProvider): Promise<void> {
    const state = await this.getState(provider)

    if (state.state === 'half_open') {
      state.successCount++
      if (state.successCount >= this.config.halfOpenMaxRequests) {
        await this.transitionTo(provider, 'closed')
        return
      }
    } else if (state.state === 'closed') {
      state.failureCount = 0
    }

    await this.storage.setState(provider, state)
  }

  /**
   * Record a failed request
   */
  async recordFailure(provider: PaymentProvider): Promise<void> {
    const state = await this.getState(provider)

    state.failureCount++
    state.lastFailure = new Date()

    if (state.state === 'half_open') {
      await this.transitionTo(provider, 'open')
    } else if (state.state === 'closed') {
      if (state.failureCount >= this.config.failureThreshold) {
        await this.transitionTo(provider, 'open')
      } else {
        await this.storage.setState(provider, state)
      }
    } else {
      await this.storage.setState(provider, state)
    }
  }

  /**
   * Get current state for a provider
   */
  async getState(provider: PaymentProvider): Promise<CircuitBreakerState> {
    const stored = await this.storage.getState(provider)
    return stored ?? createDefaultState(provider)
  }

  /**
   * Check if circuit is open (provider unavailable)
   */
  isOpen(provider: PaymentProvider): boolean {
    return this.isOpenSync(provider)
  }

  /**
   * Async version of isOpen
   */
  async isOpenAsync(provider: PaymentProvider): Promise<boolean> {
    const state = await this.getState(provider)
    return state.state === 'open'
  }

  /**
   * Manually reset a provider's circuit
   */
  async reset(provider: PaymentProvider): Promise<void> {
    await this.storage.setState(provider, createDefaultState(provider))
  }

  /**
   * Get all providers with open circuits
   */
  async getOpenCircuits(): Promise<PaymentProvider[]> {
    return this.storage.getOpenCircuits()
  }

  /**
   * Get the storage instance (useful for testing)
   */
  getStorage(): ICircuitBreakerStorage {
    return this.storage
  }

  /**
   * Get configuration (useful for testing)
   */
  getConfig(): CircuitBreakerConfig {
    return { ...this.config }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  private async transitionTo(provider: PaymentProvider, newState: CircuitState): Promise<void> {
    const state = await this.getState(provider)
    const now = new Date()

    state.state = newState

    if (newState === 'open') {
      state.openedAt = now
      state.nextRetryAt = new Date(now.getTime() + this.config.resetTimeoutMs)
      console.warn(
        `[CIRCUIT_BREAKER] Circuit OPENED for ${provider}. ` +
          `Retry at: ${state.nextRetryAt.toISOString()}`
      )
    } else if (newState === 'half_open') {
      state.failureCount = 0
      state.successCount = 0
      console.info(`[CIRCUIT_BREAKER] Circuit HALF_OPEN for ${provider}`)
    } else if (newState === 'closed') {
      state.failureCount = 0
      state.successCount = 0
      state.openedAt = null
      state.nextRetryAt = null
      console.info(`[CIRCUIT_BREAKER] Circuit CLOSED for ${provider}`)
    }

    await this.storage.setState(provider, state)
  }

  /**
   * Synchronous check for backward compatibility
   * Note: This always returns false for database-backed storage
   */
  private isOpenSync(provider: PaymentProvider): boolean {
    if (this.storage instanceof InMemoryCircuitBreakerStorage) {
      const state = this.storage.getStateSync(provider)
      return state?.state === 'open'
    }
    return false
  }
}

// ============================================================================
// Singleton Pattern (Backward Compatible)
// ============================================================================

let circuitBreakerInstance: CircuitBreaker | null = null
let defaultStorage: InMemoryCircuitBreakerStorage | null = null

/**
 * Get or create singleton CircuitBreaker instance
 */
export function getCircuitBreaker(config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
  if (!circuitBreakerInstance) {
    if (!defaultStorage) {
      defaultStorage = new InMemoryCircuitBreakerStorage()
    }
    circuitBreakerInstance = new CircuitBreaker({
      storage: defaultStorage,
      config,
    })
  }
  return circuitBreakerInstance
}

/**
 * Create a new CircuitBreaker with custom dependencies
 */
export function createCircuitBreaker(deps: CircuitBreakerDeps = {}): CircuitBreaker {
  return new CircuitBreaker(deps)
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetCircuitBreaker(): void {
  circuitBreakerInstance = null
  if (defaultStorage) {
    defaultStorage.clear()
  }
  defaultStorage = null
}
