import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  DocumentIssueError,
  isDocumentIssueError,
  type IDocumentProvider,
  type IssueDocumentParams,
  type IssuedDocument,
  type DocumentType,
} from '../src/index.js';
import type { IDocumentProvider as IDocumentProviderFromProviders } from '../src/providers/interfaces/index.js';
import {
  DocumentIssueError as DocumentIssueErrorFromTypes,
  type IssueDocumentParams as IssueDocumentParamsFromTypes,
} from '../src/types/index.js';

/**
 * A minimal in-memory adapter: proves the interface is implementable without
 * any vendor vocabulary, and that the optional lookup is genuinely optional.
 */
class MemoryDocumentProvider implements IDocumentProvider {
  readonly name = 'memory';
  readonly supportedDocumentTypes: readonly DocumentType[] = ['receipt', 'invoice_receipt'];
  private readonly issued = new Map<string, IssuedDocument>();

  async issueDocument(params: IssueDocumentParams): Promise<IssuedDocument> {
    if (!this.supportedDocumentTypes.includes(params.type)) {
      throw new DocumentIssueError(`unsupported: ${params.type}`, {
        retryable: false,
        code: 'unsupported_type',
      });
    }
    const existing = this.issued.get(params.externalId);
    if (existing) return existing;
    const doc: IssuedDocument = {
      documentId: `id-${this.issued.size + 1}`,
      documentNumber: String(1000 + this.issued.size),
      issuedAt: params.paidAt,
      type: params.type,
    };
    this.issued.set(params.externalId, doc);
    return doc;
  }
}

/** Same as above but WITHOUT the optional lookup — must still satisfy the interface. */
class LookupCapableProvider extends MemoryDocumentProvider {
  async findDocumentByExternalId(): Promise<IssuedDocument | null> {
    return null;
  }
}

const params: IssueDocumentParams = {
  type: 'receipt',
  customer: { name: 'Dana Cohen', email: 'dana@example.com', externalId: 'user_1' },
  lines: [{ description: '300 credits', quantity: 1, unitAmountMinor: 9000, currency: 'ILS' }],
  totalAmountMinor: 9000,
  currency: 'ILS',
  vatIncluded: true,
  paymentMethod: 'paypal',
  paidAt: new Date('2026-09-16T10:00:00Z'),
  externalId: 'capture_abc',
};

describe('IDocumentProvider contract', () => {
  it('is exported identically from the root, ./types and ./providers entry points', () => {
    expectTypeOf<IDocumentProvider>().toEqualTypeOf<IDocumentProviderFromProviders>();
    expectTypeOf<IssueDocumentParams>().toEqualTypeOf<IssueDocumentParamsFromTypes>();
    expect(DocumentIssueErrorFromTypes).toBe(DocumentIssueError);
  });

  it('carries only provider-neutral field names', () => {
    // The app must never see vendor vocabulary: a params object is fully
    // described by these keys and nothing else.
    expectTypeOf<keyof IssueDocumentParams>().toEqualTypeOf<
      | 'type'
      | 'customer'
      | 'lines'
      | 'totalAmountMinor'
      | 'currency'
      | 'vatIncluded'
      | 'paymentMethod'
      | 'paidAt'
      | 'externalId'
      | 'paymentReference'
      | 'notes'
      | 'language'
      | 'sendToCustomer'
    >();
    expectTypeOf<IssuedDocument['documentNumber']>().toEqualTypeOf<string>();
    expectTypeOf<IssuedDocument['downloadUrl']>().toEqualTypeOf<string | undefined>();
  });

  it('is implementable with or without the optional lookup', async () => {
    const minimal: IDocumentProvider = new MemoryDocumentProvider();
    const withLookup: IDocumentProvider = new LookupCapableProvider();
    expect(minimal.findDocumentByExternalId).toBeUndefined();
    expect(withLookup.findDocumentByExternalId).toBeTypeOf('function');

    const doc = await minimal.issueDocument(params);
    expect(doc).toMatchObject({ documentId: 'id-1', documentNumber: '1000', type: 'receipt' });
    // A second call with the same externalId is the adapter's idempotency seam.
    await expect(minimal.issueDocument(params)).resolves.toEqual(doc);
  });

  it('rejects with a typed DocumentIssueError carrying the retryable flag', async () => {
    const provider = new MemoryDocumentProvider();
    const failure = provider.issueDocument({ ...params, type: 'invoice' });
    await expect(failure).rejects.toBeInstanceOf(DocumentIssueError);
    await expect(failure).rejects.toMatchObject({
      name: 'DocumentIssueError',
      retryable: false,
      code: 'unsupported_type',
    });
  });
});

describe('DocumentIssueError', () => {
  it('defaults code to unknown and preserves the cause', () => {
    const cause = new Error('socket hang up');
    const error = new DocumentIssueError('network', { retryable: true, cause });
    expect(error.code).toBe('unknown');
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(cause);
    expect(error.providerCode).toBeUndefined();
    expect(error).toBeInstanceOf(Error);
  });

  it('isDocumentIssueError recognizes instances and structurally-equal copies', () => {
    expect(isDocumentIssueError(new DocumentIssueError('x', { retryable: false }))).toBe(true);
    // Cross-realm / cross-bundle copy (e.g. cjs + esm builds loaded together).
    expect(isDocumentIssueError({ name: 'DocumentIssueError', retryable: true })).toBe(true);
    expect(isDocumentIssueError(new Error('plain'))).toBe(false);
    expect(isDocumentIssueError(null)).toBe(false);
  });
});
