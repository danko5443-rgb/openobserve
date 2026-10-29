// Copyright 2026 OpenObserve Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

/**
 * LLM Insights panel definitions.
 *
 * Each entry describes one chart on the LLM Insights dashboard. The shape is
 * intentionally JSON-serializable so that, in a future iteration, these can be
 * persisted to and loaded from a database (organization-level dashboard
 * configuration) without changing the renderer.
 *
 * SQL query templates support these placeholders:
 *   {{stream}}    — stream name, quoted at substitution time
 *   {{startTime}} — epoch microseconds (current window start)
 *   {{endTime}}   — epoch microseconds (current window end)
 *   {{interval}}  — auto-selected histogram bucket width string ("5 minutes" etc.)
 */

import { type I18nKey } from "@/types/i18n";
import type { AiAlertKind } from "@/utils/alerts/prefill/fromAi";
import {
  LLM_LATENCY_SERIES_COLORS,
  LLM_ERRORS_COLOR,
  LLM_RECOVERED_COLOR,
  LLM_SPANS_COLOR,
  LLM_TOKENS_COLOR,
} from "@/utils/dashboard/colorPalette";
import {
  TRACE_ERROR_SPANS_SQL,
  TRACE_FAILED_SQL,
  TRACE_OUTCOME_SPANS_SQL,
} from "../llmTraceOutcome";

export type LLMPanelType = "stacked-area" | "stacked-bar" | "horizontal-bar" | "table";

export type LLMTableColumnFormat =
  "time" | "service-chip" | "error" | "cost" | "view-link" | "text";

export interface LLMTableColumn {
  /** Hit field used as the value source. May be omitted for "view-link". */
  field?: string;
  /**
   * Header label, translated at the render site (this module is a plain config,
   * so a resolved string would not follow the locale). Omit for no header.
   */
  labelKey?: I18nKey;
  format?: LLMTableColumnFormat;
  align?: "left" | "right";
}

export type LLMValueFormat = "cost" | "latency-ms";

export interface LLMPanelQuery {
  /** SQL with {{stream}}, {{startTime}}, {{endTime}}, {{interval}} placeholders */
  sql: string;
  /** Hit field used for the time axis (bucket timestamp). */
  timeField?: string;
  /** Hit field used to break out series or as a category axis (e.g. "model"). */
  seriesField?: string;
  /** Hit field used for the y-value (or bar length). */
  valueField?: string;
  /**
   * i18n KEY for the legend label used when seriesField is not set. Resolved by
   * `buildLLMPanelSchema` — see {@link LLMTableColumn.labelKey} for why this
   * module stores a key rather than a translated string.
   */
  seriesLabelKey?: I18nKey;
  /**
   * Hint to the renderer for axis / tooltip formatting.
   * - "cost": prefix with `$` and use 2-decimal precision in tooltips.
   */
  valueFormat?: LLMValueFormat;
}

export interface LLMPanelLayout {
  /** Number of grid columns this panel spans (1 or 2 in a 2-col layout). */
  colSpan: 1 | 2;
}

export interface LLMPanelDef {
  id: string;
  /**
   * i18n KEY for the panel heading — see {@link LLMTableColumn.labelKey} for why
   * these are keys and not text. Resolved by LLMSchemaPanel / LLMErrorTable.
   */
  titleKey: I18nKey;
  /** i18n KEY for the panel sub-heading. */
  subtitleKey?: I18nKey;
  type: LLMPanelType;
  layout: LLMPanelLayout;
  query: LLMPanelQuery;
  /** Optional single color for monochrome panels (e.g. horizontal-bar). */
  color?: string;
  /** Optional row cap for horizontal-bar panels (top N). */
  limit?: number;
  /**
   * For grouped-bar panels: the value columns to render as side-by-side bars
   * per category (e.g. p50/p90/p95/p99 per model). Each maps a hit field to a
   * legend label and bar color. When set, these become the chart's Y-axis
   * series instead of `query.valueField`.
   */
  series?: Array<{ field: string; label: string; color: string }>;
  /** Fixed colors for breakdown values the SQL labels with `{{t:key}}`. */
  seriesColors?: Array<{ labelKey: I18nKey; color: string }>;
  /** Column definitions for "table" panels. */
  columns?: LLMTableColumn[];
  /** i18n key for the message shown when the panel has no data (overrides "No data"). */
  emptyStateKey?: I18nKey;
  /**
   * Click-through (AIO-26): what a clicked point selects. `seriesSql` is the
   * expression the series/category value was computed from (a trace matches
   * when any span has that value); `outcome` maps the clicked value series
   * (`failed` / `recovered`) to the trace outcome.
   */
  drill?: { seriesSql?: string; outcome?: true };
  /** "Create alert" from this panel (AIO-20): the pack template it maps to. */
  alert?: AiAlertKind;
}

