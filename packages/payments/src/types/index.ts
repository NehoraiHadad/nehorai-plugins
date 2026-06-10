/**
 * @nehorai/payments - Type Exports
 *
 * Central export for all payment system types.
 */

// Core payment types
export type {
  PaymentProvider,
  TransactionType,
  TaxInvoiceStatus,
  PaymentMethodType,
  CardBrand,
  PaymentAmount,
  CurrencyConversion,
  CreatePaymentIntentParams,
  PaymentIntentResult,
  AuthorizePaymentParams,
  AuthorizationResult,
  CapturePaymentParams,
  CaptureResult,
  VoidPaymentParams,
  VoidResult,
  RefundParams,
  RefundResult,
  PaymentMetadata,
  ProviderMetadata,
  ProviderHealthStatus,
  PaymentErrorCode,
  PaymentError,
  SubscriptionStatus,
  SubscriptionInterval,
  CreateSubscriptionParams,
  SubscriptionResult,
  CancelSubscriptionParams,
  CancelSubscriptionResult,
} from './payment-types.js';

// State machine types
export type {
  TransactionStatus,
  TransactionEvent,
  StateTransitionResult,
} from './state-machine.js';

export {
  TERMINAL_STATES,
  SUCCESS_STATES,
  HOLD_STATES,
  VALID_TRANSITIONS,
  DEFAULT_AUTH_HOLD_DAYS,
  canTransition,
  getNextStatus,
  isTerminalState,
  isSuccessState,
  isHoldState,
  canRefund,
  canCapture,
  canVoid,
  attemptTransition,
  calculateCaptureDeadline,
  isAuthorizationExpired,
} from './state-machine.js';

// Webhook types
export type {
  WebhookStatus,
  WebhookEvent,
  WebhookProcessingResult,
  WebhookAction,
  StripeEventType,
  WebhookVerificationParams,
  WebhookVerificationResult,
  WebhookQueueMessage,
  QueueProcessingResult,
  ReconciliationResult,
  ReconciliationStrategy,
} from './webhook-types.js';

export { STRIPE_EVENT_TO_STATUS } from './webhook-types.js';
