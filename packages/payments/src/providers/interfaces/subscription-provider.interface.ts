/**
 * @nehorai/payments - Subscription Provider Interface
 *
 * Optional capability interface for providers that support recurring
 * billing / standing orders (e.g. SUMIT). This is intentionally separate
 * from {@link IPaymentProvider} so that one-time-only providers are not
 * forced to implement it.
 *
 * Capability detection at runtime:
 * ```typescript
 * if ('createSubscription' in provider) {
 *   // provider implements ISubscriptionProvider
 * }
 * ```
 *
 * The provider is responsible for *billing* the customer on each cycle.
 * The application's billing/domain layer remains responsible for credits,
 * plans, permissions and usage — never the provider adapter.
 */

import type {
  PaymentProvider,
  CreateSubscriptionParams,
  SubscriptionResult,
  CancelSubscriptionParams,
  CancelSubscriptionResult,
} from '../../types/index.js';

/**
 * Subscription Provider Interface
 *
 * Providers that bill recurring charges implement this in addition to
 * {@link IPaymentProvider}.
 */
export interface ISubscriptionProvider {
  /** Provider identifier (must match the IPaymentProvider name) */
  readonly name: PaymentProvider;

  /**
   * Create a recurring subscription / standing order.
   * For hosted-page providers this returns a `redirectUrl`; the
   * subscription becomes `active` once the first charge succeeds
   * (confirmed via webhook + provider query).
   */
  createSubscription(
    params: CreateSubscriptionParams
  ): Promise<SubscriptionResult>;

  /**
   * Cancel an existing subscription / standing order.
   */
  cancelSubscription(
    params: CancelSubscriptionParams
  ): Promise<CancelSubscriptionResult>;
}