/** The series expressions a drill can select on, shared with the panels. */
export const MODEL_SERIES_SQL = "gen_ai_response_model";
const KIND_SERIES_SQL = "LOWER(COALESCE(gen_ai_operation_name, 'span'))";
const SERVICE_SERIES_SQL = "COALESCE(service_name, 'unknown')";

// Time-range pruning is handled by the search engine via the start_time /
// end_time fields on the request payload — no need to repeat it in WHERE.
//
// LLM Insights panels reference only the new OTEL gen_ai_* semantic-convention
// fields. DataFusion validates column references at parse time, so referencing
// a legacy column that doesn't exist on a given stream's schema would fail
// the entire query — staying on the standard fields keeps panels portable.
const baseFilter = `gen_ai_operation_name IS NOT NULL`;

// Centralised column names so a future rename only touches this file.
const COST_FIELD = `gen_ai_usage_cost`;
const TOKENS_FIELD = `gen_ai_usage_total_tokens`;
const MODEL_FIELD = `gen_ai_response_model`;
const OBSERVATION_TYPE_FIELD = `gen_ai_operation_name`;

// Scope for every panel that groups by model. `baseFilter` alone admits ALL
// gen_ai spans — including `execute_tool` children and evaluator spans, which
// legitimately carry no model (the OTEL gen_ai conventions only put a model on
// generation/embedding operations). Bucketing those under a synthetic
// "unknown" model made them dominate the per-model panels: an agent emits one
// generation span per turn but a tool span per tool call, so "unknown" read as
// ~9x the real model and its token bar was always a flat zero.
const modelScopedFilter = `${baseFilter} AND ${MODEL_FIELD} IS NOT NULL`;

// Operations that are LLM calls (mirrors GENERATION_GEN_AI_OPERATIONS in
// src/config/src/meta/traces.rs). Agent/workflow spans repeat their children's
// usage, so summing every span double-counts tokens and cost.
const GENERATION_GEN_AI_OPERATIONS = ["chat", "text_completion", "generate_content", "embeddings"];

/**
 * SUM of a usage column over LLM-call spans only — the same rule the backend
 * applies to trace/session totals. A span without an operation name counts.
 *
 * Every LLM Insights query already references `gen_ai_operation_name`, so a
 * stream without that column fails at parse time and lands on the "no LLM
 * fields" empty state; there is no plain-SUM fallback to pick here.
 *
 * @example
 *   llmCallUsageSum("gen_ai_usage_cost")
 *   // => SUM(CASE WHEN (gen_ai_operation_name IS NULL OR gen_ai_operation_name IN ('chat', ...)) THEN gen_ai_usage_cost ELSE 0 END)
 */
export function llmCallUsageSum(column: string): string {
  const ops = GENERATION_GEN_AI_OPERATIONS.map((op) => `'${op}'`).join(", ");
  const predicate = `(${OBSERVATION_TYPE_FIELD} IS NULL OR ${OBSERVATION_TYPE_FIELD} IN (${ops}))`;
  return `SUM(CASE WHEN ${predicate} THEN ${column} ELSE 0 END)`;
}

