/**
 * Credit utility functions
 *
 * Common helper functions for credit calculations
 */

import type { PortableReservation } from "../core";

export {
  parseCreditError,
  isCreditErrorMessage,
  type CreditErrorInfo,
} from "./error-utils";

/**
 * Calculate total available credits from balance and bonus credits
 *
 * @param credits - Object containing balance and bonusCredits properties
 * @returns Total credits (balance + bonusCredits)
 *
 * @example
 * ```ts
 * const total = getTotalCredits({ balance: 100, bonusCredits: 50 });
 * // Returns 150
 * ```
 */
export function getTotalCredits(credits: {
  balance: number;
  bonusCredits: number;
}): number {
  return credits.balance + credits.bonusCredits;
}

/**
 * Generate a unique request ID
 *
 * Format: req_{timestamp}_{randomPart}
 * Example: req_1706234567890_a1b2c3d4e5f6
 *
 * @returns URL-safe request ID string
 */
export function generateRequestId(): string {
  const timestamp = Date.now();
  const randomPart = Math.random().toString(36).substring(2, 14);
  return `req_${timestamp}_${randomPart}`;
}

/**
 * Check if the input data indicates preview mode
 *
 * Preview mode skips actual credit deduction - used for dry runs
 * and UI previews where the user wants to see results without committing.
 *
 * @param data - The input data to check
 * @returns true if data has preview: true
 */
export function isPreviewMode(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    "preview" in data &&
    (data as Record<string, unknown>).preview === true
  );
}

/**
 * Create a dummy reservation for preview mode
 *
 * Used when `isPreviewMode(data)` returns true to provide
 * a valid reservation object without actual credit operations.
 *
 * @param userId - The user ID
 * @param operationType - The operation type
 * @returns A dummy PortableReservation with id "preview-mode"
 */
export function createDummyReservation(
  userId: string,
  operationType: string
): PortableReservation {
  const now = new Date().toISOString();
  return {
    id: "preview-mode",
    userId,
    amount: 0,
    operationType,
    status: "released",
    createdAt: now,
    expiresAt: now,
  };
}
