import type { SharedRepositoryHistorySearchArgs } from "../tools/contracts.js";
import type { OperationControl } from "../utils/operation-control.js";
import type { HistoryDocument, HistorySnapshot, RepositoryHistorySearchHit } from "./types.js";
import { historyTokens, normalizeHistoryLexicalText } from "./lexical.js";
import { historyDocumentId, historyMetadataId } from "./lexical-index.js";
import { checkpointHistoryWork } from "./work.js";

/** A source-text window with whole-token coverage, not an arbitrary title/substring prefix. */
export function historyExcerpt(body: string, query: string): string {
  const wanted = new Set(historyTokens(query));
  const matches: { token: string; offset: number; end: number }[] = [];
  const frequencies = new Map<string, number>();
  for (const match of body.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = match[0].toLowerCase();
    if (!wanted.has(token)) continue;
    matches.push({ token, offset: match.index, end: match.index + match[0].length });
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  if (!matches.length) return body.slice(0, 800);
  const weights = new Map([...frequencies].map(([token, count]) => [token, (1 + Math.log1p(token.length)) / count]));
  const counts = new Map<string, number>();
  let left = 0;
  let right = 0;
  let score = 0;
  let bestScore = -1;
  let bestStart = 0;
  let bestContext = -1;
  let contextual = 0;
  let aligned = 0;
  // Merge two monotonic candidate streams: ordinary context and right-edge alignment.
  while (contextual < matches.length || aligned < matches.length) {
    const contextStart = contextual < matches.length ? Math.max(0, matches[contextual].offset - 100) : Infinity;
    const alignedStart = aligned < matches.length ? Math.max(0, matches[aligned].end - 800) : Infinity;
    const start = Math.min(contextStart, alignedStart);
    if (contextStart === start) contextual++;
    if (alignedStart === start) aligned++;
    while (left < right && matches[left].offset < start) {
      const token = matches[left++].token;
      const count = (counts.get(token) ?? 0) - 1;
      counts.set(token, count);
      if (!count) score -= weights.get(token) ?? 0;
    }
    if (left === right) {
      while (right < matches.length && matches[right].offset < start) right++;
      left = right;
    }
    while (right < matches.length && matches[right].end <= start + 800) {
      const token = matches[right++].token;
      if (!counts.get(token)) score += weights.get(token) ?? 0;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    const lastEnd = right > left ? matches[right - 1].end : start;
    const context = Math.min(100, Math.max(0, Math.min(body.length, start + 800) - lastEnd));
    if (score > bestScore + 1e-12 || Math.abs(score - bestScore) <= 1e-12 && context > bestContext) {
      bestScore = score; bestStart = start; bestContext = context;
    }
  }
  return body.slice(bestStart, bestStart + 800);
}

function identity(query: string, repository: string): { number: number; documentFragment?: string } | undefined {
  const text = query.trim();
  const number = /^#([1-9][0-9]*)$/.exec(text);
  if (number) return { number: Number(number[1]) };
  const qualified = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(text);
  if (qualified?.[1].toLowerCase() === repository) return { number: Number(qualified[2]) };
  const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/([1-9][0-9]*)(#[^\s]+)?\/?$/i.exec(text);
  if (url?.[1].toLowerCase() === repository) return { number: Number(url[2]), documentFragment: url[3] };
  return undefined;
}

function documentOrder(left: HistoryDocument, right: HistoryDocument): number {
  return (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt) || left.documentUrl.localeCompare(right.documentUrl);
}

interface HistoryCandidate {
  entity: HistorySnapshot["entities"][number];
  doc: HistoryDocument;
  direct: boolean;
  score: number;
}

export async function searchHistory(snapshot: HistorySnapshot, directory: string, args: SharedRepositoryHistorySearchArgs, control?: OperationControl): Promise<RepositoryHistorySearchHit[]> {
  const { InvertedIndex } = await import("../native/inverted-index.js");
  const lexical = new InvertedIndex(directory);
  lexical.deserialize(snapshot.lexical);
  await checkpointHistoryWork(control);
  const count = snapshot.entities.reduce((total, entity) => total + entity.documents.length + 1, 0);
  const scores = lexical.search(normalizeHistoryLexicalText(args.query), count);
  await checkpointHistoryWork(control);
  const requested = identity(args.query, snapshot.repository);
  const tokens = historyTokens(args.query);
  const author = args.author?.toLowerCase();
  let maximum = 0;
  for (const score of scores.values()) maximum = Math.max(maximum, score);
  const candidates: HistoryCandidate[] = [];
  let processed = 0;
  for (const entity of snapshot.entities) {
    if (++processed % 32 === 0) await checkpointHistoryWork(control);
    if (args.kind && entity.kind !== args.kind || args.state && entity.state !== args.state) continue;
    const direct = requested?.number === entity.number;
    const documentUrl = direct && requested.documentFragment ? `${entity.url}${requested.documentFragment}` : undefined;
    let primary: HistoryDocument | undefined;
    let best: HistoryDocument | undefined;
    let fallback: HistoryDocument | undefined;
    let anchor: HistoryDocument | undefined;
    let bestScore = 0;
    for (const doc of entity.documents) {
      if (author && doc.author.toLowerCase() !== author) continue;
      if (doc.documentKind === "body") primary = doc;
      if (!fallback || documentOrder(doc, fallback) < 0) fallback = doc;
      if (doc.documentUrl === documentUrl) anchor = doc;
      const score = scores.get(historyDocumentId(entity.number, doc.id));
      if (score !== undefined && (!best || score > bestScore || score === bestScore && documentOrder(doc, best) < 0)) { best = doc; bestScore = score; }
    }
    if (!fallback) continue;
    const metadata = scores.get(historyMetadataId(entity.number)) ?? 0;
    if (!metadata && !best && !direct) continue;
    const title = new Set(historyTokens(entity.title));
    const titleDriven = tokens.length > 0 && tokens.every((token) => title.has(token));
    const doc = anchor ?? (primary && (direct || titleDriven || metadata >= bestScore) ? primary : best ?? primary ?? fallback);
    candidates.push({ entity, doc, direct, score: metadata + bestScore + (direct ? maximum * 2 + 1 : 0) });
  }
  candidates.sort((a, b) => b.score - a.score || documentOrder(a.doc, b.doc) || a.entity.url.localeCompare(b.entity.url));
  await checkpointHistoryWork(control);
  return candidates.slice(0, args.limit ?? 10).map(({ entity, doc, score, direct }) => ({
    repository: snapshot.repository, number: entity.number, kind: entity.kind, state: entity.state,
    title: entity.title, url: entity.url, documentUrl: doc.documentUrl, documentKind: doc.documentKind,
    author: doc.author, createdAt: doc.createdAt, updatedAt: doc.updatedAt, timestampProvenance: doc.timestampProvenance,
    reviewState: doc.reviewState, excerpt: direct ? doc.body.slice(0, 800) : historyExcerpt(doc.body, args.query), score,
    mergeCommitSha: entity.mergeCommitSha, linkedIssues: entity.linkedIssues, commits: entity.commits, files: entity.files,
    fileReferencesComplete: entity.fileReferencesComplete, totalChangedFiles: entity.totalChangedFiles, commitReferenceScope: "linked" as const,
  }));
}