export const LLM_INSIGHTS_PANELS: LLMPanelDef[] = [
  {
    id: "cost-trend",
    titleKey: "aiObservability.panels.costTrend.title",
    subtitleKey: "aiObservability.panels.costTrend.subtitle",
    type: "stacked-bar",
    layout: { colSpan: 1 },
    drill: { seriesSql: MODEL_SERIES_SQL },
    alert: "cost",
    query: {
      // Cost field populated by the backend extractor from
      // gen_ai.usage.cost / Langfuse cost_details — same source the Traces
      // tab uses.
      sql: `
        SELECT
          histogram(_timestamp, '{{interval}}') as ts,
          ${MODEL_FIELD} as model,
          COALESCE(${llmCallUsageSum(COST_FIELD)}, 0) as cost
        FROM {{stream}}
        WHERE ${modelScopedFilter}
        GROUP BY ts, ${MODEL_FIELD}
        ORDER BY ts
      `,
      timeField: "ts",
      seriesField: "model",
      valueField: "cost",
      valueFormat: "cost",
    },
  },
  {
    id: "token-trend",
    titleKey: "aiObservability.panels.tokenTrend.title",
    subtitleKey: "aiObservability.panels.tokenTrend.subtitle",
    type: "stacked-bar",
    layout: { colSpan: 1 },
    drill: { seriesSql: MODEL_SERIES_SQL },
    query: {
      sql: `
        SELECT
          histogram(_timestamp, '{{interval}}') as ts,
          ${MODEL_FIELD} as model,
          COALESCE(${llmCallUsageSum(TOKENS_FIELD)}, 0) as tokens
        FROM {{stream}}
        WHERE ${modelScopedFilter}
        GROUP BY ts, ${MODEL_FIELD}
        ORDER BY ts
      `,
      timeField: "ts",
      seriesField: "model",
      valueField: "tokens",
    },
  },
  {
    id: "span-trend",
    titleKey: "aiObservability.panels.spanTrend.title",
    subtitleKey: "aiObservability.panels.spanTrend.subtitle",
    type: "stacked-bar",
    layout: { colSpan: 1 },
    drill: { seriesSql: KIND_SERIES_SQL },
    query: {
      sql: `
        SELECT
          histogram(_timestamp, '{{interval}}') as ts,
          ${KIND_SERIES_SQL} as kind,
          COUNT(*) as count
        FROM {{stream}}
        WHERE ${baseFilter}
        GROUP BY ts, kind
        ORDER BY ts
      `,
      timeField: "ts",
      seriesField: "kind",
      valueField: "count",
    },
  },
  {
    id: "latency-by-model",
    titleKey: "aiObservability.panels.latencyByModel.title",
    subtitleKey: "aiObservability.panels.latencyByModel.subtitle",
    type: "horizontal-bar",
    layout: { colSpan: 1 },
    limit: 8,
    drill: { seriesSql: MODEL_SERIES_SQL },
    query: {
      // One row per model with its latency percentiles (ms). Scoped to LLM
      // calls so fast tool/child spans don't drag the tail down. Ordered by
      // p95 so the slowest models surface first; the four percentile columns
      // render as grouped bars per model (see `series`).
      sql: `
        SELECT
          ${MODEL_FIELD} as model,
          approx_percentile_cont(duration, 0.5)  / 1000.0 as p50_ms,
          approx_percentile_cont(duration, 0.9)  / 1000.0 as p90_ms,
          approx_percentile_cont(duration, 0.95) / 1000.0 as p95_ms,
          approx_percentile_cont(duration, 0.99) / 1000.0 as p99_ms
        FROM {{stream}}
        WHERE ${modelScopedFilter}
        GROUP BY ${MODEL_FIELD}
        ORDER BY p95_ms DESC
      `,
      seriesField: "model",
      valueFormat: "latency-ms",
    },
    // Severity escalation: slate (typical) → red (slow tail).
    series: [
      { field: "p50_ms", label: "p50", color: LLM_LATENCY_SERIES_COLORS.p50 },
      { field: "p90_ms", label: "p90", color: LLM_LATENCY_SERIES_COLORS.p90 },
      { field: "p95_ms", label: "p95", color: LLM_LATENCY_SERIES_COLORS.p95 },
      { field: "p99_ms", label: "p99", color: LLM_LATENCY_SERIES_COLORS.p99 },
    ],
  },
  {
    id: "traces-over-time",
    titleKey: "aiObservability.panels.tracesOverTime.title",
    subtitleKey: "aiObservability.panels.tracesOverTime.subtitle",
    type: "stacked-bar",
    layout: { colSpan: 1 },
    drill: { seriesSql: SERVICE_SERIES_SQL },
    query: {
      sql: `
        SELECT
          histogram(_timestamp, '{{interval}}') as ts,
          ${SERVICE_SERIES_SQL} as service,
          approx_distinct(trace_id) as count
        FROM {{stream}}
        WHERE ${baseFilter}
        GROUP BY ts, ${SERVICE_SERIES_SQL}
        ORDER BY ts
      `,
      timeField: "ts",
      seriesField: "service",
      valueField: "count",
    },
  },
  {
    id: "errors-over-time",
    titleKey: "aiObservability.panels.errorsOverTime.title",
    subtitleKey: "aiObservability.panels.errorsOverTime.subtitle",
    type: "stacked-bar",
    layout: { colSpan: 1 },
    drill: { outcome: true },
    alert: "failure_rate",
    query: {
      // Traces with an error, stacked by outcome (AIO-06), so a burst of
      // retried tool calls does not read as an outage. No baseFilter on the
      // spans: SDKs often put the failure on a deep child span with no
      // gen_ai_operation_name. The inner WHERE comes first, so the agent
      // predicate is spliced into the per-trace subquery. Each trace is bucketed
      // by its first span; the dashboards SQL check rejects `_timestamp` as an
      // alias, so it is `first_ts` and the histogram picks its own interval.
      // The outcome is a breakdown (that is what stacks), labelled in the
      // viewer's language through {{t:key}}.
      sql: `
        SELECT
          histogram(first_ts) as ts,
          CASE WHEN failed = 1 THEN '{{t:llmTraceOutcome.failed}}'
               ELSE '{{t:llmTraceOutcome.recovered}}' END as outcome,
          COUNT(*) as count
        FROM (
          SELECT trace_id, MIN(_timestamp) as first_ts, ${TRACE_FAILED_SQL} as failed
          FROM {{stream}}
          WHERE ${TRACE_OUTCOME_SPANS_SQL}
          GROUP BY trace_id
          HAVING ${TRACE_ERROR_SPANS_SQL} > 0
        )
        GROUP BY ts, outcome
        ORDER BY ts
      `,
      timeField: "ts",
      seriesField: "outcome",
      valueField: "count",
    },
    seriesColors: [
      { labelKey: "llmTraceOutcome.failed", color: LLM_ERRORS_COLOR },
      { labelKey: "llmTraceOutcome.recovered", color: LLM_RECOVERED_COLOR },
    ],
  },
  {
    id: "spans-by-model",
    titleKey: "aiObservability.panels.spansByModel.title",
    subtitleKey: "aiObservability.panels.spansByModel.subtitle",
    type: "horizontal-bar",
    layout: { colSpan: 1 },
    color: LLM_SPANS_COLOR,
    limit: 10,
    drill: { seriesSql: MODEL_SERIES_SQL },
    query: {
      sql: `
        SELECT
          ${MODEL_FIELD} as model,
          COUNT(*) as count
        FROM {{stream}}
        WHERE ${modelScopedFilter}
        GROUP BY ${MODEL_FIELD}
        ORDER BY count DESC
      `,
      seriesField: "model",
      valueField: "count",
    },
  },
  {
    id: "tokens-by-model",
    titleKey: "aiObservability.panels.tokensByModel.title",
    subtitleKey: "aiObservability.panels.tokensByModel.subtitle",
    type: "horizontal-bar",
    layout: { colSpan: 1 },
    color: LLM_TOKENS_COLOR,
    limit: 10,
    drill: { seriesSql: MODEL_SERIES_SQL },
    query: {
      sql: `
        SELECT
          ${MODEL_FIELD} as model,
          COALESCE(${llmCallUsageSum(TOKENS_FIELD)}, 0) as tokens
        FROM {{stream}}
        WHERE ${modelScopedFilter}
        GROUP BY ${MODEL_FIELD}
        ORDER BY tokens DESC
      `,
      seriesField: "model",
      valueField: "tokens",
    },
  },
  {
    id: "recent-errors",
    titleKey: "aiObservability.panels.recentErrors.title",
    subtitleKey: "aiObservability.panels.recentErrors.subtitle",
    type: "table",
    layout: { colSpan: 2 },
    emptyStateKey: "traces.lLMErrorTable.noErrorsInRange",
    query: {
      // No baseFilter for the same reason as errors-over-time. Operation
      // label uses `operation_name` (the actual OO traces column) — `span_name`
      // does not exist in the schema and would fail at SQL parse time.
      //
      // Model/cost are not surfaced here: the failure usually lives on a deep
      // child span (e.g. `tool.<name>`) which doesn't carry those attributes.
      // The dedicated Cost / Tokens panels handle attribution.
      sql: `
        SELECT
          _timestamp,
          COALESCE(service_name, 'unknown') as service_name,
          COALESCE(operation_name, '—') as operation,
          trace_id
        FROM {{stream}}
        WHERE span_status = 'ERROR'
        ORDER BY _timestamp DESC
        LIMIT 10
      `,
    },
    columns: [
      { field: "_timestamp", labelKey: "traces.lLMErrorTable.time", format: "time" },
      { field: "service_name", labelKey: "traces.lLMErrorTable.service", format: "service-chip" },
      { field: "operation", labelKey: "traces.lLMErrorTable.operation", format: "error" },
      { field: "trace_id", labelKey: "traces.lLMErrorTable.traceId", format: "text" },
      { field: "trace_id", format: "view-link", align: "right" },
    ],
  },
];

