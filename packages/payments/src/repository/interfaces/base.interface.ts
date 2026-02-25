/**
 * @nehorai/payments Repository - Base Interfaces
 *
 * Common types and base interface for all repositories.
 * Framework-agnostic - works with any database adapter.
 */

// ============================================================================
// Common Query Types
// ============================================================================

/**
 * Pagination parameters
 */
export interface PaginationParams {
  limit?: number
  offset?: number
}

/**
 * Paginated response wrapper
 */
export interface PaginatedResult<T> {
  data: T[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

/**
 * Date range filter
 */
export interface DateRangeFilter {
  from?: Date
  to?: Date
}

/**
 * Sort direction
 */
export type SortDirection = 'asc' | 'desc'

/**
 * Sort parameter
 */
export interface SortParam<T extends string = string> {
  field: T
  direction: SortDirection
}

// ============================================================================
// Base Repository Interface
// ============================================================================

/**
 * Base repository interface with common CRUD operations
 */
export interface IBaseRepository<T, TCreate, TUpdate, TId = string> {
  /**
   * Find entity by ID
   */
  findById(id: TId): Promise<T | null>

  /**
   * Create new entity
   */
  create(data: TCreate): Promise<T>

  /**
   * Update existing entity
   */
  update(id: TId, data: TUpdate): Promise<T | null>

  /**
   * Delete entity by ID
   */
  delete(id: TId): Promise<boolean>
}
