/**
 * SUMIT accounting-document provider — implements `IDocumentProvider`.
 *
 * Issues receipts / invoice-receipts / invoices through
 * `/accounting/documents/create/` for payments that settled OUTSIDE SUMIT's
 * card rail (PayPal, bank transfer). SUMIT's own card charges auto-issue their
 * document, so this provider must never be called for those — that would
 * double-issue.
 *
 * Mapping notes (verified against the swagger + live test-org round-trips on
 * 2026-09-16: create Receipt / InvoiceAndReceipt, getdetails, list):
 * - Money arrives in MINOR units and is sent in MAJOR units. ILS documents use
 *   `UnitPrice` / `Amount`; any other currency uses the `DocumentCurrency_*`
 *   fields and lets SUMIT apply its exchange rate (per the spec's guidance).
 * - `VATIncluded` is passed through verbatim — consumer prices are inclusive,
 *   and SUMIT's default (`false`) would add VAT on top.
 * - `externalId` (our idempotency key) is stamped on `Details.ExternalReference`;
 *   `findDocumentByExternalId` pages `/accounting/documents/list/` and matches
 *   on it, so a retry after an ambiguous failure can recover the document.
 * - A receipt-type document carries exactly one `Payments[]` entry with ONE
 *   `Details_*` object chosen from `paymentMethod`; a plain invoice carries none.
 */

import type { IDocumentProvider } from '@nehorai/payments/providers';
import {
  DocumentIssueError,
  type DocumentIssueErrorCode,
  type DocumentPaymentMethod,
  type DocumentType,
  type FindDocumentParams,
  type IssueDocumentParams,
  type IssuedDocument,
} from '@nehorai/payments/types';
import {
  SUMIT_API_BASE,
  buildCredentials,
  isSumitSuccess,
  mapSumitError,
  type SumitResponse,
} from './sumit-types.js';
import {
  SUMIT_CUSTOMER_SEARCH_MODE,
  SUMIT_DOCUMENT_ENDPOINTS,
  SUMIT_DOCUMENT_LANGUAGE,
  SUMIT_DOCUMENT_TYPE,
  type SumitCreateDocumentData,
  type SumitCreateDocumentRequest,
  type SumitDocumentItem,
  type SumitDocumentPayment,
  type SumitDocumentProviderConfig,
  type SumitDocumentTypeCode,
  type SumitListDocumentsData,
  type SumitListDocumentsRow,
} from './sumit-document-types.js';

const DOCUMENT_TYPE_TO_SUMIT: Record<DocumentType, SumitDocumentTypeCode> = {
  receipt: SUMIT_DOCUMENT_TYPE.RECEIPT,
  invoice_receipt: SUMIT_DOCUMENT_TYPE.INVOICE_AND_RECEIPT,
  invoice: SUMIT_DOCUMENT_TYPE.INVOICE,
};

const SUMIT_TO_DOCUMENT_TYPE: Record<number, DocumentType> = {
  [SUMIT_DOCUMENT_TYPE.RECEIPT]: 'receipt',
  [SUMIT_DOCUMENT_TYPE.INVOICE_AND_RECEIPT]: 'invoice_receipt',
  [SUMIT_DOCUMENT_TYPE.INVOICE]: 'invoice',
};

/** Human labels SUMIT prints in the payment section for non-card methods. */
const PAYMENT_METHOD_LABEL: Record<Exclude<DocumentPaymentMethod, 'card' | 'bank_transfer'>, string> = {
  paypal: 'PayPal',
  other: 'Other',
};

/** SUMIT list paging cap (spec: PageSize max 1000); we stay well below it. */
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 10;
/** Default lookup window when the caller gives no bounds. */
const DEFAULT_LOOKUP_DAYS = 90;

/** `YYYY-MM-DD` in Israel local time — SUMIT documents are dated in the company's zone. */
function toSumitDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function minorToMajor(amountMinor: number): number {
  return Math.round(amountMinor) / 100;
}

/** Numeric enum value from a SUMIT enum field serialized as number or name. */
function documentTypeFromSumit(raw: number | string | undefined): DocumentType | undefined {
  if (typeof raw === 'number') return SUMIT_TO_DOCUMENT_TYPE[raw];
  if (typeof raw === 'string') {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return SUMIT_TO_DOCUMENT_TYPE[numeric];
    const byName: Record<string, DocumentType> = {
      Receipt: 'receipt',
      InvoiceAndReceipt: 'invoice_receipt',
      Invoice: 'invoice',
    };
    return byName[raw];
  }
  return undefined;
}

export class SumitDocumentProvider implements IDocumentProvider {
  readonly name = 'sumit';
  readonly supportedDocumentTypes: readonly DocumentType[] = [
    'receipt',
    'invoice_receipt',
    'invoice',
  ];

  private readonly config: SumitDocumentProviderConfig;
  private readonly baseUrl: string;

  constructor(config: SumitDocumentProviderConfig) {
    if (!config.companyId || !config.apiKey) {
      throw new Error('SumitDocumentProvider requires companyId and apiKey in config');
    }
    this.config = config;
    this.baseUrl = config.baseUrl ?? SUMIT_API_BASE;
  }

