import { CREDIT_CONSTANTS } from "../core/types";

/**
 * Notification event types
 */
export type CreditNotificationEvent =
  | {
      type: "low_balance";
      userId: string;
      balance: number;
      threshold: number;
    }
  | {
      type: "balance_depleted";
      userId: string;
    }
  | {
      type: "subscription_expiring";
      userId: string;
      expiresAt: Date;
      daysRemaining: number;
    }
  | {
      type: "subscription_expired";
      userId: string;
      wasDowngraded: boolean;
    };

/**
 * Notification handler interface
 * Implementations can send emails, push notifications, etc.
 */
export interface ICreditNotificationHandler {
  /**
   * Handle a notification event
   * @param event - The notification event
   */
  handleNotification(event: CreditNotificationEvent): Promise<void>;
}

/**
 * Notification cooldown tracker
 * Prevents spam by tracking last notification time per user per event type
 */
interface NotificationCooldownState {
  lastLowBalanceNotification?: Date;
  lastDepletedNotification?: Date;
  lastExpiringNotification?: Date;
}

/**
 * In-memory cooldown tracker
 * In production, this should be stored in a persistent store
 */
const cooldownState = new Map<string, NotificationCooldownState>();

/**
 * Default notification threshold for low balance
 */
const LOW_BALANCE_THRESHOLD = CREDIT_CONSTANTS.LOW_BALANCE_THRESHOLD;

/**
 * Cooldown period in milliseconds (24 hours)
 */
const NOTIFICATION_COOLDOWN_MS =
  CREDIT_CONSTANTS.LOW_BALANCE_NOTIFICATION_COOLDOWN_HOURS * 60 * 60 * 1000;

/**
 * Check if a notification is allowed (not in cooldown)
 */
function isNotificationAllowed(
  userId: string,
  eventType: "lowBalance" | "depleted" | "expiring"
): boolean {
  const state = cooldownState.get(userId);
  if (!state) return true;

  const now = Date.now();
  let lastNotification: Date | undefined;

  switch (eventType) {
    case "lowBalance":
      lastNotification = state.lastLowBalanceNotification;
      break;
    case "depleted":
      lastNotification = state.lastDepletedNotification;
      break;
    case "expiring":
      lastNotification = state.lastExpiringNotification;
      break;
  }

  if (!lastNotification) return true;
  return now - lastNotification.getTime() > NOTIFICATION_COOLDOWN_MS;
}

/**
 * Record that a notification was sent
 */
function recordNotification(
  userId: string,
  eventType: "lowBalance" | "depleted" | "expiring"
): void {
  const state = cooldownState.get(userId) || {};
  const now = new Date();

  switch (eventType) {
    case "lowBalance":
      state.lastLowBalanceNotification = now;
      break;
    case "depleted":
      state.lastDepletedNotification = now;
      break;
    case "expiring":
      state.lastExpiringNotification = now;
      break;
  }

  cooldownState.set(userId, state);
}

/**
 * Default notification handlers registry
 * Handlers can be registered at application startup
 */
const notificationHandlers: ICreditNotificationHandler[] = [];

/**
 * Register a notification handler
 */
export function registerNotificationHandler(
  handler: ICreditNotificationHandler
): void {
  notificationHandlers.push(handler);
}

/**
 * Clear all notification handlers (for testing)
 */
export function clearNotificationHandlers(): void {
  notificationHandlers.length = 0;
}

/**
 * Clear cooldown state (for testing)
 */
export function clearCooldownState(): void {
  cooldownState.clear();
}

/**
 * Dispatch a notification event to all handlers
 * Runs asynchronously without blocking
 */
async function dispatchNotification(
  event: CreditNotificationEvent
): Promise<void> {
  if (notificationHandlers.length === 0) {
    // No handlers registered - log for debugging
    console.debug(`[Credits] No notification handlers registered for: ${event.type}`);
    return;
  }

  // Run handlers in parallel
  await Promise.allSettled(
    notificationHandlers.map((handler) =>
      handler.handleNotification(event).catch((error) => {
        console.error(`[Credits] Notification handler error:`, error);
      })
    )
  );
}

/**
 * Check and trigger low balance notification if needed
 * Call this after commit operations
 *
 * @param userId - User ID
 * @param newBalance - Balance after the operation
 * @param threshold - Custom threshold (defaults to 10)
 */
export async function checkAndNotifyLowBalance(
  userId: string,
  newBalance: number,
  threshold = LOW_BALANCE_THRESHOLD
): Promise<void> {
  // Check if balance is depleted
  if (newBalance <= 0 && isNotificationAllowed(userId, "depleted")) {
    recordNotification(userId, "depleted");
    await dispatchNotification({
      type: "balance_depleted",
      userId,
    });
    return; // Don't also send low balance notification
  }

  // Check if balance is below threshold
  if (newBalance > 0 && newBalance <= threshold && isNotificationAllowed(userId, "lowBalance")) {
    recordNotification(userId, "lowBalance");
    await dispatchNotification({
      type: "low_balance",
      userId,
      balance: newBalance,
      threshold,
    });
  }
}

/**
 * Trigger subscription expiring notification
 *
 * @param userId - User ID
 * @param expiresAt - When subscription expires
 * @param daysRemaining - Days until expiry
 */
export async function notifySubscriptionExpiring(
  userId: string,
  expiresAt: Date,
  daysRemaining: number
): Promise<void> {
  if (!isNotificationAllowed(userId, "expiring")) {
    return;
  }

  recordNotification(userId, "expiring");
  await dispatchNotification({
    type: "subscription_expiring",
    userId,
    expiresAt,
    daysRemaining,
  });
}

/**
 * Trigger subscription expired notification
 *
 * @param userId - User ID
 * @param wasDowngraded - Whether the user was downgraded to free tier
 */
export async function notifySubscriptionExpired(
  userId: string,
  wasDowngraded: boolean
): Promise<void> {
  await dispatchNotification({
    type: "subscription_expired",
    userId,
    wasDowngraded,
  });
}

/**
 * Console notification handler for development/testing
 * Logs notifications to console
 */
export class ConsoleNotificationHandler implements ICreditNotificationHandler {
  async handleNotification(event: CreditNotificationEvent): Promise<void> {
    switch (event.type) {
      case "low_balance":
        console.log(
          `[Credits Notification] Low balance alert for user ${event.userId}: ` +
          `${event.balance} credits remaining (threshold: ${event.threshold})`
        );
        break;
      case "balance_depleted":
        console.log(
          `[Credits Notification] Balance depleted for user ${event.userId}`
        );
        break;
      case "subscription_expiring":
        console.log(
          `[Credits Notification] Subscription expiring for user ${event.userId}: ` +
          `${event.daysRemaining} days remaining`
        );
        break;
      case "subscription_expired":
        console.log(
          `[Credits Notification] Subscription expired for user ${event.userId}: ` +
          `downgraded=${event.wasDowngraded}`
        );
        break;
    }
  }
}
