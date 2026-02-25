/**
 * @nehorai/payments - Main Entry Point
 *
 * A modular, framework-agnostic payment infrastructure library.
 *
 * Features:
 * - Multi-provider support (any payment provider via adapter pattern)
 * - Two-Phase Commit (J5) with authorize/capture
 * - Smart routing with configurable BIN rules and provider priorities
 * - Circuit breaker for resilience
 * - Webhook signature verification
 * - Idempotency for duplicate prevention
 * - Full dependency injection support
 *
 * Quick Start:
 * ```typescript
 * import { createPaymentServices } from '@nehorai/payments';
 *
 * const providers = new Map();
 * providers.set('stripe', myStripeProvider);
 *
 * const { orchestrator } = createPaymentServices({ providers });
 *
 * const result = await orchestrator.initiatePayment({
 *   userId: 'user_123',
 *   amount: { amountMinor: 1000, currency: 'USD' },
 *   transactionType: 'one_time_purchase',
 *   returnUrl: 'https://example.com/payment/success',
 * });
 * ```
 */

// ============================================================================
// FACTORY - Main entry point
// ============================================================================

export {
  createPaymentServices,
  registerProvider,
  getPaymentServices,
  resetPaymentServices,
  type PaymentServicesConfig,
  type PaymentServices,
} from './factory.js'

// ============================================================================
// CONFIGURATION
// ============================================================================

export {
  createConfig,
  createConfigFromEnv,
  createPartialConfig,
  getConfiguredProviders,
  getConfiguredProviderList,
  isProductionReady,
  validateConfig,
  type PaymentConfig,
  type ProvidersConfig,
  type ProviderConfig,
  type ConfiguredProviderAvailability,
  type EnvVarMapping,
  type ProviderEnvMapping,
  type EnvMappingConfig,
} from './config/index.js'

// ============================================================================
// TYPES - Core type definitions
// ============================================================================

export type {
  // Core types
  PaymentProvider,
  TransactionType,
  TaxInvoiceStatus,
  PaymentMethodType,
  CardBrand,
  PaymentAmount,
  CurrencyConversion,
  PaymentMetadata,
  ProviderMetadata,
  PaymentError,
  PaymentErrorCode,
  // Intent types
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
  // Health types
  ProviderHealthStatus,
  // State machine
  TransactionStatus,
  TransactionEvent,
  StateTransitionResult,
  // Webhook types
  WebhookStatus,
  WebhookEvent,
  WebhookProcessingResult,
  WebhookAction,
  ReconciliationResult,
} from './types/index.js'

// State machine utilities
export {
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
  TERMINAL_STATES,
  SUCCESS_STATES,
} from './types/index.js'

// ============================================================================
// SERVICES - Core service classes with DI support
// ============================================================================

// Payment Orchestrator
export {
  PaymentOrchestrator,
  createPaymentOrchestrator,
  type InitiatePaymentParams,
  type PaymentInitiationResult,
  type ConfirmPaymentParams,
  type PaymentConfirmationResult,
  type CapturePaymentParams as OrchestratorCaptureParams,
  type PaymentCaptureResult,
  type PaymentOrchestratorDeps,
} from './services/payment-orchestrator.js'

// Routing Engine
export {
  RoutingEngine,
  getRoutingEngine,
  createRoutingEngine,
  resetRoutingEngine,
  type RoutingEngineDeps,
  type RoutingRules,
  type CardBinRule,
  type ProviderPriorityRule,
  type CurrencyRule,
} from './services/routing-engine.js'

// Circuit Breaker
export {
  CircuitBreaker,
  getCircuitBreaker,
  createCircuitBreaker,
  resetCircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitState,
  type CircuitBreakerState,
  type CircuitBreakerDeps,
} from './services/circuit-breaker.js'

// Circuit Breaker Storage Interface
export type {
  ICircuitBreakerStorage,
  CircuitBreakerStateRecord,
  StoredCircuitState,
} from './services/circuit-breaker-storage.interface.js'
export {
  createDefaultState,
  isCircuitOpen,
  shouldAttemptHalfOpen,
} from './services/circuit-breaker-storage.interface.js'

// Storage Implementations
export {
  InMemoryCircuitBreakerStorage,
  getInMemoryStorage,
  resetInMemoryStorage,
  migrateFromLegacyMap,
} from './services/in-memory-storage.js'

// ============================================================================
// PROVIDER INTERFACES - Database-agnostic contracts
// ============================================================================

export type {
  IPaymentProvider,
  IWebhookHandler,
  IRoutingEngine,
  RoutingContext,
  RoutingDecision,
  SavePaymentMethodParams,
  SavePaymentMethodResult,
  CreateSetupIntentParams,
  SetupIntentResult,
  CreateCustomerParams,
  CreateCustomerResult,
} from './providers/interfaces/index.js'

// ============================================================================
// UTILITIES - Helper functions
// ============================================================================

export {
  generateInternalPaymentId,
  generateIdempotencyKey,
  generateDeterministicKey,
  generateOperationKey,
  isValidIdempotencyKey,
  isValidInternalPaymentId,
  verifyWebhookSignature,
  verifyStripeStyleSignature,
  verifySortedFieldsHmacSignature,
  verifyHmacSha256Signature,
  registerSignatureVerifier,
  getSignatureVerifier,
  getSignatureHeaderName,
  type SignatureVerificationParams,
  type SignatureVerificationResult,
  type SignatureVerifier,
} from './utils/index.js'

// ============================================================================
// REPOSITORY INTERFACES - Database-agnostic contracts
// ============================================================================

export type {
  // Interfaces
  ITransactionRepository,
  IPaymentMethodRepository,
  IWebhookEventRepository,
  IAuditLogRepository,
  IProviderHealthRepository,
  IPaymentRepositories,
  // Common types
  PaginationParams,
  PaginatedResult,
  DateRangeFilter,
  // Entity types
  Transaction,
  PaymentMethod,
  WebhookEvent as WebhookEventEntity,
  AuditLogEntry,
  ProviderHealth,
} from './repository/interfaces/index.js'

// ============================================================================
// IN-MEMORY REPOSITORY (Reference Implementation)
// ============================================================================

export { InMemoryTransactionRepository } from './repository/memory/index.js'
