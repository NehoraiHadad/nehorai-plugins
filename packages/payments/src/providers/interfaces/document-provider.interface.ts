/**
 * @nehorai/payments - Document Provider Interface
 *
 * Capability interface for issuing accounting/tax documents (receipt, invoice,
 * invoice-receipt). Deliberately INDEPENDENT of {@link IPaymentProvider}:
 *
 * - A payment provider that auto-issues documents for its own charges (SUMIT's
 *   card rail) does not need this — those documents already exist.
 * - A payment that settled on a rail with no Israeli tax document (PayPal, a
 *   bank transfer) still needs one, and the application must not learn a
 *   bookkeeping vendor's field names to get it.
 *
 * So the application talks to ONE `IDocumentProvider` (chosen by config), and
 * the bookkeeping vendor (SUMIT today; Green Invoice / Morning tomorrow) is an
 * adapter behind it — the same seam that let PayPal ship alongside SUMIT
 * without touching the app's grant path.
 *
 * Idempotency contract: the caller supplies a unique
 * {@link IssueDocumentParams.externalId} per intended document and guards its
 * own ledger so a webhook/return race calls `issueDocument` once. The adapter
 * stamps `externalId` on the document; where the vendor supports lookup, it
 * also implements {@link IDocumentProvider.findDocumentByExternalId} so a retry
 * after an ambiguous failure (timeout) can recover the existing document rather
 * than issuing a duplicate.
 */

import type {
  DocumentType,
  IssueDocumentParams,
  IssuedDocument,
  FindDocumentParams,
} from '../../types/document-types.js';

export interface IDocumentProvider {
  /** Provider identifier (e.g. `'sumit'`). */
  readonly name: string;

  /** Document types this adapter can issue. */
  readonly supportedDocumentTypes: readonly DocumentType[];

  /**
   * Issue a document. Resolves with the issued document; rejects with a
   * `DocumentIssueError` (never a bare `Error`) when nothing was issued.
   */
  issueDocument(params: IssueDocumentParams): Promise<IssuedDocument>;

  /**
   * Optional: look up a document previously issued with this `externalId`.
   * Returns `null` when none exists. Adapters implement it when the vendor
   * exposes enough of a search surface; callers must treat it as best-effort.
   */
  findDocumentByExternalId?(params: FindDocumentParams): Promise<IssuedDocument | null>;
}
