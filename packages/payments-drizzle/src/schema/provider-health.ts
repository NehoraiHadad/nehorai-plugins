/**
 * @nehorai/payments-drizzle - Provider Health Schema
 *
 * Tracks payment provider health for circuit breaker pattern.
 * Used for intelligent failover when providers experience issues.
 */

import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core'

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Circuit breaker states
 */
export type CircuitBreakerState = 'closed' | 'open' | 'half_open'

// ============================================================================
// Schema Definition
// ============================================================================

/**
 * Provider health table
 * Tracks payment provider health for circuit breaker pattern.
 * Used for intelligent failover when providers experience issues.
 */
export const providerHealth = pgTable(
  'payment_provider_health',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Provider identification
    provider: text('provider').notNull(), // stripe, hyp, cardcom

    // Circuit breaker state
    circuit_state: text('circuit_state')
      .$type<CircuitBreakerState>()
      .notNull()
      .default('closed'),

    // Failure tracking
    failure_count: text('failure_count').default('0'),
    success_count: text('success_count').default('0'),
    last_failure_at: timestamp('last_failure_at', { withTimezone: true }),
    last_success_at: timestamp('last_success_at', { withTimezone: true }),

    // Circuit breaker timing
    circuit_opened_at: timestamp('circuit_opened_at', { withTimezone: true }),
    next_retry_at: timestamp('next_retry_at', { withTimezone: true }),

    // Performance metrics
    avg_latency_ms: numeric('avg_latency_ms'),
    error_rate: numeric('error_rate'), // 0-1
    request_count_window: text('request_count_window').default('0'),

    // Health check results
    last_health_check_at: timestamp('last_health_check_at', { withTimezone: true }),
    health_check_result: jsonb('health_check_result').$type<{
      healthy: boolean
      latency_ms?: number
      error?: string
    }>(),

    // Timestamps
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // One record per provider
    providerUnique: unique('provider_health_provider_unique').on(table.provider),
    // Performance indexes
    circuitStateIdx: index('provider_health_circuit_state_idx').on(
      table.circuit_state
    ),
    nextRetryIdx: index('provider_health_next_retry_idx').on(table.next_retry_at),
  })
)
