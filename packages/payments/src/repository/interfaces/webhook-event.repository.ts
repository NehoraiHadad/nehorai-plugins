/**
 * @nehorai/payments Repository - Webhook Event Interface
 *
 * Defines operations for webhook event persistence.
 * Used for idempotent webhook processing.
 */

import type {
  IBaseRepository,
  PaginationParams,
  PaginatedResult,
  DateRangeFilter,
} from './base.interface.js'
import type { ProviderName } from './transaction.repository.js'

// ============================================================================
// Webhook Event Types (Database-agnostic)
// ============================================================================

/**
 * Webhook event processing status
 */
export type WebhookEventStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'ignored'

/**
 * Webhook event entity
 */
export interface WebhookEvent {
  id: string
  provider: ProviderName
  providerEventId: string
  eventType: string
  status: WebhookEventStatus
  attempts: number
  lastAttemptAt: Date | null
  transactionId: string | null
  payload: Record<string, unknown>
  signature: string | null
  errorMessage: string | null
  errorDetails: Record<string, unknown> | null
  receivedAt: Date
  processedAt: Date | null
  createdAt: Date
}

/**
 * Create webhook event input
 */
export interface CreateWebhookEventInput {
  provider: ProviderName
  providerEventId: string
  eventType: string
  payload: Record<string, unknown>
  signature?: string
}

/**
 * Update webhook event input
 */
export interface UpdateWebhookEventInput {
  status?: WebhookEventStatus
  attempts?: number
  lastAttemptAt?: Date
  transactionId?: string
  processedAt?: Date
  errorMessage?: string
  errorDetails?: Record<string, unknown>
}

/**
 * Webhook event filter options
 */
export interface WebhookEventFilter {
  provider?: ProviderName | ProviderName[]
  eventType?: string | string[]
  status?: WebhookEventStatus | WebhookEventStatus[]
  transactionId?: string
  dateRange?: DateRangeFilter
}

// ============================================================================
// Webhook Event Repository Interface
// ============================================================================

/**
 * Webhook event repository interface
 */
export interface IWebhookEventRepository extends IBaseRepository<
  WebhookEvent,
  CreateWebhookEventInput,
  UpdateWebhookEventInput
> {
  findByProviderEventId(
    provider: ProviderName,
    providerEventId: string
  ): Promise<WebhookEvent | null>

  findByTransactionId(transactionId: string): Promise<WebhookEvent[]>

  findMany(
    filter: WebhookEventFilter,
    pagination?: PaginationParams
  ): Promise<PaginatedResult<WebhookEvent>>

  findFailedForRetry(maxAttempts: number, olderThan?: Date): Promise<WebhookEvent[]>

  findPending(limit?: number): Promise<WebhookEvent[]>

  markAsProcessing(id: string): Promise<boolean>

  markAsProcessed(id: string, transactionId?: string): Promise<WebhookEvent | null>

  markAsFailed(
    id: string,
    errorMessage: string,
    errorDetails?: Record<string, unknown>
  ): Promise<WebhookEvent | null>

  incrementAttempts(id: string): Promise<WebhookEvent | null>

  isAlreadyProcessed(provider: ProviderName, providerEventId: string): Promise<boolean>

  countByStatus(filter?: WebhookEventFilter): Promise<Record<WebhookEventStatus, number>>
}
