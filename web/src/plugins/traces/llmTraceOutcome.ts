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
 * What makes an LLM trace "failed" (AIO-06, rule AIO-D3).
 *
 * A trace fails when its root span, or its last LLM or agent turn, ends in
 * error. A trace whose only errors are on spans the agent got past (typically a
 * tool call it retried) "recovered": the user saw an answer. Every AI page
 * counts failures with these fragments, so Insights, Sessions and the alert
 * pack agree. The session rule (a session fails when any of its turns failed)
 * lives with the session query in src/api/search/src/traces/session.rs.
 */

export const ROOT_SPAN_SQL = "(reference_parent_span_id IS NULL OR reference_parent_span_id = '')";

// The root span is excluded: it always ends last, so it would hide a failed final turn.
const TURN_SPAN_SQL = `gen_ai_operation_name IN ('chat', 'text_completion', 'generate_content', 'invoke_agent') AND NOT ${ROOT_SPAN_SQL}`;

/** 1 when the root span of the grouped trace errored. Aggregate: use inside `GROUP BY trace_id`. */
export const TRACE_ROOT_FAILED_SQL = `max(CASE WHEN ${ROOT_SPAN_SQL} AND span_status = 'ERROR' THEN 1 ELSE 0 END)`;

/** 1 when the latest-ending LLM or agent turn of the grouped trace errored. */
export const TRACE_TURN_FAILED_SQL = `CASE WHEN max(CASE WHEN ${TURN_SPAN_SQL} AND span_status = 'ERROR' THEN end_time END) = max(CASE WHEN ${TURN_SPAN_SQL} THEN end_time END) THEN 1 ELSE 0 END`;

/** 1 when the grouped trace failed, else 0. */
export const TRACE_FAILED_SQL = `CASE WHEN ${TRACE_ROOT_FAILED_SQL} = 1 OR ${TRACE_TURN_FAILED_SQL} = 1 THEN 1 ELSE 0 END`;

/** Number of errored spans in the grouped trace. */
export const TRACE_ERROR_SPANS_SQL = "sum(CASE WHEN span_status = 'ERROR' THEN 1 ELSE 0 END)";

/**
 * The spans the rule reads: errors, LLM/agent turns and the root. Narrowing a
 * per-trace subquery to them changes no outcome and skips the rest.
 */
export const TRACE_OUTCOME_SPANS_SQL = `(span_status = 'ERROR' OR gen_ai_operation_name IS NOT NULL OR ${ROOT_SPAN_SQL})`;

export type TraceOutcome = "failed" | "recovered" | "ok";

/**
 * Outcome of each listed trace: `failed_root`, `failed_turn` and `error_spans`
 * per trace id. `predicate` is an optional bare scope predicate (agent etc.).
 */
export function traceOutcomesSql(stream: string, traceIds: string[], predicate = ""): string {
  const ids = traceIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");
  return [
    `SELECT trace_id, ${TRACE_ROOT_FAILED_SQL} AS failed_root, ${TRACE_TURN_FAILED_SQL} AS failed_turn,`,
    `${TRACE_ERROR_SPANS_SQL} AS error_spans`,
    `FROM "${stream}" WHERE trace_id IN (${ids}) AND ${TRACE_OUTCOME_SPANS_SQL}`,
    predicate ? `AND ${predicate}` : "",
    "GROUP BY trace_id",
  ]
    .filter(Boolean)
    .join(" ");
}

export function traceOutcome(row: {
  failed_root?: unknown;
  failed_turn?: unknown;
  error_spans?: unknown;
}): TraceOutcome {
  if (Number(row.failed_root) === 1 || Number(row.failed_turn) === 1) return "failed";
  return Number(row.error_spans) > 0 ? "recovered" : "ok";
}
