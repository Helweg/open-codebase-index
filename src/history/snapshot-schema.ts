import { z } from "zod";

const timestampProvenance = z.object({
  createdAt: z.enum(["created_at", "submitted_at", "legacy"]),
  updatedAt: z.enum(["updated_at", "unavailable", "legacy"]),
});
const document = z.object({
  id: z.string(), documentKind: z.enum(["body", "comment", "review", "review_comment"]),
  documentUrl: z.string(), body: z.string(), author: z.string(), createdAt: z.string(),
  updatedAt: z.string().nullable(), timestampProvenance: timestampProvenance.optional(), reviewState: z.string().optional(),
});
const entity = z.object({
  number: z.number().int().positive(), kind: z.enum(["issue", "pull_request"]), state: z.enum(["open", "closed", "merged", "draft"]),
  title: z.string(), url: z.string(), author: z.string(), createdAt: z.string(), updatedAt: z.string(),
  mergeCommitSha: z.string().optional(), linkedIssues: z.array(z.string()), commits: z.array(z.string()), files: z.array(z.string()),
  fileReferencesComplete: z.boolean(), totalChangedFiles: z.number().int().nonnegative(), documents: z.array(document),
});
export const historySnapshotSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), repository: z.string(), repositoryId: z.string().optional(), principalId: z.string().optional(),
  status: z.enum(["ready", "inaccessible", "error"]), initialSince: z.string().optional(), configuredInitialSince: z.string().nullable().optional(),
  maxNumber: z.number().int().nonnegative(), cursor: z.string().optional(), lastSyncedAt: z.string().optional(), lastError: z.string().optional(),
  syncGeneration: z.string().optional(),
  entities: z.array(entity), lexical: z.string(), lexicalVersion: z.number().int().nonnegative().optional(),
  httpCache: z.record(z.string(), z.object({ etag: z.string().regex(/^[\x21-\x7e]{1,1024}$/).optional(), fetchedAt: z.string(), value: z.unknown() })).optional(),
  httpCacheVersion: z.number().int().nonnegative().optional(),
}).superRefine((snapshot, context) => {
  if (snapshot.version === 2 && snapshot.entities.some((item) => item.documents.some((doc) => !doc.timestampProvenance))) {
    context.addIssue({ code: "custom", message: "version-2 documents require timestamp provenance" });
  }
});
