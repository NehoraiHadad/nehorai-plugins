/**
 * Shared utilities for credit repository implementations
 *
 * These are pure functions with no server-only dependencies,
 * making them safe to use in any repository implementation.
 */

/**
 * Generate a unique ID
 * Uses timestamp + random string for uniqueness
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Convert date-like value to Date object
 * Handles: Date, string, Firestore Timestamp
 */
export function toDate(value: Date | string | unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  // Handle Firestore Timestamp
  if (typeof value === "object" && value !== null && "toDate" in value) {
    return (value as { toDate: () => Date }).toDate();
  }
  return new Date();
}

/**
 * Get the first day of next month
 * Used for calculating monthly reset dates
 */
export function getNextMonthlyReset(from: Date = new Date()): Date {
  const next = new Date(from);
  next.setMonth(next.getMonth() + 1);
  next.setDate(1);
  next.setHours(0, 0, 0, 0);
  return next;
}
