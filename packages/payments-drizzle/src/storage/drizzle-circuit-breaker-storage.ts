/**
 * @nehorai/payments-drizzle - Drizzle Circuit Breaker Storage
 *
 * Database-backed storage implementation using the existing provider_health table.
 * Suitable for serverless deployments and multi-instance environments.
 *
 * Benefits:
 * - State persists across deployments
 * - Shared state across multiple instances (serverless-friendly)
 * - Uses existing provider_health table (no migration needed)
 *
 * Usage:
 * ```typescript
 * const repos = createDrizzleRepositories(db);
 * const storage = new DrizzleCircuitBreakerStorage(repos.providerHealth);
 * const circuitBreaker = new CircuitBreaker({ storage });
 * ```
 */

import type { PaymentProvider } from '@nehorai/payments/types'
import type { IProviderHealthRepository } from '@nehorai/payments/repository'
import type {
  ICircuitBreakerStorage,
  CircuitBreakerStateRecord,
  StoredCircuitState,
} from '@nehorai/payments/services'

// ============================================================================
// Drizzle Storage Implementation
// ============================================================================

/**
 * Drizzle-based implementation of ICircuitBreakerStorage
 *
 * Uses the existing provider_health table via IProviderHealthRepository.
 * Perfect for serverless environments (Vercel, AWS Lambda) where
 * in-memory state doesn't persist between invocations.
 */
export class DrizzleCircuitBreakerStorage implements ICircuitBreakerStorage {
  private repo: IProviderHealthRepository

  constructor(providerHealthRepository: IProviderHealthRepository) {
    this.repo = providerHealthRepository
  }

  async getState(provider: PaymentProvider): Promise<CircuitBreakerStateRecord | null> {
    try {
      const health = await this.repo.findByProvider(provider)
      if (!health) return null

      return this.mapToStateRecord(provider, health)
    } catch (error) {
      console.error(`[DrizzleCircuitBreakerStorage] Failed to get state for ${provider}:`, error)
      return null
    }
  }

  async setState(provider: PaymentProvider, state: CircuitBreakerStateRecord): Promise<void> {
    try {
      // Ensure record exists
      await this.repo.getOrCreate(provider)

      // Update with new state
      await this.repo.update(provider, {
        circuitState: state.state,
        failureCount: state.failureCount,
        successCount: state.successCount,
        lastFailureAt: state.lastFailure ?? undefined,
        circuitOpenedAt: state.openedAt ?? undefined,
        nextRetryAt: state.nextRetryAt ?? undefined,
      })
    } catch (error) {
      console.error(`[DrizzleCircuitBreakerStorage] Failed to set state for ${provider}:`, error)
      throw error
    }
  }

  async getAllStates(): Promise<Map<PaymentProvider, CircuitBreakerStateRecord>> {
    try {
      const allHealth = await this.repo.findAll()
      const states = new Map<PaymentProvider, CircuitBreakerStateRecord>()

      for (const health of allHealth) {
        const provider = health.provider as PaymentProvider
        states.set(provider, this.mapToStateRecord(provider, health))
      }

      return states
    } catch (error) {
      console.error('[DrizzleCircuitBreakerStorage] Failed to get all states:', error)
      return new Map()
    }
  }

  async deleteState(provider: PaymentProvider): Promise<void> {
    try {
      await this.repo.resetStats(provider)
      await this.repo.closeCircuit(provider)
    } catch (error) {
      console.error(`[DrizzleCircuitBreakerStorage] Failed to delete state for ${provider}:`, error)
      throw error
    }
  }

  async getOpenCircuits(): Promise<PaymentProvider[]> {
    try {
      const openHealth = await this.repo.findOpenCircuits()
      return openHealth.map((h) => h.provider as PaymentProvider)
    } catch (error) {
      console.error('[DrizzleCircuitBreakerStorage] Failed to get open circuits:', error)
      return []
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      // Try a simple read operation to verify database connectivity
      await this.repo.findAll()
      return true
    } catch (error) {
      console.error('[DrizzleCircuitBreakerStorage] Health check failed:', error)
      return false
    }
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private mapToStateRecord(
    provider: PaymentProvider,
    health: {
      circuitState: string
      failureCount: number
      successCount: number
      lastFailureAt: Date | null
      circuitOpenedAt: Date | null
      nextRetryAt: Date | null
    }
  ): CircuitBreakerStateRecord {
    return {
      provider,
      state: health.circuitState as StoredCircuitState,
      failureCount: health.failureCount,
      successCount: health.successCount,
      lastFailure: health.lastFailureAt,
      openedAt: health.circuitOpenedAt,
      nextRetryAt: health.nextRetryAt,
    }
  }
}

// ============================================================================
// Factory Helper
// ============================================================================

/**
 * Create a Drizzle-based circuit breaker storage
 *
 * Convenience function for creating storage with a provider health repository.
 *
 * @param providerHealthRepo - The Drizzle provider health repository
 * @returns DrizzleCircuitBreakerStorage instance
 */
export function createDrizzleCircuitBreakerStorage(
  providerHealthRepo: IProviderHealthRepository
): DrizzleCircuitBreakerStorage {
  return new DrizzleCircuitBreakerStorage(providerHealthRepo)
}
