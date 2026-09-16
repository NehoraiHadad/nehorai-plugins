import { describe, it, expect, vi, afterEach } from 'vitest';
import { DocumentIssueError, type IssueDocumentParams } from '@nehorai/payments/types';
import { SumitDocumentProvider } from '../src/sumit-document-provider.js';
import type { SumitResponse } from '../src/sumit-types.js';
import {
  createReceiptResponse,
  listDocumentsResponse,
  businessErrorResponse,
  technicalErrorResponse,
} from './fixtures/sumit-documents.js';

/** Build a fetch mock that returns the given SUMIT envelope(s) as JSON, in order. */
function mockFetch(bodies: SumitResponse | SumitResponse[], ok = true, status = 200) {
  const queue = Array.isArray(bodies) ? [...bodies] : [bodies];
  return vi.fn(async () => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => queue.length > 1 ? queue.shift() : queue[0],
  })) as unknown as typeof fetch;
}

function requestBody(spy: unknown, call = 0): Record<string, unknown> {
  const init = (spy as ReturnType<typeof vi.fn>).mock.calls[call][1] as RequestInit;
  return JSON.parse(init.body as string);
}

function requestUrl(spy: unknown, call = 0): string {
  return (spy as ReturnType<typeof vi.fn>).mock.calls[call][0] as string;
}

const config = { companyId: 2012439015, apiKey: 'test-key' };

const paypalReceipt: IssueDocumentParams = {
  type: 'receipt',
  customer: { name: 'Dana Cohen', email: 'dana@example.com', externalId: 'user_1' },
  lines: [{ description: '300 Credits', quantity: 1, unitAmountMinor: 9000, currency: 'ILS' }],
  totalAmountMinor: 9000,
  currency: 'ILS',
  vatIncluded: true,
  paymentMethod: 'paypal',
  paidAt: new Date('2026-09-16T08:30:00Z'),
  externalId: 'CAPTURE-3C1234',
  paymentReference: 'PayPal capture 3C1234',
};

