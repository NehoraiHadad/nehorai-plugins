/**
 * @nehorai/payments - In-Memory Circuit Breaker Storage
 *
 * Default storage implementation using a Map for circuit breaker state.
 * Suitable for single-instance deployments and development.
 *
 * Limitations:
 * - State is lost on process restart
 * - Not shared across multiple instances (not serverless-friendly)
 */

import type { PaymentProvider } from '../types/index.js'
import type {
  ICircuitBreakerStorage,
  CircuitBreakerStateRecord,
} from './circuit-breaker-storage.interface.js'
import { createDefaultState } from './circuit-breaker-storage.interface.js'

// ============================================================================
// In-Memory Storage Implementation
// ============================================================================

/**
 * In-memory implementation of ICircuitBreakerStorage
 *
 * Uses a JavaScript Map for fast in-memory state storage.
 * This is the default storage and maintains backward compatibility.
 */
export class InMemoryCircuitBreakerStorage implements ICircuitBreakerStorage {
  protected internalStates: Map<PaymentProvider, CircuitBreakerStateRecord>

  constructor() {
    this.internalStates = new Map()
  }

  async getState(provider: PaymentProvider): Promise<CircuitBreakerStateRecord | null> {
    return this.internalStates.get(provider) ?? null
  }

  async setState(provider: PaymentProvider, state: CircuitBreakerStateRecord): Promise<void> {
    this.internalStates.set(provider, { ...state })
  }

  async getAllStates(): Promise<Map<PaymentProvider, CircuitBreakerStateRecord>> {
    return new Map(this.internalStates)
  }

  async deleteState(provider: PaymentProvider): Promise<void> {
    this.internalStates.delete(provider)
  }

  async getOpenCircuits(): Promise<PaymentProvider[]> {
    const open: PaymentProvider[] = []
    for (const [provider, state] of this.internalStates) {
      if (state.state === 'open') {
        open.push(provider)
      }
    }
    return open
  }

  async isHealthy(): Promise<boolean> {
    return true
  }

  /**
   * Clear all stored states (useful for testing)
   */
  clear(): void {
    this.internalStates.clear()
  }

  /**
   * Get current state count (useful for testing/debugging)
   */
  get size(): number {
    return this.internalStates.size
  }

  /**
   * Synchronous state access (for backward compatibility with CircuitBreaker.isOpen)
   *
   * Note: Only available on InMemoryCircuitBreakerStorage.
   * Database-backed storage cannot provide sync access.
   */
  getStateSync(provider: PaymentProvider): CircuitBreakerStateRecord | null {
    return this.internalStates.get(provider) ?? null
  }
}

// ============================================================================
// Singleton Factory
// ============================================================================

let defaultStorage: InMemoryCircuitBreakerStorage | null = null

/**
 * Get or create the default in-memory storage instance
 */
export function getInMemoryStorage(): InMemoryCircuitBreakerStorage {
  if (!defaultStorage) {
    defaultStorage = new InMemoryCircuitBreakerStorage()
  }
  return defaultStorage
}

/**
 * Reset the default storage instance (useful for testing)
 */
export function resetInMemoryStorage(): void {
  if (defaultStorage) {
    defaultStorage.clear()
  }
  defaultStorage = null
}

// ============================================================================
// Migration Helper
// ============================================================================

/**
 * Legacy state structure (for migration from old circuit breaker)
 */
export interface LegacyCircuitState {
  provider: PaymentProvider
  state: 'closed' | 'open' | 'half_open'
  failureCount: number
  successCount: number
  lastFailure: Date | null
  openedAt: Date | null
  nextRetryAt: Date | null
}

/**
 * Migrate from legacy Map storage to ICircuitBreakerStorage
 */
export async function migrateFromLegacyMap(
  legacyStates: Map<PaymentProvider, LegacyCircuitState>
): Promise<InMemoryCircuitBreakerStorage> {
  const storage = new InMemoryCircuitBreakerStorage()

  for (const [provider, state] of legacyStates) {
    const record: CircuitBreakerStateRecord = {
      provider: state.provider,
      state: state.state,
      failureCount: state.failureCount,
      successCount: state.successCount,
      lastFailure: state.lastFailure,
      openedAt: state.openedAt,
      nextRetryAt: state.nextRetryAt,
    }
    await storage.setState(provider, record)
  }

  return storage
}