/**
 * Substitute the standard placeholders in a SQL template with concrete values.
 *
 * Replaces (globally, all occurrences):
 *   {{stream}}     → `"streamName"` (always quoted — DataFusion treats unquoted
 *                                    identifiers as case-insensitive)
 *   {{startTime}}  → numeric microseconds, unquoted
 *   {{endTime}}    → numeric microseconds, unquoted
 *   {{interval}}   → bucket width string ("5 minutes", "1 hour", etc.) — used
 *                                    only inside `histogram(_timestamp, '…')`
 *
 * @example
 *   renderPanelSql(
 *     `SELECT histogram(_timestamp, '{{interval}}') FROM {{stream}}`,
 *     { stream: "default", startTime: 1700000000000000, endTime: 1700001000000000, interval: "1 minute" },
 *   )
 *   // => `SELECT histogram(_timestamp, '1 minute') FROM "default"`
 */
export function renderPanelSql(
  sql: string,
  ctx: {
    stream: string;
    startTime: number;
    endTime: number;
    interval: string;
    // Bare agent predicate (no leading AND). Empty = "All Agents".
    // Auto-spliced into each panel's WHERE (see below).
    agentFilter?: string;
  },
): string {
  const rendered = sql
    .replace(/\{\{stream\}\}/g, `"${ctx.stream}"`)
    .replace(/\{\{startTime\}\}/g, String(ctx.startTime))
    .replace(/\{\{endTime\}\}/g, String(ctx.endTime))
    .replace(/\{\{interval\}\}/g, ctx.interval);

  if (!ctx.agentFilter) return compactSql(rendered);

  // Append the agent predicate to the query's WHERE clause: splice ` AND
  // <agentFilter>` in just before the first GROUP BY / ORDER BY / LIMIT (or at
  // the end if none). A panel with a per-trace subquery puts that subquery's
  // WHERE first, so the predicate filters the spans, not the trace rows.
  const clause = ` AND ${ctx.agentFilter} `;
  const tail = rendered.match(/\b(group\s+by|order\s+by|limit)\b/i);
  if (tail && tail.index !== undefined) {
    return compactSql(rendered.slice(0, tail.index) + clause + rendered.slice(tail.index));
  }
  return compactSql(`${rendered}${clause}`);
}