describe('SumitDocumentProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws when required config is missing', () => {
    // @ts-expect-error intentionally invalid
    expect(() => new SumitDocumentProvider({ apiKey: 'x' })).toThrow();
  });

  it('declares itself as the sumit adapter supporting the three income documents', () => {
    const provider = new SumitDocumentProvider(config);
    expect(provider.name).toBe('sumit');
    expect(provider.supportedDocumentTypes).toEqual(['receipt', 'invoice_receipt', 'invoice']);
  });

  describe('issueDocument', () => {
    it('maps a PayPal receipt to the verified /accounting/documents/create/ shape', async () => {
      const fetchSpy = mockFetch(createReceiptResponse);
      vi.stubGlobal('fetch', fetchSpy);

      const provider = new SumitDocumentProvider(config);
      const doc = await provider.issueDocument(paypalReceipt);

      expect(requestUrl(fetchSpy)).toBe('https://api.sumit.co.il/accounting/documents/create/');
      const body = requestBody(fetchSpy);
      expect(body.Credentials).toEqual({ CompanyID: 2012439015, APIKey: 'test-key' });

      const details = body.Details as Record<string, unknown>;
      // Receipt (2) per the verified DocumentType enum.
      expect(details.Type).toBe(2);
      // Document date = the payment date, in Israel local time.
      expect(details.Date).toBe('2026-09-16');
      expect(details.Currency).toBe('ILS');
      // OUR idempotency key is stamped on the document for retry lookup.
      expect(details.ExternalReference).toBe('CAPTURE-3C1234');
      // SearchMode 2 = match by ExternalIdentifier (verified live: reuses the
      // customer instead of creating one per document).
      expect(details.Customer).toEqual({
        Name: 'Dana Cohen',
        EmailAddress: 'dana@example.com',
        ExternalIdentifier: 'user_1',
        SearchMode: 2,
      });
      // The app decides when the customer is notified — no email by default.
      expect(details.SendByEmail).toBeUndefined();

      // Minor → major units, in the ILS fields (not DocumentCurrency_*).
      const items = body.Items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual({ Item: { Name: '300 Credits' }, Quantity: 1, UnitPrice: 90 });
      // Consumer prices are VAT-inclusive; SUMIT's default (false) would add VAT on top.
      expect(body.VATIncluded).toBe(true);

      // Exactly one payment with exactly one Details_* object.
      const payments = body.Payments as Array<Record<string, unknown>>;
      expect(payments).toHaveLength(1);
      expect(payments[0].Amount).toBe(90);
      expect(payments[0].Details_Other).toEqual({
        Type: 'PayPal',
        Description: 'PayPal capture 3C1234',
      });
      expect(Object.keys(payments[0]).filter((k) => k.startsWith('Details_'))).toEqual([
        'Details_Other',
      ]);

      // Neutral result — no SUMIT field names leak out.
      expect(doc).toMatchObject({
        documentId: '2370285008',
        documentNumber: '30000',
        downloadUrl: 'https://pay.sumit.co.il/xa5jvr/a/history/1377fm7-2cdd3b4ef3/?download=2370285008&downloadkey=1377fm8&original=true',
        type: 'receipt',
      });
      expect(doc.issuedAt).toBeInstanceOf(Date);
    });

    it('maps invoice_receipt → 1 and invoice → 0, and a plain invoice carries no Payments', async () => {
      const fetchSpy = mockFetch(createReceiptResponse);
      vi.stubGlobal('fetch', fetchSpy);
      const provider = new SumitDocumentProvider(config);

      await provider.issueDocument({ ...paypalReceipt, type: 'invoice_receipt' });
      expect((requestBody(fetchSpy, 0).Details as Record<string, unknown>).Type).toBe(1);
      expect(requestBody(fetchSpy, 0).Payments).toHaveLength(1);

      await provider.issueDocument({ ...paypalReceipt, type: 'invoice' });
      expect((requestBody(fetchSpy, 1).Details as Record<string, unknown>).Type).toBe(0);
      expect(requestBody(fetchSpy, 1).Payments).toBeUndefined();
    });

    it('uses the DocumentCurrency_* fields for non-ILS documents', async () => {
      const fetchSpy = mockFetch(createReceiptResponse);
      vi.stubGlobal('fetch', fetchSpy);
      const provider = new SumitDocumentProvider(config);

      await provider.issueDocument({
        ...paypalReceipt,
        currency: 'USD',
        lines: [{ description: 'Book', quantity: 2, unitAmountMinor: 1250, currency: 'usd' }],
        totalAmountMinor: 2500,
      });
      const body = requestBody(fetchSpy);
      const item = (body.Items as Array<Record<string, unknown>>)[0];
      expect(item.DocumentCurrency_UnitPrice).toBe(12.5);
      expect(item.UnitPrice).toBeUndefined();
      const payment = (body.Payments as Array<Record<string, unknown>>)[0];
      expect(payment.DocumentCurrency_Amount).toBe(25);
      expect(payment.Amount).toBeUndefined();
      expect((body.Details as Record<string, unknown>).Currency).toBe('USD');
    });

    it('maps card / bank_transfer / other to their Details_* objects', async () => {
      const fetchSpy = mockFetch(createReceiptResponse);
      vi.stubGlobal('fetch', fetchSpy);
      const provider = new SumitDocumentProvider(config);

      await provider.issueDocument({ ...paypalReceipt, paymentMethod: 'card' });
      expect((requestBody(fetchSpy, 0).Payments as Array<Record<string, unknown>>)[0]).toEqual({
        Amount: 90,
        Details_CreditCard: {},
      });

      await provider.issueDocument({ ...paypalReceipt, paymentMethod: 'bank_transfer' });
      expect((requestBody(fetchSpy, 1).Payments as Array<Record<string, unknown>>)[0]).toEqual({
        Amount: 90,
        Details_BankTransfer: { Reference: 'PayPal capture 3C1234' },
      });

      await provider.issueDocument({
        ...paypalReceipt,
        paymentMethod: 'other',
        paymentReference: undefined,
      });
      expect((requestBody(fetchSpy, 2).Payments as Array<Record<string, unknown>>)[0]).toEqual({
        Amount: 90,
        // paymentReference defaults to externalId.
        Details_Other: { Type: 'Other', Description: 'CAPTURE-3C1234' },
      });
    });

    it('passes language, notes, taxId and opt-in email through', async () => {
      const fetchSpy = mockFetch(createReceiptResponse);
      vi.stubGlobal('fetch', fetchSpy);
      const provider = new SumitDocumentProvider({ ...config, defaultLanguage: 'he' });

      await provider.issueDocument({
        ...paypalReceipt,
        customer: { ...paypalReceipt.customer, taxId: '515123456' },
        language: 'en',
        notes: 'Story Creator credit pack',
        sendToCustomer: true,
      });
      const details = requestBody(fetchSpy).Details as Record<string, unknown>;
      expect(details.Language).toBe(1); // English
      expect(details.Description).toBe('Story Creator credit pack');
      expect((details.Customer as Record<string, unknown>).CompanyNumber).toBe('515123456');
      expect(details.SendByEmail).toEqual({
        EmailAddress: 'dana@example.com',
        Original: true,
        SendAsPaymentRequest: false,
      });

      // Config default applies when the call does not specify a language.
      await provider.issueDocument(paypalReceipt);
      expect((requestBody(fetchSpy, 1).Details as Record<string, unknown>).Language).toBe(0);
    });

    it('rejects invalid input BEFORE calling SUMIT (non-retryable)', async () => {
      const fetchSpy = mockFetch(createReceiptResponse);
      vi.stubGlobal('fetch', fetchSpy);
      const provider = new SumitDocumentProvider(config);

      const cases: Array<[string, Partial<IssueDocumentParams>]> = [
        ['lines sum mismatch', { totalAmountMinor: 9001 }],
        ['no lines', { lines: [] }],
        ['empty name', { customer: { name: ' ' } }],
        ['empty externalId', { externalId: '' }],
        ['currency mismatch', { currency: 'USD' }],
        ['float minor units', { lines: [{ ...paypalReceipt.lines[0], unitAmountMinor: 90.5 }] }],
        ['invalid paidAt', { paidAt: new Date('nope') }],
      ];
      for (const [label, patch] of cases) {
        const failure = provider.issueDocument({ ...paypalReceipt, ...patch });
        await expect(failure, label).rejects.toBeInstanceOf(DocumentIssueError);
        await expect(failure, label).rejects.toMatchObject({ retryable: false, code: 'invalid_input' });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('maps a SUMIT business error to a non-retryable provider_rejected error', async () => {
      vi.stubGlobal('fetch', mockFetch(businessErrorResponse));
      const provider = new SumitDocumentProvider(config);
      const failure = provider.issueDocument(paypalReceipt);
      await expect(failure).rejects.toBeInstanceOf(DocumentIssueError);
      await expect(failure).rejects.toMatchObject({
        retryable: false,
        code: 'provider_rejected',
        providerCode: '1',
        message: 'יש להזין ערך בשדה Customer.Name',
      });
    });

    it('treats a SUMIT technical error, HTTP 5xx and a network failure as retryable', async () => {
      const provider = new SumitDocumentProvider(config);

      vi.stubGlobal('fetch', mockFetch(technicalErrorResponse));
      await expect(provider.issueDocument(paypalReceipt)).rejects.toMatchObject({
        retryable: true,
        code: 'provider_unavailable',
        providerCode: '2',
      });

      vi.stubGlobal('fetch', mockFetch({ Status: 0 }, false, 503));
      await expect(provider.issueDocument(paypalReceipt)).rejects.toMatchObject({
        retryable: true,
        code: 'provider_unavailable',
        providerCode: '503',
      });

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('socket hang up');
        })
      );
      await expect(provider.issueDocument(paypalReceipt)).rejects.toMatchObject({
        retryable: true,
        code: 'provider_unavailable',
      });
    });

    it('treats HTTP 4xx and a success envelope without DocumentID as non-retryable', async () => {
      const provider = new SumitDocumentProvider(config);

      vi.stubGlobal('fetch', mockFetch({ Status: 0 }, false, 401));
      await expect(provider.issueDocument(paypalReceipt)).rejects.toMatchObject({
        retryable: false,
        code: 'provider_rejected',
        providerCode: '401',
      });

      vi.stubGlobal('fetch', mockFetch({ Status: 0, Data: {} }));
      await expect(provider.issueDocument(paypalReceipt)).rejects.toMatchObject({
        retryable: false,
        code: 'provider_rejected',
      });
    });
  });

  describe('findDocumentByExternalId', () => {
    it('lists by type + date window and matches ExternalReference client-side', async () => {
      const fetchSpy = mockFetch(listDocumentsResponse);
      vi.stubGlobal('fetch', fetchSpy);
      const provider = new SumitDocumentProvider(config);

      const found = await provider.findDocumentByExternalId({
        externalId: 'CAPTURE-3C1234',
        type: 'receipt',
        issuedAfter: new Date('2026-09-01T00:00:00Z'),
        issuedBefore: new Date('2026-09-17T00:00:00Z'),
      });

      expect(requestUrl(fetchSpy)).toBe('https://api.sumit.co.il/accounting/documents/list/');
      const body = requestBody(fetchSpy);
      expect(body).toMatchObject({
        DocumentTypes: [2],
        DateFrom: '2026-09-01',
        DateTo: '2026-09-17',
        IncludeDrafts: false,
        Paging: { StartIndex: 0, PageSize: 100 },
      });
      expect(found).toMatchObject({
        documentId: '2370285008',
        documentNumber: '30000',
        type: 'receipt',
        downloadUrl: 'https://pay.sumit.co.il/xa5jvr/a/history/1377fm7-2cdd3b4ef3/?download=2370285008&downloadkey=1377fm8&original=true',
      });
      // SUMIT dates carry no zone; parsed as local midnight of that calendar day.
      expect(found?.issuedAt.getDate()).toBe(16);
      expect(found?.issuedAt.getMonth()).toBe(8);
    });

    it('returns null when nothing matches and stops at the last page', async () => {
      const fetchSpy = mockFetch(listDocumentsResponse);
      vi.stubGlobal('fetch', fetchSpy);
      const provider = new SumitDocumentProvider(config);
      const found = await provider.findDocumentByExternalId({
        externalId: 'never-issued',
        type: 'receipt',
      });
      expect(found).toBeNull();
      // HasNextPage=false in the fixture → exactly one page requested.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('pages until it finds the match', async () => {
      const page1: SumitResponse = {
        Status: 0,
        Data: { Documents: [{ DocumentID: 1, ExternalReference: 'x' }], HasNextPage: true },
      };
      const fetchSpy = mockFetch([page1, listDocumentsResponse]);
      vi.stubGlobal('fetch', fetchSpy);
      const provider = new SumitDocumentProvider(config);
      const found = await provider.findDocumentByExternalId({
        externalId: 'CAPTURE-3C1234',
        type: 'receipt',
      });
      expect(found?.documentId).toBe('2370285008');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect((requestBody(fetchSpy, 1).Paging as Record<string, unknown>).StartIndex).toBe(100);
    });
  });
});
