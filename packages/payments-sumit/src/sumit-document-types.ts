/**
 * SUMIT accounting-document API surface used by {@link SumitDocumentProvider}.
 *
 * Endpoints, field names and enums VERIFIED against the live OpenAPI 3.1 spec
 * (https://api.sumit.co.il/swagger/v1/swagger.json, 2026-09-16) and a live
 * create/getdetails/list round-trip on the test org. Kept in its own module so
 * the payment-provider types stay about payments.
 */

import type { SumitCredentials, SumitCustomer, SumitItem } from './sumit-types.js';

export const SUMIT_DOCUMENT_ENDPOINTS = {
  /** Create an income document (invoice / receipt / invoice+receipt / …). */
  CREATE: '/accounting/documents/create/',
  /** Fetch one document by DocumentID (or DocumentType + DocumentNumber). */
  GET_DETAILS: '/accounting/documents/getdetails/',
  /** List documents by type + date window (paged; company-wide). */
  LIST: '/accounting/documents/list/',
} as const;

/**
 * `Accounting_Typed_DocumentType` (subset). The API serializes the enum as a
 * number; names are listed for readability. Values verified from the swagger
 * enum `["Invoice (0)","InvoiceAndReceipt (1)","Receipt (2)", …]`.
 */
export const SUMIT_DOCUMENT_TYPE = {
  INVOICE: 0,
  INVOICE_AND_RECEIPT: 1,
  RECEIPT: 2,
} as const;

export type SumitDocumentTypeCode =
  (typeof SUMIT_DOCUMENT_TYPE)[keyof typeof SUMIT_DOCUMENT_TYPE];

/** `Accounting_Typed_DocumentPaymentType` (subset). */
export const SUMIT_DOCUMENT_PAYMENT_TYPE = {
  /** Detect from the supplied `Details_*` object. */
  AUTOMATIC: 0,
  GENERAL: 1,
  CASH: 2,
  BANK_TRANSFER: 3,
  CHEQUE: 4,
  CREDIT_CARD: 5,
  DIGITAL: 6,
  TAX_WITHHOLDING: 7,
  OTHER: 8,
} as const;

/** `Accounting_Typed_Language` (subset). */
export const SUMIT_DOCUMENT_LANGUAGE = {
  HEBREW: 0,
  ENGLISH: 1,
} as const;

/** `Accounting_Typed_CustomerSearchMode` (subset). */
export const SUMIT_CUSTOMER_SEARCH_MODE = {
  AUTOMATIC: 0,
  NONE: 1,
  EXTERNAL_IDENTIFIER: 2,
} as const;

// ============================================================================
// Request
// ============================================================================

/** `Accounting_Typed_Customer` — the document-API customer (superset of ChargeCustomer). */
export interface SumitDocumentCustomer extends SumitCustomer {
  /** Registered company / VAT number (ח.פ. / ע.מ.). */
  CompanyNumber?: string;
  /** VAT-exempt customer flag. Defaults to false. */
  NoVAT?: boolean;
  /** How to match an existing customer; see {@link SUMIT_CUSTOMER_SEARCH_MODE}. */
  SearchMode?: number;
}

/** `Accounting_Typed_DocumentSendByEmail`. */
export interface SumitDocumentSendByEmail {
  /** Defaults to the customer's email. */
  EmailAddress?: string;
  /** Send the original (true) or a copy. */
  Original: boolean;
  SendAsPaymentRequest: boolean;
}

/** `Accounting_Typed_DocumentDetails`. */
export interface SumitDocumentDetails {
  IsDraft?: boolean;
  /** Document date, `YYYY-MM-DD`. Defaults to today. */
  Date?: string;
  Customer: SumitDocumentCustomer;
  SendByEmail?: SumitDocumentSendByEmail;
  /** {@link SUMIT_DOCUMENT_LANGUAGE}; defaults to the company language. */
  Language?: number;
  /** Currency enum NAME (ISO for ILS/USD/EUR); defaults to the company currency. */
  Currency?: string;
  /** {@link SUMIT_DOCUMENT_TYPE}. */
  Type: number;
  /** Shown on the printed document. */
  Description?: string;
  /** Free reference we stamp with OUR idempotency key; echoed by getdetails/list. */
  ExternalReference?: string;
  OpeningText?: string;
  ClosingText?: string;
  DueDate?: string;
}

