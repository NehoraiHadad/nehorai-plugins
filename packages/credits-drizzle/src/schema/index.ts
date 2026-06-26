import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const creditBalances = pgTable('credit_balances', {
  userId: uuid('user_id').primaryKey(),
  balance: numeric('balance', { precision: 12, scale: 2 }).notNull().default('0'),
  bonusCredits: numeric('bonus_credits', { precision: 12, scale: 2 }).notNull().default('0'),
  reserved: numeric('reserved', { precision: 12, scale: 2 }).notNull().default('0'),
  tier: text('tier').notNull().default('free'),
  monthlyLimit: numeric('monthly_limit', { precision: 12, scale: 2 }).notNull().default('0'),
  monthlyUsed: numeric('monthly_used', { precision: 12, scale: 2 }).notNull().default('0'),
  monthlyResetAt: timestamp('monthly_reset_at', { withTimezone: true }).notNull(),
  subscriptionExpiresAt: timestamp('subscription_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const creditReservations = pgTable(
  'credit_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    operationType: text('operation_type').notNull(),
    status: text('status').notNull().default('reserved'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('credit_reservations_user_idx').on(table.userId),
    statusExpiresIdx: index('credit_reservations_status_expires_idx').on(table.status, table.expiresAt),
  })
)

export const creditPluginTransactions = pgTable(
  'credit_plugin_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    type: text('type').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    description: text('description').notNull(),
    paymentRef: text('payment_ref'),
    previousBalance: numeric('previous_balance', { precision: 12, scale: 2 }).notNull(),
    newBalance: numeric('new_balance', { precision: 12, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index('credit_plugin_transactions_user_created_idx').on(table.userId, table.createdAt),
    paymentRefUnique: uniqueIndex('credit_plugin_transactions_payment_ref_unique')
      .on(table.paymentRef)
      .where(sql`${table.paymentRef} is not null`),
  })
)

export const creditUsageLogs = pgTable(
  'credit_usage_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    operationType: text('operation_type').notNull(),
    provider: text('provider').notNull(),
    creditsUsed: numeric('credits_used', { precision: 12, scale: 2 }).notNull(),
    success: boolean('success').notNull(),
    errorMessage: text('error_message'),
    resourceId: text('resource_id'),
    resourceType: text('resource_type'),
    requestId: text('request_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index('credit_usage_logs_user_created_idx').on(table.userId, table.createdAt),
    operationIdx: index('credit_usage_logs_operation_idx').on(table.operationType),
    successIdx: index('credit_usage_logs_success_idx').on(table.success),
  })
)

export const creditJournalEntries = pgTable(
  'credit_journal_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    entryType: text('entry_type').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    balanceAfter: numeric('balance_after', { precision: 12, scale: 2 }).notNull(),
    source: text('source').notNull(),
    referenceId: text('reference_id').notNull(),
    referenceType: text('reference_type').notNull(),
    description: text('description').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index('credit_journal_entries_user_created_idx').on(table.userId, table.createdAt),
    sourceIdx: index('credit_journal_entries_source_idx').on(table.source),
    referenceIdx: index('credit_journal_entries_reference_idx').on(table.referenceId, table.referenceType),
  })
)

export type CreditBalanceRow = typeof creditBalances.$inferSelect
export type CreditReservationRow = typeof creditReservations.$inferSelect
export type CreditPluginTransactionRow = typeof creditPluginTransactions.$inferSelect
export type CreditUsageLogRow = typeof creditUsageLogs.$inferSelect
export type CreditJournalEntryRow = typeof creditJournalEntries.$inferSelect
