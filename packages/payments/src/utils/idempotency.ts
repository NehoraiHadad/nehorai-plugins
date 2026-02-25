/**
 * @nehorai/payments - Idempotency Utilities
 *
 * Generates and validates idempotency keys to prevent duplicate charges.
 * Framework-agnostic utility that can be used anywhere.
 */

import { randomUUID, createHash } from 'crypto'

/**
 * Generate a unique internal payment ID
 * Format: pay_{uuid}
 */
export function generateInternalPaymentId(): string {
  return `pay_${randomUUID()}`
}

/**
 * Generate an idempotency key for API calls
 * Format: idem_{uuid}
 */
export function generateIdempotencyKey(): string {
  return `idem_${randomUUID()}`
}

/**
 * Generate a deterministic idempotency key based on inputs
 * Useful when you need the same key for retries
 *
 * @param components - Array of values to hash together
 */
export function generateDeterministicKey(
  ...components: (string | number)[]
): string {
  const data = components.join(':')
  const hash = createHash('sha256').update(data).digest('hex')
  return `idem_${hash.substring(0, 32)}`
}

/**
 * Generate idempotency key for a specific operation
 *
 * @param operation - Type of operation (e.g., 'capture', 'refund')
 * @param transactionId - Associated transaction ID
 */
export function generateOperationKey(
  operation: string,
  transactionId: string
): string {
  return `${operation}_${transactionId}`
}

/**
 * Validate idempotency key format
 */
export function isValidIdempotencyKey(key: string): boolean {
  return /^idem_[a-f0-9-]{32,36}$/.test(key)
}

/**
 * Validate internal payment ID format
 */
export function isValidInternalPaymentId(id: string): boolean {
  return /^pay_[a-f0-9-]{36}$/.test(id)
}

/**
 * Extract UUID from payment ID or idempotency key
 */
export function extractUuid(key: string): string | null {
  const match = key.match(/^(?:pay|idem)_([a-f0-9-]+)$/)
  return match ? match[1] : null
}