/** `Accounting_Typed_DocumentItem`. */
export interface SumitDocumentItem {
  /** Defaults to 1. */
  Quantity?: number;
  /** Unit price in ILS (major units). Leave empty for non-ILS + auto exchange rate. */
  UnitPrice?: number;
  /** Total in ILS; omitted ⇒ UnitPrice × Quantity. */
  TotalPrice?: number;
  /** Unit price in the document currency (non-ILS documents). */
  DocumentCurrency_UnitPrice?: number;
  DocumentCurrency_TotalPrice?: number;
  Item?: SumitItem;
  /** Shown on the printed document. */
  Description?: string;
}

/** `Accounting_Typed_Payment_Other` — custom payment method (our PayPal case). */
export interface SumitDocumentPaymentOther {
  Type?: string;
  Description?: string;
  DueDate?: string;
}

/** `Accounting_Typed_Payment_CreditCard` — external card (not charged by SUMIT). */
export interface SumitDocumentPaymentCreditCard {
  CardBrand?: string;
  Last4Digits?: string;
  Payments?: number;
}

/** `Accounting_Typed_Payment_BankTransfer`. */
export interface SumitDocumentPaymentBankTransfer {
  BankNumber?: number;
  BranchNumber?: number;
  AccountNumber?: string;
  Reference?: string;
  DueDate?: string;
}

/**
 * `Accounting_Typed_DocumentPayment`. Exactly ONE `Details_*` object per
 * payment; multiple payments go in the array.
 */
export interface SumitDocumentPayment {
  /** Received amount in ILS (major units). */
  Amount?: number;
  /** Received amount in the document currency (non-ILS documents). */
  DocumentCurrency_Amount?: number;
  /** {@link SUMIT_DOCUMENT_PAYMENT_TYPE}; empty ⇒ detected from `Details_*`. */
  Type?: number;
  Details_General?: Record<string, never>;
  Details_Cash?: Record<string, never>;
  Details_BankTransfer?: SumitDocumentPaymentBankTransfer;
  Details_CreditCard?: SumitDocumentPaymentCreditCard;
  Details_Other?: SumitDocumentPaymentOther;
  Details_Digital?: { Type?: string; Description?: string };
}

/** `Accounting_Documents_Create_Request`. */
export interface SumitCreateDocumentRequest {
  Credentials: SumitCredentials;
  Details: SumitDocumentDetails;
  Items?: SumitDocumentItem[];
  /** Receipts / invoice-receipts carry the payments; plain invoices do not. */
  Payments?: SumitDocumentPayment[];
  /** Are the item prices VAT-inclusive? Empty ⇒ false (VAT added on top!). */
  VATIncluded?: boolean;
  VATPerItem?: boolean;
  VATRate?: number;
  OriginalDocumentID?: number;
  [key: string]: unknown;
}

// ============================================================================
// Responses (`Data` payloads)
// ============================================================================

/** `Accounting_Documents_Create_Response`. */
export interface SumitCreateDocumentData {
  DocumentID?: number;
  DocumentNumber?: number | null;
  CustomerID?: number;
  /** Original on first fetch, certified copy afterwards. */
  DocumentDownloadURL?: string | null;
  DocumentPaymentURL?: string | null;
}

/** `Accounting_Typed_ListDocumentsDocument` (subset). */
export interface SumitListDocumentsRow {
  DocumentID?: number;
  DocumentNumber?: number | null;
  Type?: number | string;
  Date?: string | null;
  CustomerID?: number;
  CustomerName?: string | null;
  Currency?: number | string | null;
  Description?: string | null;
  ExternalReference?: string | null;
  DocumentDownloadURL?: string | null;
  DocumentValue?: number | null;
  IsDraft?: boolean | null;
}

/** `Accounting_Documents_List_Response`. */
export interface SumitListDocumentsData {
  Documents?: SumitListDocumentsRow[];
  HasNextPage?: boolean;
}

/** `Accounting_Documents_GetDetails_Response` (subset). */
export interface SumitGetDocumentDetailsData {
  Document?: {
    Date?: string | null;
    Type?: number | string;
    Description?: string | null;
    ExternalReference?: string | null;
    Currency?: number | string | null;
    DocumentValue?: number | null;
  };
  Items?: SumitDocumentItem[];
  Payments?: SumitDocumentPayment[];
  DocumentDownloadURL?: string | null;
  DocumentID?: number;
  DocumentNumber?: number | null;
}

/** Config for {@link SumitDocumentProvider} — the same credentials as the payment provider. */
export interface SumitDocumentProviderConfig {
  companyId: number;
  apiKey: string;
  baseUrl?: string;
  /**
   * Document language when the caller does not specify one. Defaults to the
   * company language at SUMIT (omitted from the request).
   */
  defaultLanguage?: 'he' | 'en';
}
