import { describe, it, expect } from 'vitest';
import { addPaypalProvider, verifyPaypalSignature } from '../src/factory.js';
import { PaypalProvider } from '../src/paypal-provider.js';

const config = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  environment: 'sandbox' as const,
  webhookId: 'WH-TEST-ID',
};

function makeRegistry() {
  return {
    providers: new Map<string, unknown>(),
    webhookHandlers: new Map<string, unknown>(),
  };
}

describe('addPaypalProvider', () => {
  it('registers the PayPal provider + webhook handler', () => {
    const services = makeRegistry();
    addPaypalProvider(services, config);

    const provider = services.providers.get('paypal');
    expect(provider).toBeInstanceOf(PaypalProvider);
    expect(services.webhookHandlers.get('paypal')).toBeDefined();
  });

  it('registers a provider detected as an ISubscriptionProvider', () => {
    const services = makeRegistry();
    addPaypalProvider(services, config);
    const provider = services.providers.get('paypal') as PaypalProvider;
    // Runtime capability detection used by the core layer.
    expect('createSubscription' in provider).toBe(true);
    expect('cancelSubscription' in provider).toBe(true);
    expect(provider.supportsRecurring).toBe(true);
  });

  it('throws (fails closed) when required secrets are missing', () => {
    const services = makeRegistry();
    // @ts-expect-error intentionally invalid config
    expect(() => addPaypalProvider(services, { clientId: 'x' })).toThrow();
  });
});

describe('verifyPaypalSignature (sync registry stub)', () => {
  it('always fails closed and points to the async verifier', () => {
    const result = verifyPaypalSignature('{}', 'sig', 'secret');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/async/i);
  });
});
