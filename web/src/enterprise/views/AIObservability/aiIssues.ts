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
 * AI Issues (AIO-33..36): rule hits, terminal failures, cost spikes, unpriced
 * models and unhealthy scores in one list, grouped by cause.
 *
 * Issues are computed when the page reads them, from the same SQL the ai-agents
 * alert pack runs, so an issue and its alert agree. Triage (Mark fixed, Not a
 * problem, Mute) is written as one record per decision to the
 * `ai_issue_dispositions` logs stream and read back with the issues; a fixed
 * issue reopens when it is seen again after the fix.
 */

import { TRACE_FAILED_SQL } from "@/plugins/traces/llmTraceOutcome";
import { FAILING_TOOL_MIN_CALLS, REPEATED_TOOL_MIN_CALLS } from "@/utils/alerts/aiAgentsPack";

export type IssueSource = "rule" | "failure" | "cost_spike" | "unpriced" | "score_drop";
export const ISSUE_SOURCES: IssueSource[] = [
  "rule",
  "failure",
  "cost_spike",
  "unpriced",
  "score_drop",
];

export const DISPOSITIONS_STREAM = "ai_issue_dispositions";
/** A loop: the same tool this many times in one trace (the pack's default). */
export const RULE_MIN_CALLS = REPEATED_TOOL_MIN_CALLS;
export const FAILING_MIN_CALLS = FAILING_TOOL_MIN_CALLS;
/** Cost per trace this many times the previous window's is a spike. */
export const COST_SPIKE_FACTOR = 2;
export const COST_SPIKE_FLOOR_USD = 1;
/** Clusters merge when they share at least this share of their traces. */
export const MERGE_OVERLAP = 0.5;
export const MUTE_DAYS = 7;

const and = (scope: string) => (scope ? ` AND ${scope}` : "");
const where = (scope: string) => (scope ? ` WHERE ${scope}` : "");

/** Traces where one tool ran `minCalls`+ times (failing calls only for the failing rule). */
export function ruleHitsSql(stream: string, scope: string, failingOnly: boolean, minCalls: number) {
  return (
    `SELECT trace_id, MAX(gen_ai_agent_name) AS agent, gen_ai_tool_name AS tool, COUNT(*) AS calls, ` +
    `MIN(_timestamp) AS first_ts, MAX(_timestamp) AS last_ts, MAX(gen_ai_conversation_id) AS session, ` +
    `MAX(user_id) AS user_id FROM "${stream}" WHERE gen_ai_operation_name = 'execute_tool' ` +
    `AND gen_ai_tool_name IS NOT NULL${failingOnly ? " AND span_status = 'ERROR'" : ""}${and(scope)} ` +
    `GROUP BY trace_id, gen_ai_tool_name HAVING COUNT(*) >= ${minCalls}`
  );
}

/** Failed traces (AIO-06) with their agent, error message, session, user and cost. */
export function failedTracesSql(stream: string, scope: string, hasStatusMessage: boolean) {
  const msg = hasStatusMessage
    ? "MAX(CASE WHEN span_status = 'ERROR' THEN status_message END)"
    : "''";
  return (
    `SELECT trace_id, MAX(gen_ai_agent_name) AS agent, ${msg} AS error_message, ` +
    `MAX(gen_ai_conversation_id) AS session, MAX(user_id) AS user_id, ` +
    `COALESCE(SUM(gen_ai_usage_cost), 0) AS cost, MIN(_timestamp) AS first_ts, MAX(_timestamp) AS last_ts ` +
    `FROM "${stream}"${where(scope)} GROUP BY trace_id HAVING ${TRACE_FAILED_SQL} = 1`
  );
}

/**
 * Cost per trace per agent in the window and the same-length window before it.
 * Run over [start - span, end]; `split` is the window start (µs).
 */
export function costWindowsSql(stream: string, scope: string, split: number) {
  return (
    `SELECT agent, period, COUNT(*) AS traces, SUM(cost) AS cost, MIN(first_ts) AS first_ts, ` +
    `MAX(first_ts) AS last_ts FROM (SELECT trace_id, MAX(gen_ai_agent_name) AS agent, ` +
    `CASE WHEN MIN(_timestamp) >= ${split} THEN 'now' ELSE 'before' END AS period, ` +
    `COALESCE(SUM(gen_ai_usage_cost), 0) AS cost, MIN(_timestamp) AS first_ts ` +
    `FROM "${stream}"${where(scope)} GROUP BY trace_id) WHERE agent IS NOT NULL GROUP BY agent, period`
  );
}

