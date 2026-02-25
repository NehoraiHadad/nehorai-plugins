/**
 * @nehorai/payments-drizzle - Base Drizzle Repository
 *
 * Common utilities and types for Drizzle repository implementations.
 */

// ============================================================================
// Database Instance Type
// ============================================================================

/**
 * Drizzle database instance type
 * Uses a minimal interface to support any Drizzle database instance.
 * Generic enough to work with any Drizzle PostgreSQL database.
 */
export type DrizzleDB = {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  select: (...args: any[]) => any
  insert: (table: any) => any
  update: (table: any) => any
  delete: (table: any) => any
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert database row to camelCase entity
 */
export function toCamelCase<T extends Record<string, unknown>>(row: Record<string, unknown>): T {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
    result[camelKey] = value
  }
  return result as T
}

/**
 * Convert camelCase entity to snake_case for database
 */
export function toSnakeCase<T extends Record<string, unknown>>(obj: Record<string, unknown>): T {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue
    const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    result[snakeKey] = value
  }
  return result as T
}

/**
 * Apply pagination to query results
 */
export function applyPagination<T>(
  items: T[],
  total: number,
  limit: number,
  offset: number
): {
  data: T[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
} {
  return {
    data: items,
    total,
    limit,
    offset,
    hasMore: offset + items.length < total,
  }
}

/**
 * Parse numeric string to number (Drizzle returns numeric as string)
 */
export function parseNumeric(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value
  return parseFloat(value) || 0
}

/**
 * Convert array filter to SQL-friendly format
 */
export function normalizeArrayFilter<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value : [value]
}
