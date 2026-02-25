/**
 * @nehorai/payments-drizzle - Drizzle Provider Health Repository
 *
 * Implements IProviderHealthRepository using Drizzle ORM.
 * Manages circuit breaker state and provider metrics.
 */

import { eq, or, sql } from 'drizzle-orm'
import type { DrizzleDB } from './base-drizzle.repository.js'
import { parseNumeric } from './base-drizzle.repository.js'
import { providerHealth } from '../schema/index.js'
import type {
  IProviderHealthRepository,
  ProviderHealth,
  UpdateProviderHealthInput,
  HealthCheckResult,
  CircuitBreakerState,
  ProviderName,
} from '@nehorai/payments/repository'

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Map database row to ProviderHealth entity
 */
function mapToProviderHealth(row: typeof providerHealth.$inferSelect): ProviderHealth {
  return {
    id: row.id,
    provider: row.provider as ProviderName,
    circuitState: row.circuit_state as CircuitBreakerState,
    failureCount: parseInt(row.failure_count ?? '0', 10),
    successCount: parseInt(row.success_count ?? '0', 10),
    lastFailureAt: row.last_failure_at,
    lastSuccessAt: row.last_success_at,
    circuitOpenedAt: row.circuit_opened_at,
    nextRetryAt: row.next_retry_at,
    avgLatencyMs: row.avg_latency_ms ? parseNumeric(row.avg_latency_ms) : null,
    errorRate: row.error_rate ? parseNumeric(row.error_rate) : null,
    requestCountWindow: parseInt(row.request_count_window ?? '0', 10),
    lastHealthCheckAt: row.last_health_check_at,
    healthCheckResult: row.health_check_result as HealthCheckResult | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ============================================================================
// Repository Implementation
// ============================================================================

/**
 * Drizzle implementation of IProviderHealthRepository
 */
export class DrizzleProviderHealthRepository implements IProviderHealthRepository {
  constructor(private db: DrizzleDB) {}

  async findByProvider(provider: ProviderName): Promise<ProviderHealth | null> {
    const result = await this.db
      .select()
      .from(providerHealth)
      .where(eq(providerHealth.provider, provider))
      .limit(1)

    return result[0] ? mapToProviderHealth(result[0]) : null
  }

  async getOrCreate(provider: ProviderName): Promise<ProviderHealth> {
    const existing = await this.findByProvider(provider)
    if (existing) return existing

    const result = await this.db
      .insert(providerHealth)
      .values({
        provider,
        circuit_state: 'closed',
      })
      .returning()

    return mapToProviderHealth(result[0])
  }

  async update(
    provider: ProviderName,
    data: UpdateProviderHealthInput
  ): Promise<ProviderHealth | null> {
    const updateData: Partial<typeof providerHealth.$inferInsert> = {
      updated_at: new Date(),
    }

    if (data.circuitState !== undefined) updateData.circuit_state = data.circuitState
    if (data.failureCount !== undefined) updateData.failure_count = String(data.failureCount)
    if (data.successCount !== undefined) updateData.success_count = String(data.successCount)
    if (data.lastFailureAt !== undefined) updateData.last_failure_at = data.lastFailureAt
    if (data.lastSuccessAt !== undefined) updateData.last_success_at = data.lastSuccessAt
    if (data.circuitOpenedAt !== undefined) updateData.circuit_opened_at = data.circuitOpenedAt
    if (data.nextRetryAt !== undefined) updateData.next_retry_at = data.nextRetryAt
    if (data.avgLatencyMs !== undefined) updateData.avg_latency_ms = String(data.avgLatencyMs)
    if (data.errorRate !== undefined) updateData.error_rate = String(data.errorRate)
    if (data.requestCountWindow !== undefined)
      updateData.request_count_window = String(data.requestCountWindow)
    if (data.lastHealthCheckAt !== undefined)
      updateData.last_health_check_at = data.lastHealthCheckAt
    if (data.healthCheckResult !== undefined)
      updateData.health_check_result = data.healthCheckResult

    const result = await this.db
      .update(providerHealth)
      .set(updateData)
      .where(eq(providerHealth.provider, provider))
      .returning()

    return result[0] ? mapToProviderHealth(result[0]) : null
  }

  async findAll(): Promise<ProviderHealth[]> {
    const result = await this.db
      .select()
      .from(providerHealth)
      .orderBy(sql`${providerHealth.provider} ASC`)

    return result.map(mapToProviderHealth)
  }

  async recordSuccess(provider: ProviderName, latencyMs: number): Promise<void> {
    await this.getOrCreate(provider)

    await this.db
      .update(providerHealth)
      .set({
        success_count: sql`CAST(${providerHealth.success_count} AS INTEGER) + 1`,
        request_count_window: sql`CAST(${providerHealth.request_count_window} AS INTEGER) + 1`,
        last_success_at: new Date(),
        avg_latency_ms: sql`CASE
          WHEN ${providerHealth.avg_latency_ms} IS NULL THEN ${latencyMs}
          ELSE (CAST(${providerHealth.avg_latency_ms} AS DECIMAL) * 0.9 + ${latencyMs} * 0.1)
        END`,
        updated_at: new Date(),
      })
      .where(eq(providerHealth.provider, provider))
  }

  async recordFailure(provider: ProviderName, error?: string): Promise<void> {
    await this.getOrCreate(provider)

    const updateData: Partial<typeof providerHealth.$inferInsert> = {
      last_failure_at: new Date(),
      updated_at: new Date(),
    }

    // Store error in health check result if provided
    if (error) {
      updateData.health_check_result = { healthy: false, error }
    }

    await this.db
      .update(providerHealth)
      .set({
        ...updateData,
        failure_count: sql`CAST(${providerHealth.failure_count} AS INTEGER) + 1`,
        request_count_window: sql`CAST(${providerHealth.request_count_window} AS INTEGER) + 1`,
      })
      .where(eq(providerHealth.provider, provider))
  }

  async openCircuit(provider: ProviderName, retryAfterMs: number): Promise<void> {
    const now = new Date()
    const nextRetry = new Date(now.getTime() + retryAfterMs)

    await this.getOrCreate(provider)

    await this.db
      .update(providerHealth)
      .set({
        circuit_state: 'open',
        circuit_opened_at: now,
        next_retry_at: nextRetry,
        updated_at: now,
      })
      .where(eq(providerHealth.provider, provider))
  }

  async closeCircuit(provider: ProviderName): Promise<void> {
    await this.db
      .update(providerHealth)
      .set({
        circuit_state: 'closed',
        circuit_opened_at: null,
        next_retry_at: null,
        failure_count: '0',
        updated_at: new Date(),
      })
      .where(eq(providerHealth.provider, provider))
  }

  async halfOpenCircuit(provider: ProviderName): Promise<void> {
    await this.db
      .update(providerHealth)
      .set({
        circuit_state: 'half_open',
        updated_at: new Date(),
      })
      .where(eq(providerHealth.provider, provider))
  }

  async updateHealthCheck(provider: ProviderName, result: HealthCheckResult): Promise<void> {
    await this.getOrCreate(provider)

    await this.db
      .update(providerHealth)
      .set({
        last_health_check_at: new Date(),
        health_check_result: result,
        updated_at: new Date(),
      })
      .where(eq(providerHealth.provider, provider))
  }

  async findOpenCircuits(): Promise<ProviderHealth[]> {
    const result = await this.db
      .select()
      .from(providerHealth)
      .where(eq(providerHealth.circuit_state, 'open'))

    return result.map(mapToProviderHealth)
  }

  async findReadyForRetry(): Promise<ProviderHealth[]> {
    const now = new Date()

    const result = await this.db
      .select()
      .from(providerHealth)
      .where(
        or(
          eq(providerHealth.circuit_state, 'half_open'),
          sql`${providerHealth.circuit_state} = 'open' AND ${providerHealth.next_retry_at} <= ${now}`
        )
      )

    return result.map(mapToProviderHealth)
  }

  async resetStats(provider: ProviderName): Promise<void> {
    await this.db
      .update(providerHealth)
      .set({
        failure_count: '0',
        success_count: '0',
        request_count_window: '0',
        avg_latency_ms: null,
        error_rate: null,
        updated_at: new Date(),
      })
      .where(eq(providerHealth.provider, provider))
  }

  async updateErrorRate(provider: ProviderName): Promise<number> {
    const health = await this.findByProvider(provider)
    if (!health || health.requestCountWindow === 0) return 0

    const errorRate = health.failureCount / health.requestCountWindow

    await this.db
      .update(providerHealth)
      .set({
        error_rate: String(errorRate),
        updated_at: new Date(),
      })
      .where(eq(providerHealth.provider, provider))

    return errorRate
  }
}
