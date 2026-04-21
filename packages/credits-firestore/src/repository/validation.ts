import type { PortableUserCredits, CreditBalanceUpdate } from "@nehorai/credits";

/**
 * Result of balance validation
 */
export interface BalanceValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate that a balance update won't result in invalid state
 *
 * Checks:
 * - Balance cannot become negative
 * - BonusCredits cannot become negative
 * - Reserved cannot become negative
 * - Reserved cannot exceed balance + bonusCredits
 *
 * @param current - Current user credits state
 * @param updates - Proposed updates (absolute values or increments)
 * @returns Validation result with any errors
 */
export function validateBalanceUpdate(
  current: PortableUserCredits,
  updates: CreditBalanceUpdate
): BalanceValidationResult {
  const errors: string[] = [];

  // Calculate new balance
  let newBalance = current.balance;
  if (updates.balance !== undefined) {
    newBalance = updates.balance;
  } else if (updates.balanceIncrement !== undefined) {
    newBalance += updates.balanceIncrement;
  }

  // Calculate new bonusCredits
  let newBonusCredits = current.bonusCredits;
  if (updates.bonusCredits !== undefined) {
    newBonusCredits = updates.bonusCredits;
  } else if (updates.bonusCreditsIncrement !== undefined) {
    newBonusCredits += updates.bonusCreditsIncrement;
  }

  // Calculate new reserved
  let newReserved = current.reserved;
  if (updates.reserved !== undefined) {
    newReserved = updates.reserved;
  } else if (updates.reservedIncrement !== undefined) {
    newReserved += updates.reservedIncrement;
  }

  // Validate bounds
  if (newBalance < 0) {
    errors.push(`Balance cannot be negative: ${newBalance}`);
  }

  if (newBonusCredits < 0) {
    errors.push(`BonusCredits cannot be negative: ${newBonusCredits}`);
  }

  if (newReserved < 0) {
    errors.push(`Reserved cannot be negative: ${newReserved}`);
  }

  // Reserved must be backed by real credits — either monthly balance or bonus.
  const newAvailable = newBalance + newBonusCredits;
  if (newReserved > newAvailable) {
    errors.push(
      `Reserved (${newReserved}) exceeds balance + bonusCredits (${newAvailable})`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate balance update and throw if invalid
 *
 * @param current - Current user credits state
 * @param updates - Proposed updates
 * @throws Error if validation fails
 */
export function assertValidBalanceUpdate(
  current: PortableUserCredits,
  updates: CreditBalanceUpdate
): void {
  const result = validateBalanceUpdate(current, updates);
  if (!result.valid) {
    throw new Error(`Invalid balance update: ${result.errors.join("; ")}`);
  }
}
