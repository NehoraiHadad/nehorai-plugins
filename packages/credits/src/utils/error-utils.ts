/**
 * Credit error utilities
 *
 * Provides functions to parse and identify credit-related errors
 * for consistent error handling across the application.
 */

/**
 * Parsed information from a credit error message
 */
export interface CreditErrorInfo {
  /** Credits currently available */
  available: number;
  /** Credits required for the operation */
  required: number;
  /** Difference between required and available */
  shortfall: number;
  /** Original error message */
  rawMessage: string;
}

/**
 * Parse a credit error message to extract available/required credits
 *
 * @param error - Error message string
 * @returns Parsed credit info or null if not a valid credit error format
 *
 * @example
 * ```ts
 * const error = "Insufficient credits. Available: 3, Required: 10";
 * const info = parseCreditError(error);
 * // { available: 3, required: 10, shortfall: 7, rawMessage: "..." }
 * ```
 */
export function parseCreditError(error: string): CreditErrorInfo | null {
  // Pattern: Available: X, Required: Y (case insensitive, flexible whitespace)
  const match = error.match(/Available:\s*(\d+)\s*,\s*Required:\s*(\d+)/i);

  if (!match) {
    return null;
  }

  const available = parseInt(match[1], 10);
  const required = parseInt(match[2], 10);

  // Validate parsed numbers
  if (isNaN(available) || isNaN(required)) {
    return null;
  }

  return {
    available,
    required,
    shortfall: required - available,
    rawMessage: error,
  };
}

/**
 * Check if an error message is a credit-related error
 *
 * @param error - Error message string
 * @returns true if the error is credit-related
 *
 * @example
 * ```ts
 * if (isCreditError(error)) {
 *   showCreditErrorDialog(parseCreditError(error));
 * }
 * ```
 */
export function isCreditErrorMessage(error: string): boolean {
  const lowerError = error.toLowerCase();
  return (
    lowerError.includes("insufficient credits") ||
    lowerError.includes("not enough credits")
  );
}
