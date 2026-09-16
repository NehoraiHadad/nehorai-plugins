/**
 * @nehorai/payments - Accounting Document Types
 *
 * Provider-neutral vocabulary for issuing tax documents (receipt / invoice /
 * invoice-receipt) for payments that settled OUTSIDE the document provider's
 * own card rail — e.g. a PayPal capture that still needs an Israeli קבלה.
 *
 * Nothing here names a provider field. An adapter (SUMIT, Green Invoice,
 * Morning, …) maps this shape to its API; the consuming application only ever
 * sees these types.
 */

// ============================================================================
// Enums as Union Types
// ============================================================================

/**
 * Kind of income document to issue.
 * - `receipt`         — קבלה: acknowledges a payment received.
 * - `invoice_receipt` — חשבונית מס/קבלה: tax invoice + receipt in one document.
 * - `invoice`         — חשבונית מס: tax invoice only (payment recorded separately).
 *
 * Which one a given payment needs is an accounting decision (VAT status of the
 * business, nature of the sale). Callers should make it a parameter, not a
 * constant buried in code.
 */
export type DocumentType = 'receipt' | 'invoice_receipt' | 'invoice';

/**
 * How the customer paid. Rendered on the document's payment section; a
 * provider maps it to its own payment-method taxonomy.
 */
export type DocumentPaymentMethod = 'card' | 'paypal' | 'bank_transfer' | 'other';

/** Document language, when the provider supports choosing one. */
export type DocumentLanguage = 'he' | 'en';

// ============================================================================
// Input
// ============================================================================

/** The customer the document is issued to. */
export interface DocumentCustomer {
  /** Full name or company name — required; providers reject nameless customers. */
  name: string;
  email?: string;
  /** Registered company / VAT number (ח.פ. / עוסק מורשה), when known. */
  taxId?: string;
  /**
   * Our own stable id for this customer (e.g. userId). Lets a provider reuse
   * the same customer entity across documents instead of creating one per call.
   */
  externalId?: string;
}

/** One line on the document. Money in MINOR units (agorot / cents). */
export interface DocumentLine {
  description: string;
  quantity: number;
  /** Price per unit in minor units. */
  unitAmountMinor: number;
  /** ISO-4217 code (must match {@link IssueDocumentParams.currency}). */
  currency: string;
}

/** Parameters for {@link IDocumentProvider.issueDocument}. */
export interface IssueDocumentParams {
  type: DocumentType;
  customer: DocumentCustomer;
  lines: DocumentLine[];
  /** Total paid, in minor units. Must equal the sum of the lines. */
  totalAmountMinor: number;
  /** ISO-4217 code. */
  currency: string;
  /** Whether the line prices already include VAT (true for consumer prices). */
  vatIncluded: boolean;
  paymentMethod: DocumentPaymentMethod;
  /** When the payment settled. Providers use it as the document date. */
  paidAt: Date;
  /**
   * OUR idempotency key for this document — the settled payment's id (PayPal
   * capture id, subscription cycle key, …). Stamped on the document so a retry
   * can find a document it already issued instead of issuing a second one.
   * MUST be unique per document the caller intends to exist.
   */
  externalId: string;
  /**
   * Provider-side payment reference to print in the payment section (e.g.
   * "PayPal capture 3C1234…"). Defaults to `externalId`.
   */
  paymentReference?: string;
  /** Free-text shown on the document (description / closing text). */
  notes?: string;
  language?: DocumentLanguage;
  /**
   * Ask the provider to email the document to `customer.email`. Defaults to
   * `false` — the application decides when and how the customer is notified.
   */
  sendToCustomer?: boolean;
}

// ============================================================================
// Output
// ============================================================================

/** A document the provider issued (or found by {@link IssueDocumentParams.externalId}). */
export interface IssuedDocument {
  /** Provider's internal document identifier (stable; use for later API calls). */
  documentId: string;
  /** Human-facing document number as printed on the document (e.g. "1042"). */
  documentNumber: string;
  /** Link to the PDF, when the provider returns one. */
  downloadUrl?: string;
  issuedAt: Date;
  type: DocumentType;
}

/** Parameters for {@link IDocumentProvider.findDocumentByExternalId}. */
export interface FindDocumentParams {
  externalId: string;
  type: DocumentType;
  /** Narrow the provider-side search window (inclusive). Defaults are provider-specific. */
  issuedAfter?: Date;
  issuedBefore?: Date;
}

// ============================================================================
// Errors
// ============================================================================

/** Machine-readable failure categories for {@link DocumentIssueError}. */
export type DocumentIssueErrorCode =
  | 'invalid_input'
  | 'unsupported_type'
  | 'provider_rejected'
  | 'provider_unavailable'
  | 'unknown';

/**
 * Thrown by {@link IDocumentProvider.issueDocument} when no document was
 * issued. `retryable` tells the caller whether a later retry (e.g. a recovery
 * cron) may succeed — network / 5xx / rate-limit failures are retryable, a
 * business rejection of the payload is not.
 *
 * A retryable error does NOT guarantee the provider did not issue the
 * document (a timeout after the provider committed is the classic case);
 * callers that retry should first ask
 * {@link IDocumentProvider.findDocumentByExternalId} when the provider offers it.
 */
export class DocumentIssueError extends Error {
  readonly retryable: boolean;
  readonly code: DocumentIssueErrorCode;
  /** Provider's own status / error code, verbatim, for logs. */
  readonly providerCode?: string;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      code?: DocumentIssueErrorCode;
      providerCode?: string;
      cause?: unknown;
    }
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DocumentIssueError';
    this.retryable = options.retryable;
    this.code = options.code ?? 'unknown';
    this.providerCode = options.providerCode;
  }
}

/** Type guard for {@link DocumentIssueError} across package boundaries. */
export function isDocumentIssueError(error: unknown): error is DocumentIssueError {
  return (
    error instanceof DocumentIssueError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'DocumentIssueError' &&
      typeof (error as { retryable?: unknown }).retryable === 'boolean')
  );
}