  async issueDocument(params: IssueDocumentParams): Promise<IssuedDocument> {
    this.validate(params);

    const request = this.buildCreateRequest(params);
    const response = await this.makeRequest<SumitCreateDocumentData>(
      SUMIT_DOCUMENT_ENDPOINTS.CREATE,
      request
    );

    if (!isSumitSuccess(response)) {
      throw new DocumentIssueError(mapSumitError(response), {
        retryable: isTechnicalError(response),
        code: isTechnicalError(response) ? 'provider_unavailable' : 'provider_rejected',
        providerCode: String(response.Status),
      });
    }

    const data = response.Data;
    if (data?.DocumentID == null) {
      // Success envelope without an id: SUMIT may or may not have persisted
      // something. Not retryable — a blind retry risks a duplicate; the caller's
      // recovery path should go through findDocumentByExternalId first.
      throw new DocumentIssueError('SUMIT returned success without a DocumentID', {
        retryable: false,
        code: 'provider_rejected',
        providerCode: String(response.Status),
      });
    }

    return {
      documentId: String(data.DocumentID),
      documentNumber: data.DocumentNumber != null ? String(data.DocumentNumber) : String(data.DocumentID),
      downloadUrl: data.DocumentDownloadURL ?? undefined,
      issuedAt: new Date(),
      type: params.type,
    };
  }

