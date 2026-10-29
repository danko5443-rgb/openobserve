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
 * Discovery without scores (AIO-30): rank traces by what their spans already
 * show. Six tiers, worst first: terminal failures (the AIO-06 rule), tool
 * loops, cost outliers, latency outliers, unpriced spend, then unhealthy
 * scores (the existing Discovery rows). Inside a tier, bigger first. Every row
 * says why it is listed, with the number.
 */

import {
  ROOT_SPAN_SQL,
  TRACE_ROOT_FAILED_SQL,
  TRACE_TURN_FAILED_SQL,
} from "@/plugins/traces/llmTraceOutcome";

export type ProblemTier = "failed" | "loop" | "cost" | "slow" | "unpriced";
export const PROBLEM_TIERS: ProblemTier[] = ["failed", "loop", "cost", "slow", "unpriced"];

/** Same tool this many times in one trace is a loop; matches the pack's rule. */
export const LOOP_MIN_CALLS = 10;
/** Outliers need this multiple of the agent's median and these floors, so a steady agent lists none. */
export const OUTLIER_FACTOR = 5;
export const COST_FLOOR_USD = 0.5;
export const LATENCY_FLOOR_US = 30_000_000;

const where = (scope: string) => (scope ? ` WHERE ${scope}` : "");

/**
 * One row per trace with what the tiers need. `cols` says which optional
 * columns the stream has (a missing column would fail the query).
 */
export function problemTracesSql(
  stream: string,
  scope: string,
  cols: { statusMessage: boolean; costStatus: boolean },
): string {
  const err = cols.statusMessage
    ? "MAX(CASE WHEN span_status = 'ERROR' THEN status_message END)"
    : "''";
  const unpriced = cols.costStatus
    ? "COALESCE(SUM(CASE WHEN gen_ai_usage_cost_status = 'unpriced' THEN gen_ai_usage_total_tokens ELSE 0 END), 0)"
    : "0";
  const unpricedModel = cols.costStatus
    ? "MAX(CASE WHEN gen_ai_usage_cost_status = 'unpriced' THEN gen_ai_response_model END)"
    : "''";
  return (
    `SELECT trace_id, MIN(_timestamp) AS ts, ` +
    `MAX(CASE WHEN ${ROOT_SPAN_SQL} THEN operation_name END) AS root_op, ` +
    `FIRST_VALUE(gen_ai_input_messages ORDER BY start_time ASC) ` +
    `FILTER (WHERE gen_ai_input_messages IS NOT NULL AND gen_ai_input_messages != '') AS input, ` +
    `${TRACE_ROOT_FAILED_SQL} AS failed_root, ${TRACE_TURN_FAILED_SQL} AS failed_turn, ${err} AS error_message, ` +
    `COALESCE(SUM(gen_ai_usage_cost), 0) AS cost, MAX(end_time) - MIN(start_time) AS duration_ns, ` +
    `${unpriced} AS unpriced_tokens, ${unpricedModel} AS unpriced_model ` +
    `FROM "${stream}"${where(scope)} GROUP BY trace_id ORDER BY ts DESC LIMIT 5000`
  );
}

/** Traces calling one tool LOOP_MIN_CALLS+ times. */
export function toolLoopsSql(stream: string, scope: string): string {
  return (
    `SELECT trace_id, gen_ai_tool_name AS tool, COUNT(*) AS calls FROM "${stream}" ` +
    `WHERE gen_ai_operation_name = 'execute_tool' AND gen_ai_tool_name IS NOT NULL` +
    `${scope ? ` AND ${scope}` : ""} GROUP BY trace_id, gen_ai_tool_name ` +
    `HAVING COUNT(*) >= ${LOOP_MIN_CALLS}`
  );
}

export interface ProblemReason {
  tier: ProblemTier;
  /** What the row's reason text needs, by tier. */
  detail: Record<string, string | number>;
  /** Ranks inside the tier: bigger first. */
  weight: number;
}

export interface ProblemRow {
  traceId: string;
  ts: number;
  rootOp: string;
  input: unknown;
  /** Worst reason first; the row ranks by it. */
  reasons: ProblemReason[];
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function rankProblems(
  traces: any[],
  loops: Array<{ trace_id: string; tool: string; calls: unknown }>,
): { rows: ProblemRow[]; counts: Record<ProblemTier, number>; checked: number } {
  const loopsByTrace = new Map<string, { tool: string; calls: number }>();
  for (const l of loops) {
    const calls = Number(l.calls) || 0;
    const seen = loopsByTrace.get(l.trace_id);
    if (!seen || calls > seen.calls) loopsByTrace.set(l.trace_id, { tool: l.tool, calls });
  }
  const costMedian = median(traces.map((t) => Number(t.cost) || 0));
  const durationMedian = median(traces.map((t) => (Number(t.duration_ns) || 0) / 1000));

  const counts: Record<ProblemTier, number> = { failed: 0, loop: 0, cost: 0, slow: 0, unpriced: 0 };
  const rows: ProblemRow[] = [];
  for (const t of traces) {
    const reasons: ProblemReason[] = [];
    const cost = Number(t.cost) || 0;
    const durationUs = (Number(t.duration_ns) || 0) / 1000;
    if (Number(t.failed_root) === 1 || Number(t.failed_turn) === 1) {
      reasons.push({
        tier: "failed",
        detail: {
          where: Number(t.failed_root) === 1 ? "root" : "turn",
          message: String(t.error_message ?? ""),
        },
        weight: Number(t.ts) || 0,
      });
    }
    const loop = loopsByTrace.get(t.trace_id);
    if (loop) {
      reasons.push({
        tier: "loop",
        detail: { tool: loop.tool, calls: loop.calls },
        weight: loop.calls,
      });
    }
    if (costMedian > 0 && cost >= OUTLIER_FACTOR * costMedian && cost >= COST_FLOOR_USD) {
      reasons.push({
        tier: "cost",
        detail: { cost, factor: Math.round(cost / costMedian), median: costMedian },
        weight: cost,
      });
    }
    if (
      durationMedian > 0 &&
      durationUs >= OUTLIER_FACTOR * durationMedian &&
      durationUs >= LATENCY_FLOOR_US
    ) {
      reasons.push({
        tier: "slow",
        detail: {
          durationUs,
          factor: Math.round(durationUs / durationMedian),
          medianUs: durationMedian,
        },
        weight: durationUs,
      });
    }
    const unpricedTokens = Number(t.unpriced_tokens) || 0;
    if (unpricedTokens > 0) {
      reasons.push({
        tier: "unpriced",
        detail: { tokens: unpricedTokens, model: String(t.unpriced_model ?? "") },
        weight: unpricedTokens,
      });
    }
    if (!reasons.length) continue;
    for (const r of reasons) counts[r.tier]++;
    rows.push({
      traceId: t.trace_id,
      ts: Number(t.ts) || 0,
      rootOp: String(t.root_op ?? ""),
      input: t.input,
      reasons,
    });
  }
  const tierIndex = (r: ProblemRow) => PROBLEM_TIERS.indexOf(r.reasons[0].tier);
  rows.sort((a, b) => tierIndex(a) - tierIndex(b) || b.reasons[0].weight - a.reasons[0].weight);
  return { rows, counts, checked: traces.length };
}
