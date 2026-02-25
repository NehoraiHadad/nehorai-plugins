/**
 * Israeli Routing Rules Configuration
 *
 * Defines BIN (Bank Identification Number) ranges for smart routing
 * and provider selection rules.
 *
 * Exports ISRAELI_ROUTING_RULES as RoutingRules type from @nehorai/payments,
 * so it can be passed directly to createPaymentServices({ routingRules }).
 *
 * Israeli cards are routed to local gateways (Hyp/Cardcom) for:
 * - Better transaction fees (1.8% vs 2.9%)
 * - Higher approval rates for Israeli customers
 * - ILS currency support
 */

import type { PaymentProvider } from '@nehorai/payments/types';
import type {
  RoutingRules,
  CardBinRule,
  ProviderPriorityRule,
} from '@nehorai/payments/services';

// ============================================================================
// Israeli BIN Ranges
// ============================================================================

/**
 * BIN range definition (local type for documentation purposes)
 */
export interface BINRange {
  /** Starting BIN (6 digits) */
  start: string;
  /** Ending BIN (6 digits) */
  end: string;
  /** Card issuer name */
  issuer: string;
  /** Country code */
  country: string;
}

/**
 * Israeli credit card BIN ranges
 * These cards should be routed to local gateways for better rates
 *
 * Note: This is not exhaustive. In production, consider using a BIN database
 * service for comprehensive coverage.
 */
export const ISRAELI_BIN_RANGES: readonly BINRange[] = [
  // Isracard
  { start: '458000', end: '458999', issuer: 'Isracard', country: 'IL' },
  { start: '480000', end: '480999', issuer: 'Isracard', country: 'IL' },

  // Cal (Visa Cal)
  { start: '532600', end: '532699', issuer: 'Cal', country: 'IL' },
  { start: '557050', end: '557059', issuer: 'Cal', country: 'IL' },

  // Leumi Card
  { start: '589200', end: '589299', issuer: 'Leumi Card', country: 'IL' },

  // Diners Israel
  { start: '363700', end: '363799', issuer: 'Diners Israel', country: 'IL' },

  // Max (Leumi)
  { start: '491861', end: '491861', issuer: 'Max', country: 'IL' },
  { start: '458600', end: '458699', issuer: 'Max', country: 'IL' },
] as const;

// ============================================================================
// Card BIN Rules (RoutingRules-compatible)
// ============================================================================

/**
 * Israeli card BIN rules in CardBinRule format for the core routing engine.
 * All Israeli BIN ranges prefer 'hyp' as the primary local gateway.
 */
const ISRAELI_CARD_BIN_RULES: CardBinRule[] = [
  {
    ranges: ISRAELI_BIN_RANGES.map((r) => ({
      start: r.start,
      end: r.end,
      issuer: r.issuer,
      country: r.country,
    })),
    preferredProvider: 'hyp',
    priority: 1,
  },
];

// ============================================================================
// Provider Priority Rules (RoutingRules-compatible)
// ============================================================================

/**
 * Israeli provider priorities in ProviderPriorityRule format.
 * Local gateways (Hyp, Cardcom) are prioritized over international providers.
 */
const ISRAELI_PROVIDER_PRIORITIES: ProviderPriorityRule[] = [
  {
    provider: 'hyp',
    priority: 1,
    maxFeePercent: 1.8,
    supportsCurrency: ['ILS', 'USD', 'EUR'],
    supportsRecurring: true,
    isLocalGateway: true,
  },
  {
    provider: 'cardcom',
    priority: 2,
    maxFeePercent: 2.0,
    supportsCurrency: ['ILS', 'USD', 'EUR'],
    supportsRecurring: true,
    isLocalGateway: true,
  },
  {
    provider: 'stripe',
    priority: 3,
    maxFeePercent: 2.9,
    supportsCurrency: ['USD', 'EUR', 'GBP', 'ILS', 'CAD', 'AUD'],
    supportsRecurring: true,
    isLocalGateway: false,
  },
];

// ============================================================================
// Exported RoutingRules (core-compatible)
// ============================================================================

/**
 * Israeli routing rules, compatible with the core RoutingRules type.
 * Pass directly to createPaymentServices({ routingRules: ISRAELI_ROUTING_RULES }).
 */
export const ISRAELI_ROUTING_RULES: RoutingRules = {
  cardBinRules: ISRAELI_CARD_BIN_RULES,
  providerPriorities: ISRAELI_PROVIDER_PRIORITIES,
};

// ============================================================================
// Routing Functions
// ============================================================================

/**
 * Check if a BIN belongs to an Israeli card
 */
export function isIsraeliCard(bin: string): boolean {
  if (!bin || bin.length < 6) return false;

  const binPrefix = bin.substring(0, 6);

  return ISRAELI_BIN_RANGES.some(
    (range) => binPrefix >= range.start && binPrefix <= range.end
  );
}

/**
 * Get card issuer from BIN
 */
export function getCardIssuer(bin: string): string | null {
  if (!bin || bin.length < 6) return null;

  const binPrefix = bin.substring(0, 6);

  const range = ISRAELI_BIN_RANGES.find(
    (r) => binPrefix >= r.start && binPrefix <= r.end
  );

  return range?.issuer ?? null;
}

/**
 * Get optimal provider for a given context
 */
export function getOptimalProvider(
  isIsraeli: boolean,
  currency: string,
  requiresRecurring: boolean,
  availableProviders: PaymentProvider[]
): PaymentProvider | null {
  const candidates = ISRAELI_PROVIDER_PRIORITIES.filter((p) =>
    availableProviders.includes(p.provider)
  );

  if (candidates.length === 0) return null;

  const suitable = candidates.filter((p) => {
    if (!p.supportsCurrency.includes(currency)) return false;
    if (requiresRecurring && !p.supportsRecurring) return false;
    return true;
  });

  if (suitable.length === 0) {
    return candidates[0]?.provider ?? null;
  }

  if (isIsraeli) {
    const localProviders = suitable.filter((p) => p.isLocalGateway);
    if (localProviders.length > 0) {
      return localProviders.sort((a, b) => a.priority - b.priority)[0].provider;
    }
  }

  return suitable.sort((a, b) => a.priority - b.priority)[0].provider;
}

/**
 * Get fallback providers in order of priority
 */
export function getFallbackProviders(
  primaryProvider: PaymentProvider,
  availableProviders: PaymentProvider[]
): PaymentProvider[] {
  return ISRAELI_PROVIDER_PRIORITIES
    .filter((p) =>
      p.provider !== primaryProvider &&
      availableProviders.includes(p.provider)
    )
    .sort((a, b) => a.priority - b.priority)
    .map((p) => p.provider);
}

/**
 * Get estimated fee for a provider
 */
export function getProviderFeePercent(provider: PaymentProvider): number {
  const config = ISRAELI_PROVIDER_PRIORITIES.find((p) => p.provider === provider);
  return config?.maxFeePercent ?? 3.0;
}
