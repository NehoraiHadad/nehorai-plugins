/**
 * @nehorai/payments-il - Israeli payment providers for PaymentOS
 *
 * Provides Hyp (CreditGuard) and Cardcom payment providers,
 * webhook handlers, and Israeli BIN routing rules.
 *
 * @example
 * ```typescript
 * import { addIsraeliProviders, isIsraeliCard } from '@nehorai/payments-il';
 *
 * const { providers, webhookHandlers } = addIsraeliProviders({
 *   hyp: { terminalNumber: '123', user: 'u', password: 'p', baseUrl: '...' },
 *   cardcom: { terminalNumber: '456', apiName: 'a', apiPassword: 'p' },
 * });
 * ```
 */

// Hyp Provider
export {
  HypProvider,
  HypWebhookHandler,
  createHypWebhookHandler,
} from './providers/hyp/index.js';

export type {
  HypConfig,
  HypDoDealRequest,
  HypDoDealResponse,
  HypRefundDealRequest,
  HypRefundDealResponse,
  HypResultCode,
} from './providers/hyp/index.js';

export {
  DEFAULT_HYP_ENDPOINTS,
  HYP_SUPPORTED_CURRENCIES,
  HYP_VALIDATION_MODES,
  HYP_TRANSACTION_TYPES,
  HYP_TRANSACTION_CODES,
  HYP_CREDIT_TYPES,
  HYP_RESULT_CODE_MAP,
  HYP_ERROR_MAP,
  mapHypStatus,
  mapHypError,
  isHypSupportedCurrency,
  isHypSuccess,
  formatHypAmount,
  formatCardExpiration,
  parseCardExpiration,
} from './providers/hyp/index.js';

// Cardcom Provider
export {
  CardcomProvider,
  CardcomWebhookHandler,
} from './providers/cardcom/index.js';

export type {
  CardcomProviderConfig,
} from './providers/cardcom/index.js';

export type {
  CardcomConfig,
  CardcomLowProfileRequest,
  CardcomLowProfileResponse,
  CardcomLowProfileStatusRequest,
  CardcomLowProfileStatusResponse,
  CardcomDirectChargeRequest,
  CardcomDirectChargeResponse,
  CardcomRefundRequest,
  CardcomRefundResponse,
  CardcomWebhookParams,
  CardcomWebhookEventType,
} from './providers/cardcom/index.js';

export {
  CardcomOperation,
  CardcomTransactionType,
  CARDCOM_API_BASE,
  CARDCOM_ENDPOINTS,
  CARDCOM_SUPPORTED_CURRENCIES,
  CARDCOM_WEBHOOK_EVENTS,
  CARDCOM_DEAL_RESPONSE_ACTIONS,
  CARDCOM_RESPONSE_CODE_MAP,
  CARDCOM_CURRENCY_CODES,
  CARDCOM_LANGUAGE_CODES,
  mapCardcomDealResponseToStatus,
  mapCardcomError,
  getCurrencyCode,
  validateCardcomCallback,
  parseCardcomCallbackUrl,
  isCardcomCallbackSuccess,
  isCardcomCallbackAuthorized,
  getCardcomCallbackError,
} from './providers/cardcom/index.js';

// Routing Rules
export {
  ISRAELI_BIN_RANGES,
  ISRAELI_ROUTING_RULES,
  isIsraeliCard,
  getCardIssuer,
  getOptimalProvider,
  getFallbackProviders,
  getProviderFeePercent,
} from './routing/index.js';

export type {
  BINRange,
} from './routing/index.js';

// Factory
export {
  addIsraeliProviders,
} from './factory.js';

export type {
  IsraeliProvidersConfig,
} from './factory.js';
