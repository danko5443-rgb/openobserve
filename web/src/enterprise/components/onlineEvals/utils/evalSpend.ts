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
 * Eval spend guard (AIO-24): the job form's cost estimate, the daily budget and
 * its backfill. A judge's cost per call comes from its own `_evaluator` spans,
 * which the LLM processor priced at ingest — the same table real calls use. A
 * judge with no priced call has no estimate: it is never counted as $0.
 */

import type {
  EvalBudgetAction,
  EvalJob,
  EvalTargetScope,
  ManualEvalJobPayload,
} from "@/services/online-evals.service";
import { countExpression, quoteIdent } from "../composables/useJobMatchedTargets";

/** Every new job starts with this budget, per UTC day. */
export const DEFAULT_DAILY_BUDGET_USD = 5;
export const DEFAULT_BUDGET_ACTION: EvalBudgetAction = "pause";
/** The estimate reads this many days of matched traffic and judge calls. */
export const ESTIMATE_DAYS = 7;
export const BACKFILL_DAY_OPTIONS = [0, 1, 3, 7] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** 00:00 UTC of the day `atMs` falls in. */
export const utcDayStartMs = (atMs: number): number => atMs - (((atMs % DAY_MS) + DAY_MS) % DAY_MS);

/** Matched targets per day over the estimate window, at the job's own scope. */
export function matchedPerDaySql(stream: string, where: string, scope: EvalTargetScope): string {
  return [
    `SELECT histogram(_timestamp, '1 day') AS day, ${countExpression(scope)} AS cnt`,
    `FROM ${quoteIdent(stream)}`,
    where.trim() ? `WHERE ${where.trim()}` : "",
    "GROUP BY day ORDER BY day",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Successful calls per judge, and what the priced ones cost. */
export function judgeHistorySql(scorerIds: string[]): string {
  return [
    "SELECT attributes_scorer_id AS scorer_id, COUNT(*) AS calls,",
    "  COUNT(gen_ai_usage_cost) AS priced, SUM(gen_ai_usage_cost) AS cost,",
    "  AVG(TRY_CAST(attributes_total_tokens AS DOUBLE)) AS tokens, MAX(attributes_model) AS model",
    'FROM "_evaluator"',
    `WHERE attributes_scorer_id IN (${scorerIds.map(quote).join(", ")})`,
    "  AND attributes_status = 'success'",
    "GROUP BY attributes_scorer_id",
  ].join("\n");
}

/** Judge spend per job since the start of the query window (00:00 UTC). */
export function spendTodaySql(jobIds: string[]): string {
  return [
    "SELECT attributes_job_id AS job_id, SUM(gen_ai_usage_cost) AS spend",
    'FROM "_evaluator"',
    `WHERE attributes_job_id IN (${jobIds.map(quote).join(", ")})`,
    "GROUP BY attributes_job_id",
  ].join("\n");
}

export interface JudgeHistory {
  scorerId: string;
  calls: number;
  priced: number;
  cost: number;
  tokens: number | null;
  model: string | null;
}

export function parseJudgeHistory(rows: any[]): JudgeHistory[] {
  return rows.map((r) => ({
    scorerId: String(r.scorer_id ?? ""),
    calls: Number(r.calls) || 0,
    priced: Number(r.priced) || 0,
    cost: Number(r.cost) || 0,
    tokens: r.tokens == null ? null : Number(r.tokens),
    model: r.model ? String(r.model) : null,
  }));
}

export interface SpendEstimate {
  matchedPerDay: number;
  scoredPerDay: number;
  /** Judge cost per scored target; null when a judge has no priced call to go on. */
  perTargetUsd: number | null;
  perDayUsd: number | null;
  busiestDayUsd: number | null;
  tokensPerTarget: number | null;
  /** The judge model, when every judge in the job uses one. */
  model: string | null;
}

/**
 * Matched targets a day × sample rate × judge cost per target. Days without
 * traffic are not averaged in, so a stream that started yesterday is not
 * diluted over the whole week. Scorers that are not LLM judges cost nothing.
 */
export function estimateJobSpend(opts: {
  dailyCounts: number[];
  rate: number;
  judgeIds: string[];
  history: JudgeHistory[];
}): SpendEstimate {
  const days = opts.dailyCounts.filter((c) => c > 0);
  const matchedPerDay = days.length ? days.reduce((a, b) => a + b, 0) / days.length : 0;
  const scoredPerDay = matchedPerDay * opts.rate;
  const judges = opts.judgeIds.map((id) => opts.history.find((h) => h.scorerId === id));
  const priced = judges.every((h) => h && h.priced > 0);
  const perTargetUsd = priced ? judges.reduce((sum, h) => sum + h!.cost / h!.priced, 0) : null;
  const tokens = judges.map((h) => h?.tokens);
  const models = [...new Set(judges.map((h) => h?.model).filter(Boolean))];
  return {
    matchedPerDay,
    scoredPerDay,
    perTargetUsd,
    perDayUsd: perTargetUsd == null ? null : perTargetUsd * scoredPerDay,
    busiestDayUsd:
      perTargetUsd == null ? null : perTargetUsd * opts.rate * Math.max(0, ...opts.dailyCounts),
    tokensPerTarget: tokens.every((n) => n != null) ? tokens.reduce((a, b) => a! + b!, 0)! : null,
    model: models.length === 1 ? (models[0] as string) : null,
  };
}

/**
 * A one-time backfill of the last `days` days, at the job's sample rate. It
 * counts toward today's budget, so it never queues more targets than the
 * budget pays for; past that the budget would pause the job with the rest of
 * the backfill still queued.
 */
export function backfillEstimate(opts: {
  dailyCounts: number[];
  days: number;
  rate: number;
  perTargetUsd: number | null;
  budgetUsd: number;
}): { targets: number; usd: number | null; cap: number | null } {
  const matched = opts.dailyCounts.slice(-opts.days).reduce((a, b) => a + b, 0);
  const targets = Math.round(matched * opts.rate);
  const perTarget = opts.perTargetUsd;
  const cap = perTarget ? Math.floor(opts.budgetUsd / perTarget) : null;
  return {
    targets,
    usd: perTarget == null ? null : perTarget * targets,
    cap: cap != null && cap < targets ? cap : null,
  };
}

const TARGET_COLUMN: Record<EvalTargetScope, string> = {
  span: "span_id",
  trace: "trace_id",
  session: "session_id",
};

/** Up to `limit` matched targets with the time range their spans cover (nanoseconds). */
export function backfillTargetsSql(
  stream: string,
  where: string,
  scope: EvalTargetScope,
  limit: number,
): string {
  const id = TARGET_COLUMN[scope];
  return [
    `SELECT ${id} AS target_id, MAX(trace_id) AS trace_id,`,
    "  MIN(start_time) AS start_ns, MAX(end_time) AS end_ns",
    `FROM ${quoteIdent(stream)}`,
    `WHERE ${id} IS NOT NULL${where.trim() ? ` AND (${where.trim()})` : ""}`,
    `GROUP BY ${id}`,
    `LIMIT ${limit}`,
  ].join("\n");
}

/**
 * Manual evaluation requests for a sample of the backfill rows. The window is
 * padded by `padUs` on each side: the rows only cover the spans that matched
 * the filter, and a trace or session judge reads the whole target.
 */
export function backfillRequests(
  rows: any[],
  scope: EvalTargetScope,
  opts: { rate: number; cap: number; padUs: number; random?: () => number },
): ManualEvalJobPayload[] {
  const random = opts.random ?? Math.random;
  const out: ManualEvalJobPayload[] = [];
  for (const row of rows) {
    if (out.length >= opts.cap) break;
    const targetId = String(row.target_id ?? "");
    if (!targetId || random() >= opts.rate) continue;
    out.push({
      targetId,
      startTime: Math.max(0, Math.floor(Number(row.start_ns) / 1000) - 1 - opts.padUs),
      endTime: Math.ceil(Number(row.end_ns) / 1000) + 1 + opts.padUs,
      spanId: scope === "span" ? targetId : null,
      traceId: scope === "session" ? (row.trace_id ?? null) : scope === "trace" ? targetId : null,
      sessionId: scope === "session" ? targetId : null,
      reason: "backfill",
    });
  }
  return out;
}

/** Paused by its budget, as opposed to by a user. */
export const isBudgetPaused = (job: EvalJob): boolean =>
  job.status === "paused" && !!job.budget?.pausedAt;

/** "$0.38" for day amounts; sub-cent values keep two significant digits. */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toPrecision(2)}`;
  return `$${value.toFixed(2)}`;
}
