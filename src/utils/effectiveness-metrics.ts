import type { HostMode } from "../config/host.js";

export const EFFECTIVENESS_METRICS_SCHEMA_VERSION = 3 as const;
export const MAX_EFFECTIVENESS_COUNTER = 1_000_000_000;

export const EFFECTIVENESS_TOOL_ROUTES = [
  "context-conceptual",
  "context-definition",
  "context-path",
  "context-direct-edge",
  "peek",
  "search",
  "other",
] as const;
export const EFFECTIVENESS_HOST_MODES = [
  "opencode",
  "codex",
  "claude",
  "pi",
  "jcode",
  "other",
] as const;
export const EFFECTIVENESS_OUTCOMES = ["success", "no-result", "error"] as const;
export const EFFECTIVENESS_BOOLEAN_BUCKETS = ["no", "yes"] as const;
export const EFFECTIVENESS_RESULT_COUNT_BUCKETS = ["0", "1", "2-5", "6-10", "11-20", "21+"] as const;
export const EFFECTIVENESS_LATENCY_BUCKETS = ["<10ms", "10-49ms", "50-199ms", "200-999ms", "1s+"] as const;
export const EFFECTIVENESS_TOKEN_BUDGET_BUCKETS = [
  "none",
  "1-255",
  "256-511",
  "512-1199",
  "1200-1999",
  "2000-4000",
  "4001+",
] as const;
export const EFFECTIVENESS_RETURNED_TOKEN_BUCKETS = [
  "0",
  "1-127",
  "128-255",
  "256-511",
  "512-1199",
  "1200-1999",
  "2000-3999",
  "4000+",
] as const;
export const EFFECTIVENESS_SCOPE_RELAXATION_BUCKETS = ["none", "directory", "file-type", "both"] as const;

export type EffectivenessToolRoute = typeof EFFECTIVENESS_TOOL_ROUTES[number];
export type EffectivenessHostMode = typeof EFFECTIVENESS_HOST_MODES[number];
export type EffectivenessOutcome = typeof EFFECTIVENESS_OUTCOMES[number];
export type EffectivenessScopeRelaxation = typeof EFFECTIVENESS_SCOPE_RELAXATION_BUCKETS[number];

type CounterMap<T extends readonly string[]> = Record<T[number], number>;
type RouteHistogram<T extends readonly string[]> = Record<EffectivenessToolRoute, CounterMap<T>>;

export interface EffectivenessMetricEvent {
  route: EffectivenessToolRoute;
  host: HostMode;
  outcome: EffectivenessOutcome;
  recoveryUsed?: boolean;
  resultCount?: number;
  latencyMs?: number;
  tokenBudget?: number;
  returnedTokenEstimate?: number;
  exactHandoffEmitted?: boolean;
  scopeRelaxation?: EffectivenessScopeRelaxation;
}

export interface EffectivenessMetricsSnapshot {
  schemaVersion: typeof EFFECTIVENESS_METRICS_SCHEMA_VERSION;
  retention: {
    storage: "memory-only";
    lifetime: "process";
    reset: "index_metrics-reset-or-process-exit";
    maxCounterValue: number;
    dimensions: "bounded-route-and-bucketed-performance-only";
  };
  totalCalls: number;
  toolRoute: CounterMap<typeof EFFECTIVENESS_TOOL_ROUTES>;
  hostMode: CounterMap<typeof EFFECTIVENESS_HOST_MODES>;
  outcome: CounterMap<typeof EFFECTIVENESS_OUTCOMES>;
  recoveryUsed: CounterMap<typeof EFFECTIVENESS_BOOLEAN_BUCKETS>;
  resultCount: CounterMap<typeof EFFECTIVENESS_RESULT_COUNT_BUCKETS>;
  latency: CounterMap<typeof EFFECTIVENESS_LATENCY_BUCKETS>;
  tokenBudget: CounterMap<typeof EFFECTIVENESS_TOKEN_BUDGET_BUCKETS>;
  returnedTokenEstimate: CounterMap<typeof EFFECTIVENESS_RETURNED_TOKEN_BUCKETS>;
  exactHandoffEmitted: CounterMap<typeof EFFECTIVENESS_BOOLEAN_BUCKETS>;
  scopeRelaxation: CounterMap<typeof EFFECTIVENESS_SCOPE_RELAXATION_BUCKETS>;

