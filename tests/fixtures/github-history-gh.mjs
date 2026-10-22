#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const state = JSON.parse(readFileSync(process.env.HISTORY_FIXTURE_STATE, "utf8"));
const args = process.argv.slice(2);
const field = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const endpoint = args.find((arg) => arg.startsWith("repos/"));
const query = field("query");
const capability = query?.includes("viewer{");
const key = endpoint ?? (capability ? "graphql:access" : `graphql:${query?.includes("pullRequests(") ? "pullRequests" : "issues"}:${field("after") ?? ""}`);
appendFileSync(process.env.HISTORY_FIXTURE_REQUESTS, `${key}\n`, { mode: 0o600 });
if (state.revoked) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
if (state.fail && key.includes(state.fail)) { console.error("gh: API rate limit exceeded (HTTP 403)"); process.exit(1); }
if (state.metadataOnly && (query || endpoint !== `repos/${state.repository}`)) {
  if (query) console.log(JSON.stringify({ data: { repository: null }, errors: [{ type: "FORBIDDEN" }] }));
  console.error("gh: Resource not accessible with current repository permissions");
  process.exit(1);
}
if (capability) {
  const count = readFileSync(process.env.HISTORY_FIXTURE_REQUESTS, "utf8").split("\n").filter((line) => line === "graphql:access").length;
  const errors = state.failAccessAt === count ? [{ type: "RATE_LIMITED" }] : state.graphqlErrors;
  const nodes = (pr) => state.entities.filter((entity) => Boolean(entity.pull_request) === pr).slice(0, 1).map((entity) => ({ id: String(entity.id) }));
  const data = { viewer: { id: state.principalId ?? "viewer-1" }, repository: { databaseId: state.repositoryId ?? 42, nameWithOwner: state.repository, issues: { nodes: nodes(false) }, pullRequests: { nodes: nodes(true) } } };
  console.log(JSON.stringify({ data, ...(errors ? { errors } : {}) }));
  process.exit(state.failAccessAt === count ? 1 : state.graphqlExit ?? 0);
}
if (query) {
  const kind = query.includes("pullRequests(") ? "pullRequests" : "issues";
  const values = state.entities.filter((entity) => Boolean(entity.pull_request) === (kind === "pullRequests"));
  values.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.number - b.number);
  const offset = Number(field("after") ?? 0);
  const size = state.pageSize ?? 100;
  const nodes = values.slice(offset, offset + size).map((entity) => ({ number: entity.number, createdAt: entity.created_at }));
  const data = { repository: { [kind]: { nodes, pageInfo: { endCursor: String(offset + nodes.length), hasNextPage: offset + nodes.length < values.length } } } };
  console.log(JSON.stringify({ data, ...(state.graphqlErrors ? { errors: state.graphqlErrors } : {}) }));
  if (state.graphqlExit) console.error("gh: GraphQL query failed");
  process.exit(state.graphqlExit ?? 0);
}
if (endpoint === `repos/${state.repository}`) { console.log(JSON.stringify({ id: state.repositoryId ?? 42, full_name: state.repository })); process.exit(0); }
const number = Number(/\/(?:issues|pulls)\/(\d+)/.exec(endpoint)?.[1]);
const entity = state.entities.find((item) => item.number === number);
if (!entity) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
const collection = /\/(comments|reviews|timeline|files|commits)\?/.exec(endpoint)?.[1];
if (collection) {
  const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"));
  const items = collection === "comments" ? endpoint.includes("/pulls/") ? entity.reviewComments ?? [] : entity.comments ?? [] : entity[collection] ?? [];
  console.log(JSON.stringify(items.slice((page - 1) * 100, page * 100)));
} else if (endpoint.includes("/pulls/")) {
  console.log(JSON.stringify({ ...entity, changed_files: entity.files?.length ?? 0, commits: entity.commits?.length ?? 0 }));
} else {
  const { comments, reviews, reviewComments, timeline, files, commits, ...issue } = entity;
  console.log(JSON.stringify(issue));
}
