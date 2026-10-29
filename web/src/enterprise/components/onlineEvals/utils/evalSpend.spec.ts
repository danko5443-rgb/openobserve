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

import { describe, expect, it } from "vitest";
import {
  backfillEstimate,
  backfillRequests,
  backfillTargetsSql,
  estimateJobSpend,
  formatUsd,
  isBudgetPaused,
  judgeHistorySql,
  matchedPerDaySql,
  parseJudgeHistory,
  spendTodaySql,
  utcDayStartMs,
  type JudgeHistory,
} from "./evalSpend";

const judge = (scorerId: string, priced: number, cost: number): JudgeHistory => ({
  scorerId,
  calls: priced,
  priced,
  cost,
  tokens: 9800,
  model: "gpt-4o-mini",
});

describe("eval spend estimate (AIO-24)", () => {
  it("is matched targets a day × sample rate × judge cost per target", () => {
    // 2,410 traces a day on the days with traffic; the empty days are not averaged in.
    const e = estimateJobSpend({
      dailyCounts: [2000, 0, 2820],
      rate: 0.1,
      judgeIds: ["h"],
      history: [judge("h", 100, 0.16)],
    });
    expect(e.matchedPerDay).toBe(2410);
    expect(e.scoredPerDay).toBeCloseTo(241);
    expect(e.perTargetUsd).toBeCloseTo(0.0016);
    expect(e.perDayUsd).toBeCloseTo(0.3856);
    expect(e.busiestDayUsd).toBeCloseTo(0.4512);
    expect(e).toMatchObject({ tokensPerTarget: 9800, model: "gpt-4o-mini" });
  });

  it("adds up every judge a target goes through", () => {
    const e = estimateJobSpend({
      dailyCounts: [10],
      rate: 1,
      judgeIds: ["a", "b"],
      history: [judge("a", 10, 0.1), judge("b", 5, 0.1)],
    });
    expect(e.perTargetUsd).toBeCloseTo(0.03);
  });

  it("never counts a judge without priced calls as $0", () => {
    const unpriced = { ...judge("a", 0, 0), calls: 40 };
    for (const history of [[], [unpriced], [judge("b", 3, 0.3)]]) {
      const e = estimateJobSpend({ dailyCounts: [10], rate: 1, judgeIds: ["a"], history });
      expect(e.perTargetUsd).toBeNull();
      expect(e.perDayUsd).toBeNull();
    }
  });

  it("costs nothing without an LLM judge", () => {
    const e = estimateJobSpend({ dailyCounts: [10], rate: 0.5, judgeIds: [], history: [] });
    expect(e.perDayUsd).toBe(0);
    expect(e.scoredPerDay).toBe(5);
  });

  it("reads search rows that carry numbers as strings", () => {
    expect(
      parseJudgeHistory([
        { scorer_id: "a", calls: "4", priced: "4", cost: "0.2", tokens: null, model: "" },
      ]),
    ).toEqual([{ scorerId: "a", calls: 4, priced: 4, cost: 0.2, tokens: null, model: null }]);
  });
});

describe("backfill (AIO-24)", () => {
  it("estimates the last N days once, capped at what today's budget pays for", () => {
    const counts = [100, 200, 300, 400];
    expect(
      backfillEstimate({
        dailyCounts: counts,
        days: 2,
        rate: 0.5,
        perTargetUsd: 0.01,
        budgetUsd: 5,
      }),
    ).toEqual({ targets: 350, usd: 3.5, cap: null });
    expect(
      backfillEstimate({ dailyCounts: counts, days: 4, rate: 1, perTargetUsd: 0.01, budgetUsd: 5 }),
    ).toMatchObject({ targets: 1000, cap: 500 });
    expect(
      backfillEstimate({ dailyCounts: counts, days: 1, rate: 1, perTargetUsd: null, budgetUsd: 5 }),
    ).toEqual({ targets: 400, usd: null, cap: null });
  });

  it("samples rows at the rate up to the cap, padding the window for whole targets", () => {
    const rows = [
      { target_id: "t1", trace_id: "t1", start_ns: 5_000_000_000, end_ns: 6_000_000_000 },
      { target_id: "t2", trace_id: "t2", start_ns: 7_000_000_000, end_ns: 8_000_000_000 },
      { target_id: "t3", trace_id: "t3", start_ns: 9_000_000_000, end_ns: 9_500_000_000 },
    ];
    const draws = [0.05, 0.9, 0.05];
    const requests = backfillRequests(rows, "trace", {
      rate: 0.1,
      cap: 5,
      padUs: 1000,
      random: () => draws.shift()!,
    });
    expect(requests.map((r) => r.targetId)).toEqual(["t1", "t3"]);
    expect(requests[0]).toMatchObject({
      traceId: "t1",
      spanId: null,
      sessionId: null,
      startTime: 5_000_000 - 1 - 1000,
      endTime: 6_000_000 + 1 + 1000,
    });
    expect(backfillRequests(rows, "session", { rate: 1, cap: 1, padUs: 0 })).toEqual([
      expect.objectContaining({ targetId: "t1", sessionId: "t1", traceId: "t1" }),
    ]);
  });

  it("groups matched spans into targets at the job's scope", () => {
    const sql = backfillTargetsSql("llm", "gen_ai_agent_name = 'a'", "session", 50);
    expect(sql).toContain("SELECT session_id AS target_id");
    expect(sql).toContain("WHERE session_id IS NOT NULL AND (gen_ai_agent_name = 'a')");
    expect(sql).toContain("GROUP BY session_id\nLIMIT 50");
  });
});

describe("spend SQL and budget state (AIO-24)", () => {
  it("counts matched targets per day at the job's scope", () => {
    const sql = matchedPerDaySql("default", "", "trace");
    expect(sql).toContain(
      `SELECT histogram(_timestamp, '1 day') AS day, COUNT(DISTINCT "trace_id")`,
    );
    expect(sql).not.toContain("WHERE");
  });

  it("prices judges and jobs from their own _evaluator spans", () => {
    expect(judgeHistorySql(["s'1"])).toContain("attributes_scorer_id IN ('s''1')");
    expect(judgeHistorySql(["s1"])).toContain("attributes_status = 'success'");
    expect(spendTodaySql(["j1", "j2"])).toContain(
      "SUM(gen_ai_usage_cost) AS spend\nFROM \"_evaluator\"\nWHERE attributes_job_id IN ('j1', 'j2')",
    );
  });

  it("finds 00:00 UTC", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(utcDayStartMs(Date.UTC(2026, 9, 29, 17, 48))).toBe(Date.UTC(2026, 9, 29));
    expect(utcDayStartMs(3 * day)).toBe(3 * day);
  });

  it("tells a budget pause from a user pause", () => {
    const job: any = { status: "paused", budget: { dailyUsd: 5, onReach: "pause", pausedAt: 1 } };
    expect(isBudgetPaused(job)).toBe(true);
    expect(isBudgetPaused({ ...job, budget: { dailyUsd: 5, onReach: "pause" } })).toBe(false);
    expect(isBudgetPaused({ ...job, status: "active" })).toBe(false);
  });

  it("formats day amounts and sub-cent amounts", () => {
    expect(formatUsd(5)).toBe("$5.00");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0016)).toBe("$0.0016");
  });
});
