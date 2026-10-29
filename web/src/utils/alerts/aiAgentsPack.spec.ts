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

import { describe, it, expect } from "vitest";
import {
  AI_AGENTS_PACK,
  aiPackAlertPayload,
  evaluatorLagSql,
  failureRateSql,
  judgeErrorRateSql,
  packAlertName,
  repeatedToolCallsSql,
  ruleReadiness,
  scoresStoppedSql,
} from "./aiAgentsPack";
import { buildAiPrefill } from "./prefill/fromAi";

const rule = (id: string) => AI_AGENTS_PACK.find((r) => r.id === id)!;

describe("ai-agents pack (AIO-20)", () => {
  it("has the 7 reliability rules and 6 templates", () => {
    expect(AI_AGENTS_PACK.filter((r) => r.kind === "rule")).toHaveLength(7);
    expect(AI_AGENTS_PACK.filter((r) => r.kind === "template")).toHaveLength(6);
  });

  it("installs only rules whose data exists", () => {
    expect(ruleReadiness(rule("repeated_tool_calls"), false)).toBe("ready");
    expect(ruleReadiness(rule("tool_loop"), true)).toBe("waits");
    expect(ruleReadiness(rule("evaluator_lag"), false)).toBe("needs-scores");
    expect(ruleReadiness(rule("evaluator_lag"), true)).toBe("ready");
  });

  it("returns trace_id and span_id so every hit can be placed on a span", () => {
    const sql = repeatedToolCallsSql("s", { failingOnly: true });
    expect(sql).toMatch(/^SELECT trace_id, max\(span_id\) AS span_id/);
    expect(sql).toContain("span_status = 'ERROR'");
    expect(sql).toContain("HAVING count(*) >= 3");
  });

  it("counts failures with the AIO-06 rule, per agent", () => {
    const sql = failureRateSql("s", { scope: "gen_ai_agent_name = 'a'" });
    expect(sql).toContain("FROM \"s\" WHERE gen_ai_agent_name = 'a' GROUP BY trace_id");
    expect(sql).toContain("HAVING count(*) >= 50 AND 100.0 * sum(failed) / count(*) > 5");
  });

  it("builds a v2 SQL alert in the pack folder, tagged with the pack", () => {
    const spec = rule("failure_rate").spec!("llm");
    const payload: any = aiPackAlertPayload("failure_rate", spec, {
      stream: "llm",
      folderId: "f1",
      destination: "",
      owner: "me@example.com",
      timezone: "UTC",
    });
    expect(payload.name).toBe("ai_failure_rate_llm");
    expect(payload.destinations).toEqual([]);
    expect(payload.query_condition.type).toBe("sql");
    expect(payload.trigger_condition).toMatchObject({ period: 30, threshold: 1, operator: ">=" });
    expect(payload.tags).toEqual(["pack:ai-agents"]);
    expect(payload.priority).toBe(3);
    expect(packAlertName(spec, "default")).toBe("ai_failure_rate");
  });

  it("prefills Create alert for the agent and tool in scope", () => {
    const prefill = buildAiPrefill({
      kind: "repeated_tool_calls",
      stream: "s",
      agent: "omp",
      tool: "grep",
    });
    expect(prefill.sql).toContain("AND gen_ai_agent_name = 'omp' AND gen_ai_tool_name = 'grep'");
    expect(prefill).toMatchObject({
      source: "ai",
      streamType: "traces",
      streamName: "s",
      triggerThreshold: 1,
    });
    expect(prefill.name).toBe("omp_grep_repeated_tool_calls");
  });
});

describe("ai-agents pack: eval job templates (AIO-25)", () => {
  it("reads evaluator lag as p95 lag over 10 minutes", () => {
    expect(evaluatorLagSql()).toContain(
      "HAVING approx_percentile_cont(_timestamp - ref_timestamp, 0.95) / 60000000.0 > 10",
    );
  });

  it("alerts on a job with no score for 30 min that scored in the same hour yesterday", () => {
    const spec = rule("eval_scores_stopped").spec!("llm");
    expect(spec).toMatchObject({
      streamName: "_llm_scores",
      streamType: "logs",
      periodMinutes: 1440,
      severity: "critical",
    });
    expect(spec.sql).toContain("WHERE job_id IS NOT NULL GROUP BY job_id");
    expect(spec.sql).toContain(
      "count(CASE WHEN to_timestamp_micros(_timestamp) >= now() - INTERVAL '30 minutes' THEN 1 END) = 0",
    );
    expect(spec.sql).toContain(
      "count(CASE WHEN NOT (to_timestamp_micros(_timestamp) >= now() - INTERVAL '23 hours') THEN 1 END) >= 3",
    );
    expect(scoresStoppedSql({ jobId: "j'1" })).toContain("WHERE job_id = 'j''1'");
  });

  it("alerts per job when over 20% of at least 3 judge calls fail", () => {
    const spec = rule("eval_judge_error_rate").spec!("llm");
    expect(spec).toMatchObject({
      streamName: "_evaluator",
      streamType: "traces",
      periodMinutes: 30,
    });
    expect(spec.sql).toContain('FROM "_evaluator"');
    expect(spec.sql).toContain("GROUP BY attributes_job_id HAVING count(*) >= 3 AND");
    expect(spec.sql).toMatch(/\* 100\.0 \/ count\(\*\) > 20$/);
    expect(judgeErrorRateSql({ jobId: "j1" })).toContain("AND attributes_job_id = 'j1'");
    // Every pack install reads the same evaluator stream, so it keeps one name.
    expect(packAlertName(spec, "llm")).toBe("ai_eval_judge_error_rate");
  });

  it("prefills an eval job's alert on the evaluator's stream, scoped to the job", () => {
    const prefill = buildAiPrefill({
      kind: "eval_scores_stopped",
      stream: "default",
      jobId: "job-1",
      jobName: "research-agent hallucination",
    });
    expect(prefill).toMatchObject({
      source: "ai",
      streamType: "logs",
      streamName: "_llm_scores",
      periodMinutes: 1440,
      triggerThreshold: 1,
    });
    expect(prefill.sql).toContain("WHERE job_id = 'job-1'");
    expect(prefill.name).toContain("eval_scores_stopped");
    const errors = buildAiPrefill({
      kind: "eval_judge_error_rate",
      stream: "default",
      jobId: "job-1",
    });
    expect(errors).toMatchObject({ streamType: "traces", streamName: "_evaluator" });
    expect(errors.sql).toContain("attributes_job_id = 'job-1'");
  });
});