/** Models whose spans matched no price (needs `gen_ai_usage_cost_status`). */
export function unpricedModelsSql(stream: string, scope: string) {
  return (
    `SELECT gen_ai_response_model AS model, MAX(gen_ai_agent_name) AS agent, ` +
    `COUNT(DISTINCT trace_id) AS traces, COALESCE(SUM(gen_ai_usage_total_tokens), 0) AS tokens, ` +
    `MIN(_timestamp) AS first_ts, MAX(_timestamp) AS last_ts FROM "${stream}" ` +
    `WHERE gen_ai_usage_cost_status = 'unpriced' AND gen_ai_response_model IS NOT NULL${and(scope)} ` +
    `GROUP BY gen_ai_response_model`
  );
}

export function dispositionsSql() {
  return (
    `SELECT issue_key, status, MAX(_timestamp) AS at, MAX(until) AS until, MAX(by_user) AS by_user ` +
    `FROM "${DISPOSITIONS_STREAM}" GROUP BY issue_key, status`
  );
}

/**
 * "429 from the provider after 3 retries" → "429 from the provider after # retries".
 * Counts and ids vary per trace; a 4xx/5xx status code names the class.
 */
export function errorClass(message: string): string {
  const m = (message || "").toLowerCase().trim();
  if (!m) return "";
  return m
    .replace(/[0-9a-f]{8,}/g, "…")
    .replace(/\d+(\.\d+)?/g, (n) => (/^[45]\d\d$/.test(n) ? n : "#"))
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

export interface Issue {
  key: string;
  sources: IssueSource[];
  /** What the title says, by kind (the page words it). */
  kind: "loop" | "failing_tool" | "failure" | "cost_spike" | "unpriced" | "score_drop";
  agent: string;
  tool?: string;
  errorClass?: string;
  model?: string;
  config?: string;
  /** Largest repeat count, cost factor, or unhealthy share, by kind. */
  magnitude: number;
  traceIds: string[];
  sessions: number;
  users: number;
  spend: number;
  tokens: number;
  firstSeen: number;
  lastSeen: number;
  /** The trace that shows it best. */
  worstTraceId?: string;
}

interface Acc {
  issue: Issue;
  sessions: Set<string>;
  users: Set<string>;
  worst: number;
}

function accumulate(
  map: Map<string, Acc>,
  key: string,
  base: Omit<
    Issue,
    "traceIds" | "sessions" | "users" | "spend" | "tokens" | "firstSeen" | "lastSeen" | "magnitude"
  >,
  row: any,
  weight: number,
  cost = 0,
) {
  let acc = map.get(key);
  if (!acc) {
    acc = {
      issue: {
        ...base,
        magnitude: 0,
        traceIds: [],
        sessions: 0,
        users: 0,
        spend: 0,
        tokens: 0,
        firstSeen: Infinity,
        lastSeen: 0,
      },
      sessions: new Set(),
      users: new Set(),
      worst: -1,
    };
    map.set(key, acc);
  }
  const i = acc.issue;
  if (!i.traceIds.includes(row.trace_id)) i.traceIds.push(row.trace_id);
  if (row.session) acc.sessions.add(String(row.session));
  if (row.user_id) acc.users.add(String(row.user_id));
  i.spend += cost;
  i.firstSeen = Math.min(i.firstSeen, Number(row.first_ts) || Infinity);
  i.lastSeen = Math.max(i.lastSeen, Number(row.last_ts) || 0);
  i.magnitude = Math.max(i.magnitude, weight);
  if (weight > acc.worst) {
    acc.worst = weight;
    i.worstTraceId = row.trace_id;
  }
}

const finish = (map: Map<string, Acc>): Issue[] =>
  [...map.values()].map((a) => ({ ...a.issue, sessions: a.sessions.size, users: a.users.size }));

export function ruleIssues(loops: any[], failing: any[]): Issue[] {
  const map = new Map<string, Acc>();
  for (const r of loops) {
    const agent = String(r.agent ?? "");
    accumulate(
      map,
      `rule:loop:${agent}:${r.tool}`,
      { key: `rule:loop:${agent}:${r.tool}`, sources: ["rule"], kind: "loop", agent, tool: r.tool },
      r,
      Number(r.calls) || 0,
    );
  }
  for (const r of failing) {
    const agent = String(r.agent ?? "");
    accumulate(
      map,
      `rule:failing:${agent}:${r.tool}`,
      {
        key: `rule:failing:${agent}:${r.tool}`,
        sources: ["rule"],
        kind: "failing_tool",
        agent,
        tool: r.tool,
      },
      r,
      Number(r.calls) || 0,
    );
  }
  return finish(map);
}

export function failureIssues(failed: any[]): Issue[] {
  const map = new Map<string, Acc>();
  for (const r of failed) {
    const agent = String(r.agent ?? "");
    const cls = errorClass(String(r.error_message ?? ""));
    const key = `failure:${agent}:${cls}`;
    accumulate(
      map,
      key,
      { key, sources: ["failure"], kind: "failure", agent, errorClass: cls },
      r,
      Number(r.last_ts) || 0,
      Number(r.cost) || 0,
    );
  }
  return finish(map);
}

export function costSpikeIssues(windows: any[]): Issue[] {
  const byAgent = new Map<string, { now?: any; before?: any }>();
  for (const w of windows) {
    const e = byAgent.get(w.agent) ?? {};
    e[w.period as "now" | "before"] = w;
    byAgent.set(w.agent, e);
  }
  const out: Issue[] = [];
  for (const [agent, { now, before }] of byAgent) {
    if (!now || !before) continue;
    const perNow = Number(now.cost) / Math.max(1, Number(now.traces));
    const perBefore = Number(before.cost) / Math.max(1, Number(before.traces));
    if (perBefore <= 0 || Number(now.cost) < COST_SPIKE_FLOOR_USD) continue;
    const factor = perNow / perBefore;
    if (factor < COST_SPIKE_FACTOR) continue;
    out.push({
      key: `cost_spike:${agent}`,
      sources: ["cost_spike"],
      kind: "cost_spike",
      agent,
      magnitude: Math.round(factor * 10) / 10,
      traceIds: [],
      sessions: 0,
      users: 0,
      spend: Number(now.cost) || 0,
      tokens: 0,
      firstSeen: Number(now.first_ts) || 0,
      lastSeen: Number(now.last_ts) || 0,
    });
  }
  return out;
}

export function unpricedIssues(models: any[]): Issue[] {
  return models.map((m) => ({
    key: `unpriced:${m.model}`,
    sources: ["unpriced"] as IssueSource[],
    kind: "unpriced" as const,
    agent: String(m.agent ?? ""),
    model: String(m.model),
    magnitude: Number(m.tokens) || 0,
    traceIds: [],
    sessions: 0,
    users: 0,
    spend: 0,
    tokens: Number(m.tokens) || 0,
    firstSeen: Number(m.first_ts) || 0,
    lastSeen: Number(m.last_ts) || 0,
  }));
}

/** Unhealthy score configs from the Quality API (enterprise). */
export function scoreIssues(
  configs: Array<{
    configId: string;
    name: string;
    total: number;
    unhealthy: number | null;
    lastScoredAt: number | null;
  }>,
  agent: string,
): Issue[] {
  return configs
    .filter((c) => c.total > 0 && (c.unhealthy ?? 0) / c.total >= 0.25)
    .map((c) => ({
      key: `score_drop:${c.configId}`,
      sources: ["score_drop"] as IssueSource[],
      kind: "score_drop" as const,
      agent,
      config: c.name,
      magnitude: Math.round(((c.unhealthy ?? 0) / c.total) * 100),
      traceIds: [],
      sessions: 0,
      users: 0,
      spend: 0,
      tokens: 0,
      firstSeen: c.lastScoredAt ?? 0,
      lastSeen: c.lastScoredAt ?? 0,
    }));
}

const overlap = (a: string[], b: string[]) => {
  if (!a.length || !b.length) return 0;
  const set = new Set(a);
  const shared = b.filter((x) => set.has(x)).length;
  return shared / Math.min(a.length, b.length);
};

/**
 * Group by cause: a rule cluster and a failure cluster of the same agent that
 * share most of their traces are one issue with both sources (the rule's
 * title). Ordered by spend, then traces, then last seen.
 */
export function clusterIssues(issues: Issue[]): Issue[] {
  const out: Issue[] = [];
  for (const issue of issues) {
    const twin = out.find(
      (o) =>
        o.agent === issue.agent &&
        o.sources.includes("rule") !== issue.sources.includes("rule") &&
        overlap(o.traceIds, issue.traceIds) >= MERGE_OVERLAP,
    );
    if (!twin) {
      out.push({ ...issue, traceIds: [...issue.traceIds] });
      continue;
    }
    const primary = twin.sources.includes("rule") ? twin : issue;
    const merged: Issue = {
      ...primary,
      key: twin.key,
      sources: [...new Set([...twin.sources, ...issue.sources])],
      traceIds: [...new Set([...twin.traceIds, ...issue.traceIds])],
      sessions: Math.max(twin.sessions, issue.sessions),
      users: Math.max(twin.users, issue.users),
      spend: Math.max(twin.spend, issue.spend),
      firstSeen: Math.min(twin.firstSeen, issue.firstSeen),
      lastSeen: Math.max(twin.lastSeen, issue.lastSeen),
    };
    out.splice(out.indexOf(twin), 1, merged);
  }
  return out.sort(
    (a, b) => b.spend - a.spend || b.traceIds.length - a.traceIds.length || b.lastSeen - a.lastSeen,
  );
}

export type IssueState = "open" | "muted" | "closed";
export type DispositionStatus = "fixed" | "dismissed" | "muted";

export interface Disposition {
  status: DispositionStatus;
  at: number;
  until?: number;
}

/** The latest decision per issue key. */
export function latestDispositions(rows: any[]): Map<string, Disposition> {
  const out = new Map<string, Disposition>();
  for (const r of rows) {
    const at = Number(r.at) || 0;
    const seen = out.get(r.issue_key);
    if (!seen || at > seen.at) {
      out.set(r.issue_key, { status: r.status, at, until: Number(r.until) || undefined });
    }
  }
  return out;
}

/**
 * Open unless decided: muted while the mute lasts, closed when dismissed or
 * fixed — and a fixed issue seen again after the fix is open again.
 */
export function issueState(issue: Issue, d: Disposition | undefined, nowUs: number): IssueState {
  if (!d) return "open";
  if (d.status === "dismissed") return "closed";
  if (d.status === "muted") return d.until && d.until > nowUs ? "muted" : "open";
  return issue.lastSeen > d.at ? "open" : "closed";
}

/** The question handed to O2 AI for a narrated root cause (model input, kept English). */
export function rootCausePrompt(issue: Issue, stream: string, windowLabel: string): string {
  const subject =
    issue.kind === "loop"
      ? `agent "${issue.agent}" calls the tool "${issue.tool}" ${issue.magnitude}+ times in one trace`
      : issue.kind === "failing_tool"
        ? `agent "${issue.agent}" keeps failing calls to the tool "${issue.tool}"`
        : issue.kind === "failure"
          ? `agent "${issue.agent}" traces fail with "${issue.errorClass || "an error"}"`
          : issue.kind === "cost_spike"
            ? `agent "${issue.agent}" costs ${issue.magnitude}x more per trace than in the previous window`
            : issue.kind === "unpriced"
              ? `model "${issue.model}" has no price`
              : `score config "${issue.config}" is unhealthy for ${issue.magnitude}% of scores`;
  const traces = issue.traceIds.slice(0, 5).join(", ");
  return (
    `Investigate the root cause of this AI agent issue: ${subject}. ` +
    `Trace stream: ${stream}. Window: ${windowLabel}. ` +
    `${issue.traceIds.length} affected traces${traces ? `, for example ${traces}` : ""}. ` +
    `Look past the AI spans too: logs, metrics, Kubernetes state and recent deploys of the services these traces call. ` +
    `Give the probable cause in one sentence with a confidence, the hypotheses you ruled out with their evidence, and a short timeline.`
  );
}
