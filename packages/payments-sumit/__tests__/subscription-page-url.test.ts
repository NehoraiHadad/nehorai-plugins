import { describe, it, expect } from 'vitest';
import {
  buildSubscriptionPageUrl,
  parseSubscriptionReturn,
  SUCCESS_REDIRECT_QUERY_KEY,
} from '../src/subscription-page-url.js';

const BASE = 'https://app.sumit.co.il/pages/premium-monthly';

describe('buildSubscriptionPageUrl', () => {
  it('decorates the page URL with the required binding params', () => {
    const url = buildSubscriptionPageUrl(BASE, {
      userId: 'user_1',
      subscriptionId: 'sub_abc',
      returnUrl: 'https://app.example.com/return',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('customerexternalidentifier')).toBe('user_1');
    expect(parsed.searchParams.get('externalidentifier')).toBe('sub_abc');
    expect(parsed.searchParams.get(SUCCESS_REDIRECT_QUERY_KEY)).toBe(
      'https://app.example.com/return'
    );
  });

  it('uses the isolated success-redirect query key', () => {
    const url = buildSubscriptionPageUrl(BASE, {
      userId: 'u',
      subscriptionId: 's',
      returnUrl: 'https://r.example.com/done',
    });
    expect(new URL(url).searchParams.get(SUCCESS_REDIRECT_QUERY_KEY)).toBe(
      'https://r.example.com/done'
    );
  });

  it('URL-encodes the return URL safely (query params survive round-trip)', () => {
    const returnUrl = 'https://app.example.com/return?locale=he&from=pricing';
    const url = buildSubscriptionPageUrl(BASE, {
      userId: 'u',
      subscriptionId: 's',
      returnUrl,
    });
    // The encoded return URL must be readable back intact.
    expect(new URL(url).searchParams.get(SUCCESS_REDIRECT_QUERY_KEY)).toBe(returnUrl);
  });

  it('preserves pre-existing query params on the page base URL', () => {
    const url = buildSubscriptionPageUrl(`${BASE}?ref=campaign&lang=he`, {
      userId: 'u',
      subscriptionId: 's',
      returnUrl: 'https://r.example.com',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('ref')).toBe('campaign');
    expect(parsed.searchParams.get('lang')).toBe('he');
    expect(parsed.searchParams.get('customerexternalidentifier')).toBe('u');
  });

  it('emits fixedrecurrence for a finite bounded cycle count >= 1', () => {
    const url = buildSubscriptionPageUrl(BASE, {
      userId: 'u',
      subscriptionId: 's',
      returnUrl: 'https://r.example.com',
      fixedRecurrence: 12,
    });
    expect(new URL(url).searchParams.get('fixedrecurrence')).toBe('12');
  });

  it('emits fixedrecurrence=1 (boundary)', () => {
    const url = buildSubscriptionPageUrl(BASE, {
      userId: 'u',
      subscriptionId: 's',
      returnUrl: 'https://r.example.com',
      fixedRecurrence: 1,
    });
    expect(new URL(url).searchParams.get('fixedrecurrence')).toBe('1');
  });

  it('omits fixedrecurrence when undefined (open-ended standing order)', () => {
    const url = buildSubscriptionPageUrl(BASE, {
      userId: 'u',
      subscriptionId: 's',
      returnUrl: 'https://r.example.com',
    });
    expect(new URL(url).searchParams.has('fixedrecurrence')).toBe(false);
  });

  it('omits fixedrecurrence when < 1 or non-finite', () => {
    const zero = buildSubscriptionPageUrl(BASE, {
      userId: 'u',
      subscriptionId: 's',
      returnUrl: 'https://r.example.com',
      fixedRecurrence: 0,
    });
    expect(new URL(zero).searchParams.has('fixedrecurrence')).toBe(false);

    const inf = buildSubscriptionPageUrl(BASE, {
      userId: 'u',
      subscriptionId: 's',
      returnUrl: 'https://r.example.com',
      fixedRecurrence: Infinity,
    });
    expect(new URL(inf).searchParams.has('fixedrecurrence')).toBe(false);
  });

  it('includes optional name and emailaddress prefill when provided', () => {
    const url = buildSubscriptionPageUrl(BASE, {
      userId: 'u',
      subscriptionId: 's',
      returnUrl: 'https://r.example.com',
      customerName: 'Dana Cohen',
      customerEmail: 'dana@example.com',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('name')).toBe('Dana Cohen');
    expect(parsed.searchParams.get('emailaddress')).toBe('dana@example.com');
  });

  it('omits name and emailaddress when absent', () => {
    const url = buildSubscriptionPageUrl(BASE, {
      userId: 'u',
      subscriptionId: 's',
      returnUrl: 'https://r.example.com',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.has('name')).toBe(false);
    expect(parsed.searchParams.has('emailaddress')).toBe(false);
  });
});

describe('parseSubscriptionReturn', () => {
  it('parses all og-* params from a URLSearchParams', () => {
    const query = new URLSearchParams({
      'og-paymentid': '12345',
      'og-externalidentifier': 'sub_abc',
      'og-customerid': 'cust_77',
      'og-paymenttype': 'CreditCard',
      'og-documentnumber': 'INV-001',
    });
    expect(parseSubscriptionReturn(query)).toEqual({
      paymentId: '12345',
      subscriptionId: 'sub_abc',
      customerId: 'cust_77',
      paymentType: 'CreditCard',
      documentNumber: 'INV-001',
    });
  });

  it('parses from a raw query string (with leading ?)', () => {
    const result = parseSubscriptionReturn(
      '?og-paymentid=999&og-externalidentifier=sub_x'
    );
    expect(result.paymentId).toBe('999');
    expect(result.subscriptionId).toBe('sub_x');
  });

  it('parses from a plain object map', () => {
    const result = parseSubscriptionReturn({
      'og-paymentid': '7',
      'og-customerid': 'c1',
    });
    expect(result.paymentId).toBe('7');
    expect(result.customerId).toBe('c1');
  });

  it('reads og-* keys case-insensitively', () => {
    const result = parseSubscriptionReturn({
      'OG-PaymentID': '42',
      'Og-ExternalIdentifier': 'sub_42',
    });
    expect(result.paymentId).toBe('42');
    expect(result.subscriptionId).toBe('sub_42');
  });

  it('flattens array values to the first entry', () => {
    const result = parseSubscriptionReturn({
      'og-paymentid': ['100', '200'],
    });
    expect(result.paymentId).toBe('100');
  });

  it('returns undefined for absent and empty params', () => {
    const result = parseSubscriptionReturn({
      'og-paymentid': '',
      'og-customerid': undefined,
    });
    expect(result.paymentId).toBeUndefined();
    expect(result.subscriptionId).toBeUndefined();
    expect(result.customerId).toBeUndefined();
    expect(result.paymentType).toBeUndefined();
    expect(result.documentNumber).toBeUndefined();
  });

  it('returns undefined for an empty-array value', () => {
    const result = parseSubscriptionReturn({ 'og-paymentid': [] });
    expect(result.paymentId).toBeUndefined();
  });
});
