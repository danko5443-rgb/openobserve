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
 * Cost attribution by user, feature and tenant (AIO-27).
 *
 * The span contract: `user.id` (OpenObserve already reads it), `feature.name`
 * and `tenant.id`, flattened at ingest to the columns below. A trace takes the
 * value of any of its spans (usually the root carries it) and its whole cost,
 * so cost on the LLM spans is attributed to the tenant set on the root.
 *
 * A column a stream has never received does not exist in its schema, and a
 * query naming it fails; callers pass only the columns the schema has.
 */

import { TRACE_FAILED_SQL } from "./llmTraceOutcome";

export const ATTRIBUTION_COLUMNS = {
  tenant: "tenant_id",
  feature: "feature_name",
  user: "user_id",
} as const;

export type AttributionDim = keyof typeof ATTRIBUTION_COLUMNS;

/** The attribute a span sets for each dimension (for the setup snippet). */
export const ATTRIBUTION_ATTRIBUTES: Record<AttributionDim, string> = {
  tenant: "tenant.id",
  feature: "feature.name",
  user: "user.id",
};

const where = (scope: string) => (scope ? ` WHERE ${scope}` : "");

/** Cost, tokens and traces per value; spans with no value land in the '' row. */
export function costByDimensionSql(stream: string, column: string, scope: string): string {
  return (
    `SELECT v, SUM(cost) AS cost, SUM(tokens) AS tokens, COUNT(*) AS traces FROM (` +
    `SELECT trace_id, COALESCE(MAX(${column}), '') AS v, ` +
    `COALESCE(SUM(gen_ai_usage_cost), 0) AS cost, COALESCE(SUM(gen_ai_usage_total_tokens), 0) AS tokens ` +
    `FROM "${stream}"${where(scope)} GROUP BY trace_id) ` +
    `GROUP BY v ORDER BY cost DESC LIMIT 50`
  );
}

export interface AttributionRow {
  value: string;
  cost: number;
  tokens: number;
  traces: number;
  share: number;
}

/**
 * The top `limit` values, the rest folded into one "more" row, and the
 * unattributed row last, so the shares add up to the total.
 */
export function toAttributionRows(
  hits: Array<{ v: unknown; cost: unknown; tokens: unknown; traces: unknown }>,
  limit = 5,
): {
  rows: AttributionRow[];
  more: AttributionRow | null;
  unattributed: AttributionRow | null;
  total: number;
  attributedShare: number;
} {
  const all = hits.map((h) => ({
    value: String(h.v ?? ""),
    cost: Number(h.cost) || 0,
    tokens: Number(h.tokens) || 0,
    traces: Number(h.traces) || 0,
    share: 0,
  }));
  const total = all.reduce((sum, r) => sum + r.cost, 0);
  const withShare = (r: AttributionRow) => ({ ...r, share: total > 0 ? r.cost / total : 0 });
  const attributed = all.filter((r) => r.value).map(withShare);
  const unattributedRow = all.find((r) => !r.value);
  const rest = attributed.slice(limit);
  const more = rest.length
    ? withShare({
        value: String(rest.length),
        cost: rest.reduce((s, r) => s + r.cost, 0),
        tokens: rest.reduce((s, r) => s + r.tokens, 0),
        traces: rest.reduce((s, r) => s + r.traces, 0),
        share: 0,
      })
    : null;
  return {
    rows: attributed.slice(0, limit),
    more,
    unattributed: unattributedRow ? withShare(unattributedRow) : null,
    total,
    attributedShare: total > 0 ? attributed.reduce((s, r) => s + r.cost, 0) / total : 0,
  };
}

/**
 * One row per user: their tenant, sessions, tokens, cost, failure rate (the
 * AIO-06 rule) and last activity, most expensive first.
 */
export function usersSql(
  stream: string,
  opts: { scope: string; tenantColumn: string | null; tenant?: string; search?: string },
): string {
  const tenantExpr = opts.tenantColumn ? `MAX(${opts.tenantColumn})` : "''";
  const filters = ["user_id IS NOT NULL", "user_id != ''"];
  if (opts.tenant) filters.push(`tenant = '${opts.tenant.replace(/'/g, "''")}'`);
  if (opts.search) {
    filters.push(`user_id LIKE '%${opts.search.replace(/'/g, "''").replace(/[%_]/g, "\\$&")}%'`);
  }
  return (
    `SELECT user_id, MAX(tenant) AS tenant, COUNT(DISTINCT session) AS sessions, ` +
    `SUM(tokens) AS tokens, SUM(cost) AS cost, 100.0 * SUM(failed) / COUNT(*) AS failure_rate, ` +
    `MAX(last_ts) AS last_seen FROM (` +
    `SELECT trace_id, MAX(user_id) AS user_id, ${tenantExpr} AS tenant, ` +
    `MAX(gen_ai_conversation_id) AS session, COALESCE(SUM(gen_ai_usage_total_tokens), 0) AS tokens, ` +
    `COALESCE(SUM(gen_ai_usage_cost), 0) AS cost, ${TRACE_FAILED_SQL} AS failed, MAX(_timestamp) AS last_ts ` +
    `FROM "${stream}"${where(opts.scope)} GROUP BY trace_id) ` +
    `WHERE ${filters.join(" AND ")} GROUP BY user_id ORDER BY cost DESC LIMIT 200`
  );
}

/** Share of traces carrying each column (the coverage that says a breakdown can be trusted). */
export function coverageSql(stream: string, columns: string[], scope: string): string {
  const per = columns.map((c) => `SUM(${c}_set) AS ${c}`);
  const inner = columns.map(
    (c) => `MAX(CASE WHEN ${c} IS NOT NULL AND ${c} != '' THEN 1 ELSE 0 END) AS ${c}_set`,
  );
  return (
    `SELECT ${["COUNT(*) AS traces", ...per].join(", ")} FROM (` +
    `SELECT ${["trace_id", ...inner].join(", ")} FROM "${stream}"${where(scope)} GROUP BY trace_id)`
  );
}
