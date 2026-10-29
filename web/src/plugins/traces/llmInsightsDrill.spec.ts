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
import { filterOptionsSql, insightsFilterSql, splitPrompt, traceListSql } from "./llmInsightsDrill";
import { autoHistogramBucketMicros } from "./config/llmInsightsPanels";

const HOUR = 3_600_000_000;

describe("insights filters (AIO-26)", () => {
  it("narrows by trace, so a model filter keeps the trace's tool spans", () => {
    expect(insightsFilterSql("default", { model: "gpt-4o" })).toBe(
      `trace_id IN (SELECT trace_id FROM "default" WHERE gen_ai_response_model = 'gpt-4o')`,
    );
  });

  it("ANDs every set filter and escapes quotes", () => {
    const sql = insightsFilterSql("s", { user: "o'k", prompt: "sys@3" });
    expect(sql).toContain("user_id = 'o''k'");
    expect(sql).toContain("(gen_ai_prompt_name = 'sys' AND gen_ai_prompt_version = '3')");
    expect(sql.split(" AND trace_id IN").length).toBe(2);
    expect(insightsFilterSql("s", {})).toBe("");
  });

  it("splits a prompt at its last @ and allows no version", () => {
    expect(splitPrompt("a@b@2")).toEqual({ name: "a@b", version: "2" });
    expect(splitPrompt("plain")).toEqual({ name: "plain", version: "" });
    expect(insightsFilterSql("s", { prompt: "plain@" })).toContain("gen_ai_prompt_name = 'plain')");
  });

  it("offers filter values inside the agent scope", () => {
    expect(filterOptionsSql("s", "model", "gen_ai_agent_name = 'x'")).toContain(
      "WHERE gen_ai_response_model IS NOT NULL AND gen_ai_response_model != '' AND gen_ai_agent_name = 'x'",
    );
  });
});

describe("traceListSql", () => {
  it("selects the clicked series per trace and the outcome", () => {
    const sql = traceListSql(
      "s",
      {
        startTime: 0,
        endTime: 1,
        seriesSql: "gen_ai_response_model",
        seriesValue: "m",
        outcome: "recovered",
      },
      "gen_ai_agent_name = 'a'",
    );
    expect(sql).toContain("WHERE gen_ai_agent_name = 'a' GROUP BY trace_id HAVING");
    expect(sql).toContain("max(CASE WHEN gen_ai_response_model = 'm' THEN 1 ELSE 0 END) = 1");
    expect(sql).toContain("= 0 AND sum(CASE WHEN span_status = 'ERROR' THEN 1 ELSE 0 END) > 0");
    expect(sql).toMatch(/ORDER BY ts DESC LIMIT 50$/);
  });

  it("has no HAVING for a whole-window list", () => {
    expect(traceListSql("s", { startTime: 0, endTime: 1 }, "")).not.toContain("HAVING");
  });
});

describe("autoHistogramBucketMicros", () => {
  it("mirrors the backend's auto histogram widths", () => {
    expect(autoHistogramBucketMicros(0, 24 * HOUR)).toBe(HOUR);
    expect(autoHistogramBucketMicros(0, 3 * HOUR)).toBe(60_000_000);
    expect(autoHistogramBucketMicros(0, 15 * 60_000_000)).toBe(10_000_000);
    expect(autoHistogramBucketMicros(0, 30 * 24 * HOUR)).toBe(12 * HOUR);
  });
});
