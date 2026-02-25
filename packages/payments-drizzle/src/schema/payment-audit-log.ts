/**
 * @nehorai/payments-drizzle - Payment Audit Log Schema
 *
 * Immutable audit trail for all payment state changes.
 * Used for debugging, compliance, and dispute resolution.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core'

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Audit log action types
 */
export type AuditLogAction =
  | 'created'
  | 'status_changed'
  | 'authorized'
  | 'captured'
  | 'voided'
  | 'refund_initiated'
  | 'refund_completed'
  | 'webhook_received'
  | 'webhook_processed'
  | 'error_occurred'
  | 'retry_attempted'
  | 'manual_intervention'

/**
 * Who/what triggered the action
 */
export type AuditLogTrigger =
  | 'user'
  | 'webhook'
  | 'system'
  | 'admin'
  | 'cron'
  | 'api'

// ============================================================================
// Schema Definition
// ============================================================================

/**
 * Payment audit log table
 * Immutable audit trail for all payment state changes.
 * Used for debugging, compliance, and dispute resolution.
 */
export const paymentAuditLog = pgTable(
  'payment_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // What transaction was affected
    transaction_id: uuid('transaction_id').notNull(),

    // What action occurred
    action: text('action').$type<AuditLogAction>().notNull(),

    // State before and after
    previous_state: jsonb('previous_state'),
    new_state: jsonb('new_state').notNull(),

    // Who/what triggered this change
    triggered_by: text('triggered_by').$type<AuditLogTrigger>().notNull(),
    triggered_by_id: uuid('triggered_by_id'), // User ID if applicable

    // Request context
    ip_address: text('ip_address'),
    user_agent: text('user_agent'),

    // Correlation for distributed tracing
    correlation_id: text('correlation_id'),

    // Additional context
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),

    // Immutable timestamp (never updated)
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Performance indexes
    transactionIdx: index('payment_audit_log_transaction_idx').on(
      table.transaction_id
    ),
    actionIdx: index('payment_audit_log_action_idx').on(table.action),
    correlationIdx: index('payment_audit_log_correlation_idx').on(
      table.correlation_id
    ),
    createdAtIdx: index('payment_audit_log_created_at_idx').on(table.created_at),
    triggeredByIdx: index('payment_audit_log_triggered_by_idx').on(
      table.triggered_by
    ),
  })
)
