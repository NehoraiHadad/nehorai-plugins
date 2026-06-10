import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SumitProvider } from '../src/sumit-provider.js';
import type { SumitResponse } from '../src/sumit-types.js';

/** Build a fetch mock that returns the given SUMIT envelope as JSON. */
function mockFetch(body: SumitResponse, ok = true, status = 200) {
  return vi.fn(async () => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  })) as unknown as typeof fetch;
}

function lastRequestBody(spy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = spy.mock.calls[spy.mock.calls.length - 1][1] as RequestInit;
  return JSON.parse(init.body as string);
}

const config = { companyId: 12345, apiKey: 'test-key', webhookToken: 'tok_secret' };

describe('SumitProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when required config is missing', () => {
    // @ts-expect-error intentionally invalid
    expect(() => new SumitProvider({ apiKey: 'x' })).toThrow();
  });

  describe('createPaymentIntent (one-time hosted checkout)', () => {
    it('returns redirect URL and appends internal_order_id to the return URL', async () => {
      const fetchSpy = mockFetch({
        Status: 0,
        Data: { RedirectURL: 'https://app.sumit.co.il/pay/abc', PaymentID: 'pay_1' },
      });
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SumitProvider(config);
      const result = await provider.createPaymentIntent({
        amount: { amountMinor: 4900, currency: 'ILS' },
        userId: 'user_1',
        idempotencyKey: 'ord_abc123',
        description: 'Story Creator Monthly',
        returnUrl: 'https://app.example.com/return',
        metadata: { customerEmail: 'a@b.com' },
      });

      expect(result.success).toBe(true);
      expect(result.redirectUrl).toBe('https://app.sumit.co.il/pay/abc');
      expect(result.providerIntentId).toBe('pay_1');
      expect(result.status).toBe('created');

      const body = lastRequestBody(fetchSpy as unknown as ReturnType<typeof vi.fn>);
      expect(body.Credentials).toEqual({ CompanyID: 12345, APIKey: 'test-key' });
      expect(String(body.RedirectURL)).toContain('internal_order_id=ord_abc123');
      // amount converted from minor units (4900) to major units (49)
      expect(JSON.stringify(body.Items)).toContain('"Price":49');
    });

    it('falls back to idempotencyKey as providerIntentId when SUMIT omits an id', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ Status: 0, Data: { RedirectURL: 'https://pay/x' } })
      );
      const provider = new SumitProvider(config);
      const result = await provider.createPaymentIntent({
        amount: { amountMinor: 1000, currency: 'ILS' },
        userId: 'u',
        idempotencyKey: 'ord_999',
      });
      expect(result.success).toBe(true);
      expect(result.providerIntentId).toBe('ord_999');
    });

    it('surfaces SUMIT errors (non-zero Status)', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ Status: 7, UserErrorMessage: 'Invalid API key' })
      );
      const provider = new SumitProvider(config);
      const result = await provider.createPaymentIntent({
        amount: { amountMinor: 1000, currency: 'ILS' },
        userId: 'u',
        idempotencyKey: 'ord_1',
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid API key');
      expect(result.errorCode).toBe('7');
    });
  });

  describe('getPaymentIntentStatus (supplementary verification)', () => {
    it('maps a valid payment to captured', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ Status: 0, Data: { ID: 'pay_1', ValidPayment: true } })
      );
      const provider = new SumitProvider(config);
      const { status } = await provider.getPaymentIntentStatus('pay_1');
      expect(status).toBe('captured');
    });

    it('maps an invalid payment to failed', async () => {
      vi.stubGlobal(
        'fetch',
        mockFetch({ Status: 0, Data: { ID: 'pay_1', ValidPayment: false } })
      );
      const provider = new SumitProvider(config);
      const { status } = await provider.getPaymentIntentStatus('pay_1');
      expect(status).toBe('failed');
    });
  });

  describe('createSubscription (recurring standing order)', () => {
    it('returns a redirect URL, subscription id and active status', async () => {
      const fetchSpy = mockFetch({
        Status: 0,
        Data: { RedirectURL: 'https://app.sumit.co.il/sub/1', PaymentID: 'sub_1' },
      });
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SumitProvider(config);
      const result = await provider.createSubscription({
        amount: { amountMinor: 2900, currency: 'ILS' },
        userId: 'user_1',
        idempotencyKey: 'sub_ord_1',
        interval: 'monthly',
      });

      expect(result.success).toBe(true);
      expect(result.providerSubscriptionId).toBe('sub_1');
      expect(result.redirectUrl).toBe('https://app.sumit.co.il/sub/1');
      expect(result.status).toBe('active');

      const body = lastRequestBody(fetchSpy as unknown as ReturnType<typeof vi.fn>);
      expect(body.Recurrence).toBeDefined();
    });
  });

  describe('validateWebhookSignature (URL token)', () => {
    it('accepts the configured token and rejects others', () => {
      const provider = new SumitProvider(config);
      expect(provider.validateWebhookSignature('{}', 'tok_secret')).toBe(true);
      expect(provider.validateWebhookSignature('{}', 'wrong')).toBe(false);
      expect(provider.validateWebhookSignature('{}', '')).toBe(false);
    });

    it('rejects when no token is configured', () => {
      const provider = new SumitProvider({ companyId: 1, apiKey: 'k' });
      expect(provider.validateWebhookSignature('{}', 'anything')).toBe(false);
    });
  });

  describe('unsupported operations', () => {
    it('void is not supported', async () => {
      const provider = new SumitProvider(config);
      const result = await provider.void({
        providerIntentId: 'p',
        authorizationCode: 'a',
        idempotencyKey: 'k',
      });
      expect(result.success).toBe(false);
    });

    it('refund is not supported (endpoint pending verification)', async () => {
      const provider = new SumitProvider(config);
      const result = await provider.refund({
        providerTransactionId: 'p',
        idempotencyKey: 'k',
      });
      expect(result.success).toBe(false);
    });
  });
});
