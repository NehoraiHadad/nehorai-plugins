import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core'

/**
 * Webhook processing status
 */
export type WebhookEventStatus =
  | 'pending'
  | 'processing'
  | 'processed'
  | 'failed'
  | 'ignored'

/**
 * Payment webhook events table
 * Stores all incoming webhooks for idempotent processing.
 * Ensures each provider event is processed exactly once.
 */
export const paymentWebhookEvents = pgTable(
  'payment_webhook_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Event identification
    provider: text('provider').notNull(), // stripe, hyp, cardcom
    provider_event_id: text('provider_event_id').notNull(),
    event_type: text('event_type').notNull(),

    // Processing state
    status: text('status')
      .$type<WebhookEventStatus>()
      .notNull()
      .default('pending'),
    attempts: text('attempts').default('0'),
    last_attempt_at: timestamp('last_attempt_at', { withTimezone: true }),

    // Linked transaction (if applicable)
    transaction_id: uuid('transaction_id'),

    // Event payload (store for debugging and retry)
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    signature: text('signature'),

    // Error tracking
    error_message: text('error_message'),
    error_details: jsonb('error_details'),

    // Timestamps
    received_at: timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    processed_at: timestamp('processed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Unique constraint for idempotency
    providerEventUnique: unique('webhook_events_provider_event_unique').on(
      table.provider,
      table.provider_event_id
    ),
    // Performance indexes
    statusIdx: index('webhook_events_status_idx').on(table.status),
    transactionIdx: index('webhook_events_transaction_idx').on(
      table.transaction_id
    ),
    receivedAtIdx: index('webhook_events_received_at_idx').on(table.received_at),
    providerIdx: index('webhook_events_provider_idx').on(table.provider),
    eventTypeIdx: index('webhook_events_event_type_idx').on(table.event_type),
  })
)
