/**
 * @nehorai/payments - Transaction State Machine
 *
 * Defines the strict state transitions for payment transactions.
 * Implements the J5 (Two-Phase Commit) pattern for authorize/capture flows.
 *
 * State Flow:
 * +-------------------------------------------------------------+
 * |  CREATED --------------------------------------------------+ |
 * |     |                                                  |   |
 * |     v                                                  v   |
 * |  PENDING_AUTHORIZATION -----------------------------> FAILED |
 * |     |                                                  ^   |
 * |     v                                                  |   |
 * |  AUTHORIZED ---------> VOIDED                          |   |
 * |     |                                                  |   |
 * |     +----------------> EXPIRED ------------------------+   |
 * |     |                                                  |   |
 * |     v                                                  |   |
 * |  CAPTURING --------------------------------------------+   |
 * |     |                                                      |
 * |     v                                                      |
 * |  CAPTURED ------> PARTIALLY_REFUNDED ------> FULLY_REFUNDED |
 * +-------------------------------------------------------------+
 */

// ============================================================================
// Transaction States
// ============================================================================

/**
 * All possible transaction states
 */
export type TransactionStatus =
  | 'created'
  | 'pending_authorization'
  | 'authorized'
  | 'capturing'
  | 'captured'
  | 'voided'
  | 'failed'
  | 'expired'
  | 'partially_refunded'
  | 'fully_refunded';

/**
 * Terminal states - no further transitions possible
 */
export const TERMINAL_STATES: readonly TransactionStatus[] = [
  'voided',
  'failed',
  'expired',
  'fully_refunded',
] as const;

/**
 * States that indicate successful completion
 */
export const SUCCESS_STATES: readonly TransactionStatus[] = [
  'captured',
  'partially_refunded',
  'fully_refunded',
] as const;

/**
 * States where funds are held but not captured
 */
export const HOLD_STATES: readonly TransactionStatus[] = [
  'authorized',
] as const;

// ============================================================================
// Transaction Events
// ============================================================================

/**
 * Events that trigger state transitions
 */
export type TransactionEvent =
  | 'INITIATE'
  | 'AUTHORIZE_PENDING'
  | 'AUTHORIZE_SUCCESS'
  | 'AUTHORIZE_FAILED'
  | 'CAPTURE_STARTED'
  | 'CAPTURE_SUCCESS'
  | 'CAPTURE_FAILED'
  | 'VOID_SUCCESS'
  | 'VOID_FAILED'
  | 'EXPIRED'
  | 'PARTIAL_REFUND'
  | 'FULL_REFUND';

// ============================================================================
// State Transition Map
// ============================================================================

/**
 * Valid transitions from each state
 */
export const VALID_TRANSITIONS: Record<TransactionStatus, TransactionEvent[]> = {
  created: ['INITIATE', 'AUTHORIZE_PENDING', 'AUTHORIZE_FAILED'],
  pending_authorization: ['AUTHORIZE_SUCCESS', 'AUTHORIZE_FAILED', 'EXPIRED'],
  authorized: ['CAPTURE_STARTED', 'VOID_SUCCESS', 'VOID_FAILED', 'EXPIRED'],
  capturing: ['CAPTURE_SUCCESS', 'CAPTURE_FAILED'],
  captured: ['PARTIAL_REFUND', 'FULL_REFUND'],
  voided: [], // Terminal state
  failed: [], // Terminal state
  expired: [], // Terminal state
  partially_refunded: ['PARTIAL_REFUND', 'FULL_REFUND'],
  fully_refunded: [], // Terminal state
};

/**
 * Event to next state mapping
 */
const EVENT_TO_STATE: Record<TransactionEvent, TransactionStatus> = {
  INITIATE: 'pending_authorization',
  AUTHORIZE_PENDING: 'pending_authorization',
  AUTHORIZE_SUCCESS: 'authorized',
  AUTHORIZE_FAILED: 'failed',
  CAPTURE_STARTED: 'capturing',
  CAPTURE_SUCCESS: 'captured',
  CAPTURE_FAILED: 'failed',
  VOID_SUCCESS: 'voided',
  VOID_FAILED: 'authorized', // Remain authorized if void fails
  EXPIRED: 'expired',
  PARTIAL_REFUND: 'partially_refunded',
  FULL_REFUND: 'fully_refunded',
};

// ============================================================================
// State Machine Functions
// ============================================================================

/**
 * Check if a transition is valid
 */
export function canTransition(
  currentStatus: TransactionStatus,
  event: TransactionEvent
): boolean {
  return VALID_TRANSITIONS[currentStatus].includes(event);
}

/**
 * Get the next state after an event, or null if transition is invalid
 */
export function getNextStatus(
  currentStatus: TransactionStatus,
  event: TransactionEvent
): TransactionStatus | null {
  if (!canTransition(currentStatus, event)) {
    return null;
  }
  return EVENT_TO_STATE[event];
}

/**
 * Check if a state is terminal (no further transitions)
 */
export function isTerminalState(status: TransactionStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

/**
 * Check if a state represents a successful payment
 */
export function isSuccessState(status: TransactionStatus): boolean {
  return SUCCESS_STATES.includes(status);
}

/**
 * Check if funds are currently held (authorized but not captured)
 */
export function isHoldState(status: TransactionStatus): boolean {
  return HOLD_STATES.includes(status);
}

/**
 * Check if a refund is possible from current state
 */
export function canRefund(status: TransactionStatus): boolean {
  return status === 'captured' || status === 'partially_refunded';
}

/**
 * Check if capture is possible from current state
 */
export function canCapture(status: TransactionStatus): boolean {
  return status === 'authorized';
}

/**
 * Check if void is possible from current state
 */
export function canVoid(status: TransactionStatus): boolean {
  return status === 'authorized';
}

// ============================================================================
// State Transition Result Types
// ============================================================================

/**
 * Result of a state transition attempt
 */
export interface StateTransitionResult {
  success: boolean;
  previousStatus: TransactionStatus;
  newStatus: TransactionStatus;
  event: TransactionEvent;
  error?: string;
}

/**
 * Attempt a state transition with validation
 */
export function attemptTransition(
  currentStatus: TransactionStatus,
  event: TransactionEvent
): StateTransitionResult {
  const nextStatus = getNextStatus(currentStatus, event);

  if (nextStatus === null) {
    return {
      success: false,
      previousStatus: currentStatus,
      newStatus: currentStatus,
      event,
      error: `Invalid transition: ${currentStatus} -> ${event}`,
    };
  }

  return {
    success: true,
    previousStatus: currentStatus,
    newStatus: nextStatus,
    event,
  };
}

// ============================================================================
// Authorization Expiry
// ============================================================================

/**
 * Default authorization hold period (7 days for most providers)
 */
export const DEFAULT_AUTH_HOLD_DAYS = 7;

/**
 * Calculate capture deadline from authorization time
 */
export function calculateCaptureDeadline(
  authorizedAt: Date,
  holdDays: number = DEFAULT_AUTH_HOLD_DAYS
): Date {
  const deadline = new Date(authorizedAt);
  deadline.setDate(deadline.getDate() + holdDays);
  return deadline;
}

/**
 * Check if authorization has expired
 */
export function isAuthorizationExpired(captureDeadline: Date): boolean {
  return new Date() > captureDeadline;
}
