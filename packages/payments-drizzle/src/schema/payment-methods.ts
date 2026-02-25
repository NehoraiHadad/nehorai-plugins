/**
 * PaymentOS - Payment Methods Schema
 *
 * Stores tokenized payment methods (PCI-compliant - no full card numbers).
 * Used for saved cards and recurring billing.
 *
 * Note: User FK is optional and configured via schema-config.ts
 */

import { pgTable, uuid, text, boolean, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Payment method types
 */
export type PaymentMethodType = 'card' | 'bank_account' | 'paypal'

/**
 * Card brands
 */
export type CardBrandType =
  | 'visa'
  | 'mastercard'
  | 'amex'
  | 'discover'
  | 'isracard'
  | 'diners'
  | 'unknown'

// ============================================================================
// Schema Definition
// ============================================================================

/**
 * Payment methods table
 *
 * FK to user table is NOT defined here - it's application-specific.
 * The user_id column stores the UUID, but the FK constraint should be
 * added via migration if needed for your specific user table.
 *
 * To add FK constraint, create a migration:
 * ```sql
 * ALTER TABLE payment_methods
 * ADD CONSTRAINT payment_methods_user_id_fkey
 * FOREIGN KEY (user_id) REFERENCES your_users_table(id) ON DELETE CASCADE;
 * ```
 */
export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // User association (FK configured at application level)
    user_id: uuid('user_id').notNull(),

    // Method type
    type: text('type').$type<PaymentMethodType>().notNull(),

    // Provider information
    provider: text('provider').notNull(), // stripe, hyp, cardcom
    provider_payment_method_id: text('provider_payment_method_id').notNull(),

    // Card details (tokenized, never full numbers)
    card_brand: text('card_brand').$type<CardBrandType>(),
    card_last4: text('card_last4'),
    card_exp_month: text('card_exp_month'),
    card_exp_year: text('card_exp_year'),
    card_bin: text('card_bin'), // First 6-8 digits for routing

    // State
    is_default: boolean('is_default').default(false),
    is_active: boolean('is_active').default(true),

    // Provider-specific data
    provider_metadata: jsonb('provider_metadata').$type<Record<string, unknown>>(),

    // Timestamps
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => ({
    // Performance indexes
    userIdx: index('payment_methods_user_idx').on(table.user_id),
    userDefaultIdx: index('payment_methods_user_default_idx').on(table.user_id, table.is_default),
    providerIdx: index('payment_methods_provider_idx').on(table.provider),
    providerMethodIdx: index('payment_methods_provider_method_idx').on(
      table.provider_payment_method_id
    ),
    cardBinIdx: index('payment_methods_card_bin_idx').on(table.card_bin),
  })
)
