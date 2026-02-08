import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";
import type { PortableUsageLog, CreateUsageLogInput, UsageLogQuery } from "@nehorai/credits";
import { getUsageLogsCollection, toISOString } from "./shared";

/**
 * Log a credit usage event
 */
export async function logUsage(
  db: Firestore,
  input: CreateUsageLogInput
): Promise<PortableUsageLog> {
  const usageLogsCol = getUsageLogsCollection(db);
  const docRef = usageLogsCol.doc();

  const log: PortableUsageLog = {
    id: docRef.id,
    userId: input.userId,
    operationType: input.operationType,
    provider: input.provider,
    creditsUsed: input.creditsUsed,
    success: input.success,
    errorMessage: input.errorMessage,
    resourceId: input.resourceId,
    resourceType: input.resourceType,
    requestId: input.requestId,
    metadata: input.metadata,
    createdAt: new Date().toISOString(),
  };

  // Remove undefined values to satisfy Firestore requirements
  const cleanLog = Object.fromEntries(
    Object.entries(log).filter((entry) => entry[1] !== undefined)
  );

  await docRef.set({
    ...cleanLog,
    createdAt: FieldValue.serverTimestamp(),
  });

  return log;
}

/**
 * Get usage logs with filtering and pagination
 */
export async function getUsageLogs(
  db: Firestore,
  query: UsageLogQuery
): Promise<PortableUsageLog[]> {
  const usageLogsCol = getUsageLogsCollection(db);
  let firestoreQuery = usageLogsCol.orderBy("createdAt", "desc");

  // Apply filters
  if (query.userId) {
    firestoreQuery = firestoreQuery.where("userId", "==", query.userId);
  }
  if (query.operationType) {
    firestoreQuery = firestoreQuery.where("operationType", "==", query.operationType);
  }
  if (query.success !== undefined) {
    firestoreQuery = firestoreQuery.where("success", "==", query.success);
  }
  if (query.startDate) {
    firestoreQuery = firestoreQuery.where("createdAt", ">=", query.startDate);
  }
  if (query.endDate) {
    firestoreQuery = firestoreQuery.where("createdAt", "<=", query.endDate);
  }

  // Apply pagination
  if (query.offset) {
    firestoreQuery = firestoreQuery.offset(query.offset);
  }
  if (query.limit) {
    firestoreQuery = firestoreQuery.limit(query.limit);
  }

  const snapshot = await firestoreQuery.get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      ...data,
      id: doc.id,
      createdAt: toISOString(data.createdAt),
    } as PortableUsageLog;
  });
}

/**
 * Get count of usage logs matching query filters
 */
export async function getUsageLogsCount(
  db: Firestore,
  query: Omit<UsageLogQuery, "limit" | "offset">
): Promise<number> {
  const usageLogsCol = getUsageLogsCollection(db);
  let firestoreQuery = usageLogsCol.orderBy("createdAt", "desc");

  // Apply filters
  if (query.userId) {
    firestoreQuery = firestoreQuery.where("userId", "==", query.userId);
  }
  if (query.operationType) {
    firestoreQuery = firestoreQuery.where("operationType", "==", query.operationType);
  }
  if (query.success !== undefined) {
    firestoreQuery = firestoreQuery.where("success", "==", query.success);
  }

  const snapshot = await firestoreQuery.count().get();
  return snapshot.data().count;
}
