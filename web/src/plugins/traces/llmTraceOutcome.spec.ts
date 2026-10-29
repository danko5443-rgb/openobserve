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
import { TRACE_FAILED_SQL, traceOutcome, traceOutcomesSql } from "./llmTraceOutcome";

describe("traceOutcome (AIO-06)", () => {
  it("fails a trace whose root span or last LLM turn failed", () => {
    expect(traceOutcome({ failed_root: 1, failed_turn: 0, error_spans: 1 })).toBe("failed");
    expect(traceOutcome({ failed_root: 0, failed_turn: 1, error_spans: 1 })).toBe("failed");
  });

  it("calls a trace with only errors the agent got past recovered", () => {
    expect(traceOutcome({ failed_root: 0, failed_turn: 0, error_spans: 3 })).toBe("recovered");
    expect(traceOutcome({ failed_root: 0, failed_turn: 0, error_spans: 0 })).toBe("ok");
  });
});

describe("failure SQL", () => {
  it("leaves the root out of the turns, since it always ends last", () => {
    expect(TRACE_FAILED_SQL).toContain(
      "AND NOT (reference_parent_span_id IS NULL OR reference_parent_span_id = '') AND span_status = 'ERROR' THEN end_time END)",
    );
  });

  it("quotes trace ids and appends the scope predicate", () => {
    const sql = traceOutcomesSql("default", ["a'b", "c"], "gen_ai_agent_name = 'omp'");
    expect(sql).toContain("trace_id IN ('a''b', 'c')");
    expect(sql).toContain("AND gen_ai_agent_name = 'omp' GROUP BY trace_id");
  });
});
