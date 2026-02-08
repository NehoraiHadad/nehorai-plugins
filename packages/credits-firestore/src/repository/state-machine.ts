import type { ReservationStatus } from "@nehorai/credits";

/**
 * Valid state transitions for reservations
 *
 * reserved -> committed (operation succeeded)
 * reserved -> released (operation cancelled)
 * reserved -> expired (cleanup job)
 *
 * Terminal states (committed, released, expired) have no valid outgoing transitions
 */
const VALID_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  reserved: ["committed", "released", "expired"],
  committed: [],
  released: [],
  expired: [],
};

/**
 * Check if a state transition is valid
 *
 * @param from - Current status
 * @param to - Target status
 * @returns true if transition is valid
 */
export function isValidTransition(
  from: ReservationStatus,
  to: ReservationStatus
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Validate a state transition and throw if invalid
 *
 * @param from - Current status
 * @param to - Target status
 * @param reservationId - Reservation ID for error context
 * @throws Error if transition is invalid
 */
export function validateTransition(
  from: ReservationStatus,
  to: ReservationStatus,
  reservationId: string
): void {
  if (!isValidTransition(from, to)) {
    throw new Error(
      `Invalid reservation transition: ${from} -> ${to} (id: ${reservationId})`
    );
  }
}

/**
 * Get valid next states for a given status
 *
 * @param status - Current status
 * @returns Array of valid next statuses
 */
export function getValidNextStates(status: ReservationStatus): ReservationStatus[] {
  return VALID_TRANSITIONS[status] ?? [];
}

/**
 * Check if a status is terminal (no valid outgoing transitions)
 *
 * @param status - Status to check
 * @returns true if status is terminal
 */
export function isTerminalState(status: ReservationStatus): boolean {
  return getValidNextStates(status).length === 0;
}