  /**
   * Best-effort lookup by `ExternalReference` over `/accounting/documents/list/`.
   * The list API filters by type + date only, so we page a bounded window and
   * match client-side. Returns the FIRST non-draft match (documents are listed
   * newest-first per the live test; ties are irrelevant since the caller never
   * intends two documents for one externalId).
   */
  async findDocumentByExternalId(params: FindDocumentParams): Promise<IssuedDocument | null> {
    const to = params.issuedBefore ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
    const from =
      params.issuedAfter ?? new Date(to.getTime() - DEFAULT_LOOKUP_DAYS * 24 * 60 * 60 * 1000);

    for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      const response = await this.makeRequest<SumitListDocumentsData>(
        SUMIT_DOCUMENT_ENDPOINTS.LIST,
        {
          Credentials: buildCredentials(this.config),
          DocumentTypes: [DOCUMENT_TYPE_TO_SUMIT[params.type]],
          DateFrom: toSumitDate(from),
          DateTo: toSumitDate(to),
          IncludeDrafts: false,
          Paging: { StartIndex: page * LIST_PAGE_SIZE, PageSize: LIST_PAGE_SIZE },
        }
      );
      if (!isSumitSuccess(response)) {
        throw new DocumentIssueError(mapSumitError(response), {
          retryable: isTechnicalError(response),
          code: isTechnicalError(response) ? 'provider_unavailable' : 'provider_rejected',
          providerCode: String(response.Status),
        });
      }
      const rows = response.Data?.Documents ?? [];
      const match = rows.find(
        (row) => row.ExternalReference === params.externalId && row.IsDraft !== true
      );
      if (match) return this.rowToIssuedDocument(match, params.type);
      if (response.Data?.HasNextPage !== true || rows.length === 0) break;
    }
    return null;
  }

  // ==========================================================================
  // Mapping
  // ==========================================================================

  private validate(params: IssueDocumentParams): void {
    const fail = (message: string): never => {
      throw new DocumentIssueError(message, { retryable: false, code: 'invalid_input' });
    };
    if (!this.supportedDocumentTypes.includes(params.type)) {
      throw new DocumentIssueError(`Unsupported document type: ${params.type}`, {
        retryable: false,
        code: 'unsupported_type',
      });
    }
    if (!params.customer?.name?.trim()) fail('customer.name is required');
    if (!params.externalId?.trim()) fail('externalId is required');
    if (!params.lines?.length) fail('at least one line is required');
    if (!Number.isInteger(params.totalAmountMinor) || params.totalAmountMinor <= 0) {
      fail('totalAmountMinor must be a positive integer (minor units)');
    }
    const currency = params.currency?.trim().toUpperCase();
    if (!currency) fail('currency is required');
    let sum = 0;
    for (const line of params.lines) {
      if (!Number.isInteger(line.unitAmountMinor) || line.unitAmountMinor < 0) {
        fail('line.unitAmountMinor must be a non-negative integer (minor units)');
      }
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
        fail('line.quantity must be positive');
      }
      if (line.currency.trim().toUpperCase() !== currency) {
        fail('every line must be in the document currency');
      }
      sum += Math.round(line.unitAmountMinor * line.quantity);
    }
    if (sum !== params.totalAmountMinor) {
      fail(`lines sum to ${sum} minor units but totalAmountMinor is ${params.totalAmountMinor}`);
    }
    if (!(params.paidAt instanceof Date) || Number.isNaN(params.paidAt.getTime())) {
      fail('paidAt must be a valid Date');
    }
  }

  private buildCreateRequest(params: IssueDocumentParams): SumitCreateDocumentRequest {
    const currency = params.currency.trim().toUpperCase();
    const isIls = currency === 'ILS';
    const language = params.language ?? this.config.defaultLanguage;

    const items: SumitDocumentItem[] = params.lines.map((line) => {
      const unit = minorToMajor(line.unitAmountMinor);
      return {
        Item: { Name: line.description },
        Quantity: line.quantity,
        ...(isIls ? { UnitPrice: unit } : { DocumentCurrency_UnitPrice: unit }),
      };
    });

    const request: SumitCreateDocumentRequest = {
      Credentials: buildCredentials(this.config),
      Details: {
        Date: toSumitDate(params.paidAt),
        Customer: {
          Name: params.customer.name.trim(),
          ...(params.customer.email ? { EmailAddress: params.customer.email } : {}),
          ...(params.customer.taxId ? { CompanyNumber: params.customer.taxId } : {}),
          // Verified live: without SearchMode SUMIT creates a NEW customer per
          // document even when ExternalIdentifier repeats; SearchMode 2 reuses
          // the existing customer (same CustomerID) and creates one if absent.
          ...(params.customer.externalId
            ? {
                ExternalIdentifier: params.customer.externalId,
                SearchMode: SUMIT_CUSTOMER_SEARCH_MODE.EXTERNAL_IDENTIFIER,
              }
            : {}),
        },
        Type: DOCUMENT_TYPE_TO_SUMIT[params.type],
        Currency: currency,
        ExternalReference: params.externalId,
        ...(params.notes ? { Description: params.notes } : {}),
        ...(language
          ? {
              Language:
                language === 'en'
                  ? SUMIT_DOCUMENT_LANGUAGE.ENGLISH
                  : SUMIT_DOCUMENT_LANGUAGE.HEBREW,
            }
          : {}),
        ...(params.sendToCustomer && params.customer.email
          ? {
              SendByEmail: {
                EmailAddress: params.customer.email,
                Original: true,
                SendAsPaymentRequest: false,
              },
            }
          : {}),
      },
      Items: items,
      VATIncluded: params.vatIncluded,
    };

    // A plain invoice records no payment; every receipt flavour records one.
    if (params.type !== 'invoice') {
      const total = minorToMajor(params.totalAmountMinor);
      const payment: SumitDocumentPayment = {
        ...(isIls ? { Amount: total } : { DocumentCurrency_Amount: total }),
        ...this.paymentDetails(params),
      };
      request.Payments = [payment];
    }

    return request;
  }

  /** Exactly one `Details_*` object, chosen from the neutral payment method. */
  private paymentDetails(params: IssueDocumentParams): Partial<SumitDocumentPayment> {
    const reference = params.paymentReference ?? params.externalId;
    switch (params.paymentMethod) {
      case 'card':
        return { Details_CreditCard: {} };
      case 'bank_transfer':
        return { Details_BankTransfer: { Reference: reference } };
      case 'paypal':
      case 'other':
      default:
        return {
          Details_Other: {
            Type: PAYMENT_METHOD_LABEL[params.paymentMethod === 'paypal' ? 'paypal' : 'other'],
            Description: reference,
          },
        };
    }
  }

  private rowToIssuedDocument(row: SumitListDocumentsRow, fallbackType: DocumentType): IssuedDocument {
    const issuedAt = row.Date ? new Date(row.Date) : new Date();
    return {
      documentId: String(row.DocumentID),
      documentNumber: row.DocumentNumber != null ? String(row.DocumentNumber) : String(row.DocumentID),
      downloadUrl: row.DocumentDownloadURL ?? undefined,
      issuedAt: Number.isNaN(issuedAt.getTime()) ? new Date() : issuedAt,
      type: documentTypeFromSumit(row.Type) ?? fallbackType,
    };
  }

  // ==========================================================================
  // Transport
  // ==========================================================================

  private async makeRequest<T>(
    endpoint: string,
    body: Record<string, unknown>
  ): Promise<SumitResponse<T>> {
    const url = `${this.baseUrl}${endpoint}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // Network failure: unknown whether SUMIT received the request.
      throw new DocumentIssueError(
        `SUMIT request failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true, code: 'provider_unavailable', cause: error }
      );
    }

    if (!response.ok) {
      const code: DocumentIssueErrorCode =
        response.status >= 500 || response.status === 429
          ? 'provider_unavailable'
          : 'provider_rejected';
      throw new DocumentIssueError(
        `SUMIT API error: ${response.status} ${response.statusText}`,
        {
          retryable: code === 'provider_unavailable',
          code,
          providerCode: String(response.status),
        }
      );
    }

    try {
      return (await response.json()) as SumitResponse<T>;
    } catch (error) {
      throw new DocumentIssueError('SUMIT returned a non-JSON response', {
        retryable: false,
        code: 'provider_rejected',
        cause: error,
      });
    }
  }
}

/** `Teva.Common.ResponseStatus` TechnicalError (2) — treated as transient. */
function isTechnicalError(response: SumitResponse): boolean {
  return response.Status === 2 || response.Status === 'TechnicalError';
}
