/**
 * PaymentOS - Payment Transactions Schema
 *
 * Core table for tracking all payment operations.
 * Implements Two-Phase Commit (J5) pattern with authorize/capture flow.
 *
 * Note: User FK is optional and configured via schema-config.ts
 */

import { pgTable, uuid, text, numeric, timestamp, jsonb, index, unique } from 'drizzle-orm/pg-core'

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Payment transaction states (strict state machine)
 * @see src/lib/payments/types/state-machine.ts for transition rules
 */
export type PaymentTransactionStatus =
  | 'created'
  | 'pending_authorization'
  | 'authorized'
  | 'capturing'
  | 'captured'
  | 'voided'
  | 'failed'
  | 'expired'
  | 'partially_refunded'
  | 'fully_refunded'

/**
 * Payment transaction types
 */
export type PaymentTransactionType =
  | 'one_time_purchase'
  | 'subscription_initial'
  | 'subscription_renewal'
  | 'refund'

/**
 * Tax invoice status (Israeli compliance)
 */
export type PaymentTaxInvoiceStatus = 'pending' | 'generated' | 'sent' | 'failed'

// ============================================================================
// Schema Definition
// ============================================================================

/**
 * Payment transactions table
 *
 * FK to user table is NOT defined here - it's application-specific.
 * The user_id column stores the UUID, but the FK constraint should be
 * added via migration if needed for your specific user table.
 *
 * To add FK constraint, create a migration:
 * ```sql
 * ALTER TABLE payment_transactions
 * ADD CONSTRAINT payment_transactions_user_id_fkey
 * FOREIGN KEY (user_id) REFERENCES your_users_table(id) ON DELETE CASCADE;
 * ```
 */
export const paymentTransactions = pgTable(
  'payment_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Idempotency - prevents duplicate charges
    internal_payment_id: text('internal_payment_id').notNull(),
    idempotency_key: text('idempotency_key'),

    // User association (FK configured at application level)
    user_id: uuid('user_id').notNull(),

    // Transaction classification
    transaction_type: text('transaction_type').$type<PaymentTransactionType>().notNull(),
    status: text('status').$type<PaymentTransactionStatus>().notNull().default('created'),

    // Amounts in smallest currency unit (cents/agorot)
    amount_minor: numeric('amount_minor').notNull(),
    currency: text('currency').notNull().default('USD'),

    // Original amount if currency converted
    original_amount_minor: numeric('original_amount_minor'),
    original_currency: text('original_currency'),
    currency_conversion_rate: numeric('currency_conversion_rate'),

    // Provider information
    provider: text('provider').notNull(), // stripe, hyp, cardcom
    provider_transaction_id: text('provider_transaction_id'),
    provider_authorization_code: text('provider_authorization_code'),
    provider_metadata: jsonb('provider_metadata').$type<Record<string, unknown>>(),

    // Two-phase commit tracking (J5)
    authorized_at: timestamp('authorized_at', { withTimezone: true }),
    captured_at: timestamp('captured_at', { withTimezone: true }),
    voided_at: timestamp('voided_at', { withTimezone: true }),
    capture_deadline: timestamp('capture_deadline', { withTimezone: true }),

    // Refund tracking
    refunded_amount_minor: numeric('refunded_amount_minor').default('0'),
    last_refund_at: timestamp('last_refund_at', { withTimezone: true }),

    // Tax invoice (Israeli requirement)
    tax_invoice_status: text('tax_invoice_status')
      .$type<PaymentTaxInvoiceStatus>()
      .default('pending'),
    tax_invoice_number: text('tax_invoice_number'),
    tax_invoice_url: text('tax_invoice_url'),

    // Error tracking
    failure_code: text('failure_code'),
    failure_message: text('failure_message'),
    failure_details: jsonb('failure_details'),

    // Application metadata
    description: text('description'),
    metadata: jsonb('metadata').$type<{
      credit_package_id?: string
      subscription_plan_id?: string
      credits_amount?: number
      [key: string]: unknown
    }>(),

    // Timestamps
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Performance indexes
    userIdx: index('payment_transactions_user_idx').on(table.user_id),
    statusIdx: index('payment_transactions_status_idx').on(table.status),
    providerIdx: index('payment_transactions_provider_idx').on(table.provider),
    providerTxIdx: index('payment_transactions_provider_tx_idx').on(table.provider_transaction_id),
    createdAtIdx: index('payment_transactions_created_at_idx').on(table.created_at),
    // Unique constraints for idempotency
    internalIdUnique: unique('payment_transactions_internal_id_unique').on(
      table.internal_payment_id
    ),
    idempotencyUnique: unique('payment_transactions_idempotency_unique').on(table.idempotency_key),
  })
)
