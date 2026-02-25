/**
 * @nehorai/payments Repository - Provider Health Interface
 *
 * Defines operations for provider health/circuit breaker persistence.
 * Used for tracking provider availability and performance.
 */

import type { ProviderName } from './transaction.repository.js'

// ============================================================================
// Provider Health Types (Database-agnostic)
// ============================================================================

/**
 * Circuit breaker states
 */
export type CircuitBreakerState = 'closed' | 'open' | 'half_open'

/**
 * Health check result
 */
export interface HealthCheckResult {
  healthy: boolean
  latencyMs?: number
  error?: string
}

/**
 * Provider health entity
 */
export interface ProviderHealth {
  id: string
  provider: ProviderName
  circuitState: CircuitBreakerState
  failureCount: number
  successCount: number
  lastFailureAt: Date | null
  lastSuccessAt: Date | null
  circuitOpenedAt: Date | null
  nextRetryAt: Date | null
  avgLatencyMs: number | null
  errorRate: number | null
  requestCountWindow: number
  lastHealthCheckAt: Date | null
  healthCheckResult: HealthCheckResult | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Create provider health input
 */
export interface CreateProviderHealthInput {
  provider: ProviderName
  circuitState?: CircuitBreakerState
}

/**
 * Update provider health input
 */
export interface UpdateProviderHealthInput {
  circuitState?: CircuitBreakerState
  failureCount?: number
  successCount?: number
  lastFailureAt?: Date
  lastSuccessAt?: Date
  circuitOpenedAt?: Date
  nextRetryAt?: Date
  avgLatencyMs?: number
  errorRate?: number
  requestCountWindow?: number
  lastHealthCheckAt?: Date
  healthCheckResult?: HealthCheckResult
}

// ============================================================================
// Provider Health Repository Interface
// ============================================================================

/**
 * Provider health repository interface
 */
export interface IProviderHealthRepository {
  findByProvider(provider: ProviderName): Promise<ProviderHealth | null>

  getOrCreate(provider: ProviderName): Promise<ProviderHealth>

  update(provider: ProviderName, data: UpdateProviderHealthInput): Promise<ProviderHealth | null>

  findAll(): Promise<ProviderHealth[]>

  recordSuccess(provider: ProviderName, latencyMs: number): Promise<void>

  recordFailure(provider: ProviderName, error?: string): Promise<void>

  openCircuit(provider: ProviderName, retryAfterMs: number): Promise<void>

  closeCircuit(provider: ProviderName): Promise<void>

  halfOpenCircuit(provider: ProviderName): Promise<void>

  updateHealthCheck(provider: ProviderName, result: HealthCheckResult): Promise<void>

  findOpenCircuits(): Promise<ProviderHealth[]>

  findReadyForRetry(): Promise<ProviderHealth[]>

  resetStats(provider: ProviderName): Promise<void>

  updateErrorRate(provider: ProviderName): Promise<number>
}
