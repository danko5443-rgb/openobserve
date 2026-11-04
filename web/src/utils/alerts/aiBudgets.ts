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
 * Cost budgets (AIO-38), on the alert engine: a budget is one SQL multi-alert
 * on the trace stream's cost columns, one group per budget key. Each group's
 * `spent` is classified warning at 80% and critical at 100% of the limit. Both
 * levels go to the alert's destinations; a gateway webhook tells them apart by
 * the payload's alert level and stops the calls on critical. OpenObserve stays
 * out of the request path (D1).
 *
 * Periods are rolling windows the alert evaluates (the last day, the last 30
 * days, or the last hour for a session's burn rate), not calendar boundaries.
 * Unpriced spans carry no cost, so a budget never counts them as $0 spend —
 * the page names them instead.
 */

import { SEVERITY_TO_PRIORITY } from "@/constants/alertLibrary";

export const BUDGET_PACK = "ai-budgets";

export type BudgetScope = "agent" | "feature" | "user" | "model" | "session";
export type BudgetPeriod = "day" | "month" | "hour";

export interface BudgetDef {
  name: string;
  scope: BudgetScope;
  /** The agent, feature or model; empty for per-user and per-session budgets. */
  value: string;
  limitUsd: number;
  period: BudgetPeriod;
  stream: string;
}

/** Column each scope groups or filters on (attribution keys from AIO-27). */
export const BUDGET_COLUMNS: Record<BudgetScope, string> = {
  agent: "gen_ai_agent_name",
  feature: "feature_name",
  user: "user_id",
  model: "gen_ai_response_model",
  session: "gen_ai_conversation_id",
};

/** Per-user and session budgets apply to each key separately. */
export const isEach = (scope: BudgetScope) => scope === "user" || scope === "session";

export const PERIOD_MINUTES: Record<BudgetPeriod, number> = {
  hour: 60,
  day: 1440,
  month: 43200,
};

const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** Ratio of the limit at which a budget turns warning; critical is the limit itself. */
export const WARN_RATIO = 0.8;

/**
 * Spend in the period, one row per key (`spent`, grouped on the scope's column). The column stays
 * unaliased: a SQL multi-alert requires every GROUP BY field projected under its own name. Worst
 * first, so the alert's bounded page holds the most-over keys.
 */
export function budgetSql(b: BudgetDef, limit?: number): string {
  const col = BUDGET_COLUMNS[b.scope];
  const filter = isEach(b.scope)
    ? `${col} IS NOT NULL AND ${col} != ''`
    : `${col} = ${quote(b.value)}`;
  return (
    `SELECT ${col}, SUM(gen_ai_usage_cost) AS spent FROM "${b.stream}" ` +
    `WHERE ${filter} GROUP BY ${col} ORDER BY spent DESC${limit ? ` LIMIT ${limit}` : ""}`
  );
}

/** The budget's alert, tagged so the Budgets page finds it. */
export function budgetAlertPayload(
  b: BudgetDef,
  opts: {
    folderId: string;
    destination: string;
    owner: string;
    timezone: string;
  },
) {
  return {
    name: b.name.replace(/[^A-Za-z0-9_-]+/g, "_"),
    stream_type: "traces",
    stream_name: b.stream,
    is_real_time: false,
    enabled: true,
    destinations: opts.destination ? [opts.destination] : [],
    query_condition: {
      type: "sql",
      sql: budgetSql(b),
      conditions: null,
      // SQL multi-alert: the backend derives group_by from the SQL; function is fixed.
      aggregation: {
        group_by: [],
        function: "count",
        having: { column: "spent", operator: ">=", value: b.limitUsd, ignore_case: false },
        warning_value: +(b.limitUsd * WARN_RATIO).toFixed(4),
        multi_alert: true,
      },
      promql: null,
      promql_condition: null,
      vrl_function: null,
      multi_time_range: [],
    },
    trigger_condition: {
      period: PERIOD_MINUTES[b.period],
      // A multi-alert's count gate is "any group".
      operator: ">=",
      threshold: 1,
      frequency: b.period === "hour" ? 5 : 15,
      silence: b.period === "hour" ? 60 : 240,
      timezone: opts.timezone,
      tolerance_in_secs: null,
    },
    folder_id: opts.folderId,
    owner: opts.owner,
    last_edited_by: opts.owner,
    tags: [`pack:${BUDGET_PACK}`],
    context_attributes: {
      budget_name: b.name,
      budget_scope: b.scope,
      budget_value: b.value,
      budget_limit_usd: String(b.limitUsd),
      budget_period: b.period,
    },
    priority: SEVERITY_TO_PRIORITY.critical,
  };
}

/** The fields of a stored alert a budget is read back from. */
export interface BudgetAlert {
  stream_name?: string;
  context_attributes?: Record<string, string> | null;
}

const isScope = (v: unknown): v is BudgetScope =>
  typeof v === "string" && Object.hasOwn(BUDGET_COLUMNS, v);
const isPeriod = (v: unknown): v is BudgetPeriod =>
  typeof v === "string" && Object.hasOwn(PERIOD_MINUTES, v);

/** A budget read back from its alert; null for any other alert in the folder. */
export function budgetFromAlert(alert: BudgetAlert | null | undefined): BudgetDef | null {
  const c = alert?.context_attributes ?? {};
  if (!c.budget_name || !isScope(c.budget_scope) || !isPeriod(c.budget_period)) return null;
  return {
    name: c.budget_name,
    scope: c.budget_scope,
    value: c.budget_value ?? "",
    limitUsd: Number(c.budget_limit_usd) || 0,
    period: c.budget_period,
    stream: alert?.stream_name ?? "",
  };
}

export type BudgetState = "under" | "warning" | "over";

export function budgetState(spent: number, limit: number): BudgetState {
  if (limit <= 0) return "under";
  if (spent >= limit) return "over";
  return spent >= WARN_RATIO * limit ? "warning" : "under";
}

/** One row of {@link budgetSql}. */
export interface BudgetRow {
  spent?: unknown;
}

/** Spend of a budget from its rows: the total, or the largest key and how many keys are over. */
export function budgetSpend(
  b: BudgetDef,
  rows: readonly BudgetRow[],
): { spent: number; over: number; largest: number; keys: number } {
  if (!isEach(b.scope)) {
    const spent = Number(rows[0]?.spent) || 0;
    return { spent, over: spent >= b.limitUsd ? 1 : 0, largest: spent, keys: 1 };
  }
  const spends = rows.map((r) => Number(r.spent) || 0);
  return {
    spent: spends.reduce((s, v) => s + v, 0),
    over: spends.filter((v) => v >= b.limitUsd).length,
    largest: Math.max(0, ...spends),
    keys: spends.length,
  };
}