/**
 * Collapse a multi-line SQL template into a single clean line.
 *
 * Flattens all runs of whitespace — newlines, tabs, leading indentation — down
 * to a single space and trims the ends. The result is byte-for-byte equivalent
 * SQL: none of these queries embed intentional multi-space string literals
 * (`'1 hour'`, `'5 minutes'` etc. keep their single space), so collapsing
 * whitespace can't alter any value.
 *
 * @example
 *   compactSql(`
 *     SELECT a
 *     FROM "default"
 *     WHERE b IS NOT NULL
 *   `)
 *   // => `SELECT a FROM "default" WHERE b IS NOT NULL`
 */
export function compactSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Choose a histogram bucket width that yields roughly 30 buckets across the
 * given window. Mirrors the helper used by KPI sparklines so panels remain
 * visually aligned (same bucket → same x-axis ticks → same tooltips).
 *
 * The breakpoints are chosen so that "Past 15 minutes" → 30 × 30s = 15 min,
 * "Past 1 hour" → 30 × ~2min = ~60 min (rounded to "1 minute" buckets), etc.
 *
 * @param durationMicros window duration in microseconds (endTime - startTime)
 * @returns interval string accepted by DataFusion's `histogram()` function
 *
 * Branch boundaries (strict `<` at each threshold):
 *   duration <  15 min  → "10 seconds"
 *   duration <   1 hr   → "1 minute"
 *   duration <   5 hr   → "5 minutes"
 *   duration <  15 hr   → "15 minutes"
 *   duration <  30 hr   → "30 minutes"
 *   duration <   7.5 d  → "1 hour"
 *   duration <  30 d    → "6 hours"
 *   else                → "1 day"
 *
 * @example
 *   pickInterval(10 * 60 * 1_000_000)     // "10 seconds" (10 min window)
 *   pickInterval(30 * 60 * 1_000_000)     // "1 minute"   (30 min window)
 *   pickInterval(3 * 3600 * 1_000_000)    // "5 minutes"  (3 hr window)
 *   pickInterval(12 * 3600 * 1_000_000)   // "15 minutes" (12 hr window)
 *   pickInterval(24 * 3600 * 1_000_000)   // "30 minutes" (24 hr window)
 *   pickInterval(5 * 86400 * 1_000_000)   // "1 hour"     (5 day window)
 *   pickInterval(14 * 86400 * 1_000_000)  // "6 hours"    (14 day window)
 *   pickInterval(60 * 86400 * 1_000_000)  // "1 day"      (60 day window)
 */
