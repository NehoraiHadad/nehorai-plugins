import { FieldValue } from "firebase-admin/firestore";
import type { Firestore, Query, CollectionReference } from "firebase-admin/firestore";
import type { PortableJournalEntry, CreateJournalEntryInput, JournalEntryQuery } from "@nehorai/credits";
import { getUserCreditsCollection, toISOString } from "./shared.js";

/**
 * Journal subcollection name
 */
const JOURNAL_COLLECTION = "journal";

/**
 * Get user's journal collection reference
 */
function getUserJournalCollection(
  db: Firestore,
  userId: string
): CollectionReference {
  return getUserCreditsCollection(db, userId)
    .doc("data")
    .collection(JOURNAL_COLLECTION);
}

/**
 * Create a journal entry for audit trail
 *
 * Journal entries provide a complete audit trail of all credit changes.
 * They are immutable - once created, they should never be modified.
 *
 * @param db - Firestore instance
 * @param input - Journal entry data
 * @returns Created journal entry with ID
 */
export async function createJournalEntry(
  db: Firestore,
  input: CreateJournalEntryInput
): Promise<PortableJournalEntry> {
  const journalCol = getUserJournalCollection(db, input.userId);
  const docRef = journalCol.doc();

  const entry: Omit<PortableJournalEntry, "id" | "createdAt"> = {
    userId: input.userId,
    entryType: input.entryType,
    amount: input.amount,
    balanceAfter: input.balanceAfter,
    source: input.source,
    referenceId: input.referenceId,
    referenceType: input.referenceType,
    description: input.description,
    metadata: input.metadata,
  };

  await docRef.set({
    ...entry,
    createdAt: FieldValue.serverTimestamp(),
  });

  return {
    id: docRef.id,
    ...entry,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Build a query for journal entries based on query parameters
 */
function buildJournalQuery(
  collection: CollectionReference,
  query: JournalEntryQuery
): Query {
  let firestoreQuery: Query = collection;

  if (query.source) {
    firestoreQuery = firestoreQuery.where("source", "==", query.source);
  }

  if (query.referenceType) {
    firestoreQuery = firestoreQuery.where("referenceType", "==", query.referenceType);
  }

  if (query.startDate) {
    firestoreQuery = firestoreQuery.where("createdAt", ">=", query.startDate);
  }

  if (query.endDate) {
    firestoreQuery = firestoreQuery.where("createdAt", "<=", query.endDate);
  }

  // Order by createdAt descending (most recent first)
  firestoreQuery = firestoreQuery.orderBy("createdAt", "desc");

  return firestoreQuery;
}

/**
 * Get journal entries for a user with pagination
 *
 * @param db - Firestore instance
 * @param query - Query parameters
 * @returns List of journal entries
 */
export async function getJournalEntries(
  db: Firestore,
  query: JournalEntryQuery
): Promise<PortableJournalEntry[]> {
  const journalCol = getUserJournalCollection(db, query.userId);
  let firestoreQuery = buildJournalQuery(journalCol, query);

  // Apply pagination
  if (query.offset && query.offset > 0) {
    // Firestore doesn't support offset directly, so we fetch extra and skip
    // For production with large datasets, consider cursor-based pagination
    firestoreQuery = firestoreQuery.limit((query.offset || 0) + (query.limit || 50));
  } else {
    firestoreQuery = firestoreQuery.limit(query.limit || 50);
  }

  const snapshot = await firestoreQuery.get();

  const entries: PortableJournalEntry[] = [];
  let skipped = 0;

  for (const doc of snapshot.docs) {
    if (query.offset && skipped < query.offset) {
      skipped++;
      continue;
    }

    if (entries.length >= (query.limit || 50)) {
      break;
    }

    const data = doc.data();
    entries.push({
      id: doc.id,
      userId: data.userId,
      entryType: data.entryType,
      amount: data.amount,
      balanceAfter: data.balanceAfter,
      source: data.source,
      referenceId: data.referenceId,
      referenceType: data.referenceType,
      description: data.description,
      metadata: data.metadata,
      createdAt: toISOString(data.createdAt),
    });
  }

  return entries;
}

/**
 * Get count of journal entries for pagination
 *
 * @param db - Firestore instance
 * @param query - Query parameters (without limit/offset)
 * @returns Count of matching entries
 */
export async function getJournalEntriesCount(
  db: Firestore,
  query: Omit<JournalEntryQuery, "limit" | "offset">
): Promise<number> {
  const journalCol = getUserJournalCollection(db, query.userId);
  const firestoreQuery = buildJournalQuery(journalCol, query);

  const snapshot = await firestoreQuery.count().get();
  return snapshot.data().count;
}

/**
 * Create a journal entry within a transaction
 * Used for atomic operations where journal entry needs to be created
 * alongside other updates
 *
 * @param transaction - Firestore transaction
 * @param db - Firestore instance
 * @param input - Journal entry data
 * @returns ID of the created entry
 */
export function createJournalEntryInTransaction(
  transaction: FirebaseFirestore.Transaction,
  db: Firestore,
  input: CreateJournalEntryInput
): string {
  const journalCol = getUserJournalCollection(db, input.userId);
  const docRef = journalCol.doc();

  const entry: Omit<PortableJournalEntry, "id" | "createdAt"> = {
    userId: input.userId,
    entryType: input.entryType,
    amount: input.amount,
    balanceAfter: input.balanceAfter,
    source: input.source,
    referenceId: input.referenceId,
    referenceType: input.referenceType,
    description: input.description,
    metadata: input.metadata,
  };

  transaction.set(docRef, {
    ...entry,
    createdAt: FieldValue.serverTimestamp(),
  });

  return docRef.id;
}
