/**
 * SUMIT accounting-document fixtures.
 *
 * Shapes RECORDED from live calls against the test org ("Story Creator -
 * בדיקות", CompanyID 2012439015) on 2026-09-16 via
 * `scripts/sumit-document-test.mjs` in the story-creator repo:
 *   create Receipt (Type 2)            → DocumentID 2370285008, DocumentNumber 30000
 *   create InvoiceAndReceipt (Type 1)  → DocumentID 2370285229, DocumentNumber 10005
 *   getdetails 2370285008              → ExternalReference echoed, Payments[0].Type 8 (Other)
 *   list Receipt (DateFrom/DateTo)     → row carries ExternalReference + DownloadURL
 * Identifiers are the real ones SUMIT returned; no credentials are included.
 */

import type { SumitResponse } from '../../src/sumit-types.js';
import type {
  SumitCreateDocumentData,
  SumitGetDocumentDetailsData,
  SumitListDocumentsData,
} from '../../src/sumit-document-types.js';

/** `/accounting/documents/create/` — Receipt with one PayPal (Details_Other) payment. */
export const createReceiptResponse: SumitResponse<SumitCreateDocumentData> = {
  Status: 0,
  UserErrorMessage: null,
  TechnicalErrorDetails: null,
  Data: {
    DocumentID: 2370285008,
    DocumentNumber: 30000,
    CustomerID: 2370285007,
    DocumentDownloadURL:
      'https://pay.sumit.co.il/xa5jvr/a/history/1377fm7-2cdd3b4ef3/?download=2370285008&downloadkey=1377fm8&original=true',
    DocumentPaymentURL: null,
  },
};

/** `/accounting/documents/getdetails/` for the receipt above. */
export const getDetailsResponse: SumitResponse<SumitGetDocumentDetailsData> = {
  Status: 0,
  UserErrorMessage: null,
  TechnicalErrorDetails: null,
  Data: {
    Document: {
      Date: '2026-09-16T00:00:00+03:00',
      Type: 2,
      Description: 'Document adapter test (Receipt)',
      ExternalReference: 'doc-test-live1',
      Currency: 0,
      DocumentValue: 1,
    },
    Items: undefined,
    Payments: [
      {
        Amount: 1,
        // SUMIT auto-detected "Other" (8) from Details_Other.
        Type: 8,
        Details_Other: {
          Type: 'PayPal',
          Description: 'PayPal capture doc-test-live1',
          DueDate: '2026-09-16T00:00:00+03:00',
        },
      },
    ],
    DocumentDownloadURL:
      'https://pay.sumit.co.il/xa5jvr/a/history/1377fm7-2cdd3b4ef3/?download=2370285008&downloadkey=1377fm8&original=true',
    DocumentID: 2370285008,
    DocumentNumber: 30000,
  },
};

/** `/accounting/documents/list/` — one page; the second row is the receipt above. */
export const listDocumentsResponse: SumitResponse<SumitListDocumentsData> = {
  Status: 0,
  UserErrorMessage: null,
  TechnicalErrorDetails: null,
  Data: {
    Documents: [
      {
        DocumentID: 2370285153,
        DocumentNumber: 10006,
        Type: 2,
        Date: '2026-09-16T00:00:00+03:00',
        CustomerID: 2370285228,
        CustomerName: 'Doc Test IR',
        Currency: 0,
        Description: null,
        ExternalReference: 'doc-test-live3',
        DocumentDownloadURL:
          'https://pay.sumit.co.il/xa5jvr/a/history/1377fsc-9ef129609e/?download=2370285153&downloadkey=1377fq9&original=true',
        DocumentValue: 1,
        IsDraft: false,
      },
      {
        DocumentID: 2370285008,
        DocumentNumber: 30000,
        Type: 2,
        Date: '2026-09-16T00:00:00+03:00',
        CustomerID: 2370285007,
        CustomerName: 'Document Test Buyer',
        Currency: 0,
        Description: 'Document adapter test (Receipt)',
        ExternalReference: 'CAPTURE-3C1234',
        DocumentDownloadURL:
          'https://pay.sumit.co.il/xa5jvr/a/history/1377fm7-2cdd3b4ef3/?download=2370285008&downloadkey=1377fm8&original=true',
        DocumentValue: 1,
        IsDraft: false,
      },
    ],
    HasNextPage: false,
  },
};

/** Business error (Status 1): missing customer name. */
export const businessErrorResponse: SumitResponse = {
  Status: 1,
  UserErrorMessage: 'יש להזין ערך בשדה Customer.Name',
  TechnicalErrorDetails: null,
  Data: null as never,
};

/** Technical error (Status 2): SUMIT-side failure, transient. */
export const technicalErrorResponse: SumitResponse = {
  Status: 2,
  UserErrorMessage: 'אירעה שגיאה, נסו שוב מאוחר יותר',
  TechnicalErrorDetails: 'Object reference not set to an instance of an object.',
  Data: null as never,
};