  routeOutcome: RouteHistogram<typeof EFFECTIVENESS_OUTCOMES>;
  routeLatency: RouteHistogram<typeof EFFECTIVENESS_LATENCY_BUCKETS>;
  routeResultCount: RouteHistogram<typeof EFFECTIVENESS_RESULT_COUNT_BUCKETS>;
  routeReturnedTokenEstimate: RouteHistogram<typeof EFFECTIVENESS_RETURNED_TOKEN_BUCKETS>;
}

function emptyCounterMap<T extends readonly string[]>(values: T): CounterMap<T> {
  return Object.fromEntries(values.map((value) => [value, 0])) as CounterMap<T>;
}

function emptyRouteCounterMap<T extends readonly string[]>(
  routes: typeof EFFECTIVENESS_TOOL_ROUTES,
  values: T,
): RouteHistogram<T> {
  return Object.fromEntries(routes.map((route) => [route, emptyCounterMap(values)])) as RouteHistogram<T>;
}

function boundedNumber(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function resultCountBucket(value: number | undefined): typeof EFFECTIVENESS_RESULT_COUNT_BUCKETS[number] {
  const count = boundedNumber(value);
  if (count === 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2-5";
  if (count <= 10) return "6-10";
  if (count <= 20) return "11-20";
  return "21+";
}

function latencyBucket(value: number | undefined): typeof EFFECTIVENESS_LATENCY_BUCKETS[number] {
  const latencyMs = boundedNumber(value);
  if (latencyMs < 10) return "<10ms";
  if (latencyMs < 50) return "10-49ms";
  if (latencyMs < 200) return "50-199ms";
  if (latencyMs < 1000) return "200-999ms";
  return "1s+";
}

function tokenBudgetBucket(value: number | undefined): typeof EFFECTIVENESS_TOKEN_BUDGET_BUCKETS[number] {
  if (value === undefined || !Number.isFinite(value)) return "none";
  const budget = boundedNumber(value);
  if (budget <= 255) return "1-255";
  if (budget <= 511) return "256-511";
  if (budget <= 1199) return "512-1199";
  if (budget <= 1999) return "1200-1999";
  if (budget <= 4000) return "2000-4000";
  return "4001+";
}

function returnedTokenBucket(value: number | undefined): typeof EFFECTIVENESS_RETURNED_TOKEN_BUCKETS[number] {
  const tokens = boundedNumber(value);
  if (tokens === 0) return "0";
  if (tokens <= 127) return "1-127";
  if (tokens <= 255) return "128-255";
  if (tokens <= 511) return "256-511";
  if (tokens <= 1199) return "512-1199";
  if (tokens <= 1999) return "1200-1999";
  if (tokens <= 3999) return "2000-3999";
  return "4000+";
}

function allowedValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? value as T[number]
    : fallback;
}

function cloneCounterMap<T extends string>(counters: Record<T, number>): Record<T, number> {
  return { ...counters };
}

function cloneRouteCounterMap<T extends readonly string[]>(
  counters: RouteHistogram<T>,
): RouteHistogram<T> {
  return Object.fromEntries(
    EFFECTIVENESS_TOOL_ROUTES.map((route) => [route, cloneCounterMap(counters[route])]),
  ) as RouteHistogram<T>;
}

export class EffectivenessMetrics {
  private snapshot: EffectivenessMetricsSnapshot;

  constructor(private readonly counterCap = MAX_EFFECTIVENESS_COUNTER) {
    this.snapshot = this.createEmptySnapshot();
  }

  private createEmptySnapshot(): EffectivenessMetricsSnapshot {
    return {
      schemaVersion: EFFECTIVENESS_METRICS_SCHEMA_VERSION,
      retention: {
        storage: "memory-only",
        lifetime: "process",
        reset: "index_metrics-reset-or-process-exit",
        maxCounterValue: this.counterCap,
        dimensions: "bounded-route-and-bucketed-performance-only",
      },
      totalCalls: 0,
      toolRoute: emptyCounterMap(EFFECTIVENESS_TOOL_ROUTES),
      hostMode: emptyCounterMap(EFFECTIVENESS_HOST_MODES),
      outcome: emptyCounterMap(EFFECTIVENESS_OUTCOMES),
      recoveryUsed: emptyCounterMap(EFFECTIVENESS_BOOLEAN_BUCKETS),
      resultCount: emptyCounterMap(EFFECTIVENESS_RESULT_COUNT_BUCKETS),
      latency: emptyCounterMap(EFFECTIVENESS_LATENCY_BUCKETS),
      tokenBudget: emptyCounterMap(EFFECTIVENESS_TOKEN_BUDGET_BUCKETS),
      returnedTokenEstimate: emptyCounterMap(EFFECTIVENESS_RETURNED_TOKEN_BUCKETS),
      exactHandoffEmitted: emptyCounterMap(EFFECTIVENESS_BOOLEAN_BUCKETS),
      scopeRelaxation: emptyCounterMap(EFFECTIVENESS_SCOPE_RELAXATION_BUCKETS),
      routeOutcome: emptyRouteCounterMap(EFFECTIVENESS_TOOL_ROUTES, EFFECTIVENESS_OUTCOMES),
      routeLatency: emptyRouteCounterMap(EFFECTIVENESS_TOOL_ROUTES, EFFECTIVENESS_LATENCY_BUCKETS),
      routeResultCount: emptyRouteCounterMap(EFFECTIVENESS_TOOL_ROUTES, EFFECTIVENESS_RESULT_COUNT_BUCKETS),
      routeReturnedTokenEstimate: emptyRouteCounterMap(
        EFFECTIVENESS_TOOL_ROUTES,
        EFFECTIVENESS_RETURNED_TOKEN_BUCKETS,
      ),
    };
  }

  private increment<T extends string>(counters: Record<T, number>, key: T): void {
    counters[key] = Math.min(this.counterCap, counters[key] + 1);
  }

  record(event: EffectivenessMetricEvent): void {
    const route = allowedValue(event.route, EFFECTIVENESS_TOOL_ROUTES, "other");
    const host = allowedValue(event.host, EFFECTIVENESS_HOST_MODES, "other");
    const outcome = allowedValue(event.outcome, EFFECTIVENESS_OUTCOMES, "error");
    const scopeRelaxation = allowedValue(
      event.scopeRelaxation,
      EFFECTIVENESS_SCOPE_RELAXATION_BUCKETS,
      "none",
    );
    const recoveryUsed = event.recoveryUsed === true ? "yes" : "no";
    const exactHandoffEmitted = event.exactHandoffEmitted === true ? "yes" : "no";

    this.snapshot.totalCalls = Math.min(this.counterCap, this.snapshot.totalCalls + 1);
    this.increment(this.snapshot.toolRoute, route);
    this.increment(this.snapshot.hostMode, host);
    this.increment(this.snapshot.outcome, outcome);
    this.increment(this.snapshot.recoveryUsed, recoveryUsed);
    const resultCountBucketValue = resultCountBucket(event.resultCount);
    const latencyBucketValue = latencyBucket(event.latencyMs);
    const returnedTokenBucketValue = returnedTokenBucket(event.returnedTokenEstimate);

    this.increment(this.snapshot.resultCount, resultCountBucketValue);
    this.increment(this.snapshot.latency, latencyBucketValue);
    this.increment(this.snapshot.tokenBudget, tokenBudgetBucket(event.tokenBudget));
    this.increment(this.snapshot.returnedTokenEstimate, returnedTokenBucketValue);
    this.increment(this.snapshot.exactHandoffEmitted, exactHandoffEmitted);
    this.increment(this.snapshot.scopeRelaxation, scopeRelaxation);

    this.increment(this.snapshot.routeOutcome[route], outcome);
    this.increment(this.snapshot.routeLatency[route], latencyBucketValue);
    this.increment(this.snapshot.routeResultCount[route], resultCountBucketValue);
    this.increment(this.snapshot.routeReturnedTokenEstimate[route], returnedTokenBucketValue);
  }

  getSnapshot(): EffectivenessMetricsSnapshot {
    return {
      ...this.snapshot,
      retention: { ...this.snapshot.retention },
      toolRoute: cloneCounterMap(this.snapshot.toolRoute),
      hostMode: cloneCounterMap(this.snapshot.hostMode),
      outcome: cloneCounterMap(this.snapshot.outcome),
      recoveryUsed: cloneCounterMap(this.snapshot.recoveryUsed),
      resultCount: cloneCounterMap(this.snapshot.resultCount),
      latency: cloneCounterMap(this.snapshot.latency),
      tokenBudget: cloneCounterMap(this.snapshot.tokenBudget),
      returnedTokenEstimate: cloneCounterMap(this.snapshot.returnedTokenEstimate),
      exactHandoffEmitted: cloneCounterMap(this.snapshot.exactHandoffEmitted),
      scopeRelaxation: cloneCounterMap(this.snapshot.scopeRelaxation),
      routeOutcome: cloneRouteCounterMap(this.snapshot.routeOutcome),
      routeLatency: cloneRouteCounterMap(this.snapshot.routeLatency),
      routeResultCount: cloneRouteCounterMap(this.snapshot.routeResultCount),
      routeReturnedTokenEstimate: cloneRouteCounterMap(this.snapshot.routeReturnedTokenEstimate),
    };
  }

  reset(): void {
    this.snapshot = this.createEmptySnapshot();
  }
}

let processCollector: EffectivenessMetrics | undefined;

export function recordProcessEffectiveness(event: EffectivenessMetricEvent): void {
  (processCollector ??= new EffectivenessMetrics()).record(event);
}

export function getProcessEffectivenessMetrics(): EffectivenessMetricsSnapshot {
  return processCollector?.getSnapshot() ?? new EffectivenessMetrics().getSnapshot();
}

export function resetProcessEffectivenessMetrics(): void {
  processCollector = undefined;
}

export function isProcessEffectivenessCollectorAllocated(): boolean {
  return processCollector !== undefined;
}

export function formatEffectivenessMetrics(snapshot: EffectivenessMetricsSnapshot): string {
  const formatCounters = (counters: Record<string, number>): string => Object.entries(counters)
    .map(([bucket, count]) => `${bucket}=${count}`)
    .join(", ");
  const formatRouteCounters = <T extends readonly string[]>(counters: RouteHistogram<T>): string =>
    EFFECTIVENESS_TOOL_ROUTES
      .map((route) => `${route} => ${formatCounters(counters[route])}`)
      .join("; ");
  const lines = [
    `Privacy-safe effectiveness (schema v${snapshot.schemaVersion}):`,
    `  Retention: ${snapshot.retention.storage}, ${snapshot.retention.lifetime}-lifetime; reset with index_metrics(reset=true) or process exit`,
    `  Dimensions: ${snapshot.retention.dimensions}`,
    `  Counter cap: ${snapshot.retention.maxCounterValue.toLocaleString()}`,
    `  Total tool calls: ${snapshot.totalCalls}`,
    `  Tool route: ${formatCounters(snapshot.toolRoute)}`,
    `  Host mode: ${formatCounters(snapshot.hostMode)}`,
    `  Outcome: ${formatCounters(snapshot.outcome)}`,
    `  Recovery used: ${formatCounters(snapshot.recoveryUsed)}`,
    `  Result-count bucket: ${formatCounters(snapshot.resultCount)}`,
    `  Latency bucket: ${formatCounters(snapshot.latency)}`,
    `  Token-budget bucket: ${formatCounters(snapshot.tokenBudget)}`,
    `  Returned-token estimate: ${formatCounters(snapshot.returnedTokenEstimate)}`,
    `  Route outcome buckets: ${formatRouteCounters(snapshot.routeOutcome)}`,
    `  Route latency buckets: ${formatRouteCounters(snapshot.routeLatency)}`,
    `  Route result-count buckets: ${formatRouteCounters(snapshot.routeResultCount)}`,
    `  Route returned-token buckets: ${formatRouteCounters(snapshot.routeReturnedTokenEstimate)}`,
    `  Exact handoff emitted: ${formatCounters(snapshot.exactHandoffEmitted)}`,
    `  Scope relaxation: ${formatCounters(snapshot.scopeRelaxation)}`,
    "  Privacy: no queries, response text, source, symbols, paths, repository names, user identity, or stable identifiers are retained.",
  ];
  return lines.join("\n");
}
