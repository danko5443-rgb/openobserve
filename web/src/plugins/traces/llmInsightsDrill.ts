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
 * Insights that drill down (AIO-26): the page filters (model, user, prompt)
 * and the trace list behind a clicked chart point or KPI tile.
 *
 * Every filter is trace-level: a trace matches when any of its spans has the
 * value, so a model filter keeps the trace's tool and root spans too.
 */

import {
  TRACE_ERROR_SPANS_SQL,
  TRACE_FAILED_SQL,
  TRACE_ROOT_FAILED_SQL,
  TRACE_TURN_FAILED_SQL,
} from "./llmTraceOutcome";
import type { LLMPanelDef } from "./config/llmInsightsPanels";

/** A clicked chart point: the series value and, on a time axis, the bucket start (µs). */
export interface LLMPanelDrill {
  panel: LLMPanelDef;
  series: string | null;
  atMicros: number | null;
}

export interface InsightsFilters {
  model?: string;
  user?: string;
  /** `name@version`; the version part may be empty. */
  prompt?: string;
  /** Set from the Cost by panel (AIO-27). */
  tenant?: string;
  feature?: string;
}

/** The filters with a dropdown. */
export const INSIGHTS_FILTER_KEYS = ["model", "user", "prompt"] as const;
/** Every filter the URL carries: the dropdowns and the attribution chips. */
export const ALL_INSIGHTS_FILTER_KEYS = [...INSIGHTS_FILTER_KEYS, "tenant", "feature"] as const;

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Split a `name@version` prompt value at its last `@`. */
export function splitPrompt(value: string): { name: string; version: string } {
  const at = value.lastIndexOf("@");
  return at < 0
    ? { name: value, version: "" }
    : { name: value.slice(0, at), version: value.slice(at + 1) };
}

/** Bare predicate (no leading AND) for the set filters, or "" when none is set. */
export function insightsFilterSql(stream: string, filters: InsightsFilters): string {
  const spanPredicates: string[] = [];
  if (filters.model) spanPredicates.push(`gen_ai_response_model = ${quote(filters.model)}`);
  if (filters.user) spanPredicates.push(`user_id = ${quote(filters.user)}`);
  if (filters.tenant) spanPredicates.push(`tenant_id = ${quote(filters.tenant)}`);
  if (filters.feature) spanPredicates.push(`feature_name = ${quote(filters.feature)}`);
  if (filters.prompt) {
    const { name, version } = splitPrompt(filters.prompt);
    spanPredicates.push(
      version
        ? `(gen_ai_prompt_name = ${quote(name)} AND gen_ai_prompt_version = ${quote(version)})`
        : `gen_ai_prompt_name = ${quote(name)}`,
    );
  }
  return spanPredicates
    .map((p) => `trace_id IN (SELECT trace_id FROM "${stream}" WHERE ${p})`)
    .join(" AND ");
}

/** Values to offer for one filter: the most traced first. `scope` is a bare predicate. */
export function filterOptionsSql(
  stream: string,
  key: (typeof INSIGHTS_FILTER_KEYS)[number],
  scope: string,
): string {
  const where = scope ? ` AND ${scope}` : "";
  if (key === "prompt") {
    return (
      `SELECT gen_ai_prompt_name AS v, gen_ai_prompt_version AS version, approx_distinct(trace_id) AS n ` +
      `FROM "${stream}" WHERE gen_ai_prompt_name IS NOT NULL AND gen_ai_prompt_name != ''${where} ` +
      `GROUP BY gen_ai_prompt_name, gen_ai_prompt_version ORDER BY n DESC LIMIT 100`
    );
  }
  const col = key === "model" ? "gen_ai_response_model" : "user_id";
  return (
    `SELECT ${col} AS v, approx_distinct(trace_id) AS n FROM "${stream}" ` +
    `WHERE ${col} IS NOT NULL AND ${col} != ''${where} GROUP BY ${col} ORDER BY n DESC LIMIT 100`
  );
}

/** What a click selected: a series value, an outcome, or both, in a time range (µs). */
export interface TraceListSelection {
  startTime: number;
  endTime: number;
  /** Expression the clicked series was computed from, and its value. */
  seriesSql?: string;
  seriesValue?: string;
  outcome?: "failed" | "recovered";
}

export const TRACE_LIST_LIMIT = 50;

/** The newest matching traces, one row each, with their outcome. */
export function traceListSql(stream: string, sel: TraceListSelection, scope: string): string {
  const having: string[] = [];
  if (sel.seriesSql && sel.seriesValue !== undefined) {
    having.push(
      `max(CASE WHEN ${sel.seriesSql} = ${quote(sel.seriesValue)} THEN 1 ELSE 0 END) = 1`,
    );
  }
  if (sel.outcome === "failed") having.push(`${TRACE_FAILED_SQL} = 1`);
  if (sel.outcome === "recovered") {
    having.push(`${TRACE_FAILED_SQL} = 0 AND ${TRACE_ERROR_SPANS_SQL} > 0`);
  }
  return [
    "SELECT trace_id, MIN(_timestamp) AS ts, MAX(end_time) - MIN(start_time) AS duration_ns,",
    "FIRST_VALUE(gen_ai_input_messages ORDER BY start_time ASC)",
    "FILTER (WHERE gen_ai_input_messages IS NOT NULL AND gen_ai_input_messages != '') AS input,",
    "MAX(gen_ai_response_model) AS model, COALESCE(SUM(gen_ai_usage_cost), 0) AS cost,",
    `${TRACE_ROOT_FAILED_SQL} AS failed_root, ${TRACE_TURN_FAILED_SQL} AS failed_turn,`,
    `${TRACE_ERROR_SPANS_SQL} AS error_spans`,
    `FROM "${stream}"`,
    scope ? `WHERE ${scope}` : "",
    "GROUP BY trace_id",
    having.length ? `HAVING ${having.join(" AND ")}` : "",
    `ORDER BY ts DESC LIMIT ${TRACE_LIST_LIMIT}`,
  ]
    .filter(Boolean)
    .join(" ");
}