/**
 * Width (µs) of the buckets `histogram(_timestamp)` picks for a window, so a
 * clicked bar maps back to its time range. Mirrors `generate_histogram_interval`
 * in src/search/src/sql/visitor/histogram_interval.rs.
 */
export function autoHistogramBucketMicros(startMicros: number, endMicros: number): number {
  const HOUR = 3_600_000_000;
  const range = endMicros - startMicros;
  const steps: Array<[number, number]> = [
    [24 * 60 * HOUR, 24 * HOUR],
    [24 * 30 * HOUR, 12 * HOUR],
    [24 * 28 * HOUR, 6 * HOUR],
    [24 * 21 * HOUR, 3 * HOUR],
    [24 * 15 * HOUR, 2 * HOUR],
    [6 * HOUR, HOUR],
    [2 * HOUR, 60_000_000],
    [HOUR, 30_000_000],
    [HOUR / 2, 15_000_000],
    [10_000_000, 10_000_000],
  ];
  for (const [atLeast, width] of steps) if (range >= atLeast) return width;
  return 1_000_000;
}

export function pickInterval(durationMicros: number): string {
  // Target ~30 buckets across the window — the histogram() arg is chosen
  // by checking which "round" interval slot the per-bucket width falls in.
  const seconds = durationMicros / 1_000_000;
  const target = seconds / 30;
  if (target < 30) return "10 seconds";
  if (target < 120) return "1 minute";
  if (target < 600) return "5 minutes";
  if (target < 1800) return "15 minutes";
  if (target < 3600) return "30 minutes";
  if (target < 21_600) return "1 hour";
  if (target < 86_400) return "6 hours";
  return "1 day";
}
