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
import { rankProblems } from "./discoveryProblems";

const trace = (id: string, over: Record<string, unknown> = {}) => ({
  trace_id: id,
  ts: 1000,
  cost: 0.1,
  duration_ns: 2_000_000_000,
  failed_root: 0,
  failed_turn: 0,
  unpriced_tokens: 0,
  ...over,
});

describe("rankProblems (AIO-30)", () => {
  it("ranks failures, loops, outliers and unpriced spend, worst tier first", () => {
    const steady = Array.from({ length: 10 }, (_, i) => trace(`ok-${i}`));
    const { rows, counts, checked } = rankProblems(
      [
        ...steady,
        trace("unpriced", { unpriced_tokens: 182000, unpriced_model: "acme" }),
        trace("costly", { cost: 1.84 }),
        trace("slow", { duration_ns: 48_000_000_000 }),
        trace("failed", { failed_turn: 1, error_message: "429" }),
        trace("loop"),
      ],
      [{ trace_id: "loop", tool: "web_search", calls: 12 }],
    );
    expect(rows.map((r) => r.traceId)).toEqual(["failed", "loop", "costly", "slow", "unpriced"]);
    expect(counts).toEqual({ failed: 1, loop: 1, cost: 1, slow: 1, unpriced: 1 });
    expect(checked).toBe(15);
    expect(rows[2].reasons[0].detail).toMatchObject({ cost: 1.84, factor: 18 });
  });

  it("lists no outlier for a steady agent or below the floors", () => {
    const steady = Array.from({ length: 6 }, (_, i) => trace(`t-${i}`, { cost: 0.01 }));
    // 10× the median but under the $0.50 floor.
    const { rows } = rankProblems([...steady, trace("cheap", { cost: 0.1 })], []);
    expect(rows).toEqual([]);
  });

  it("keeps the other reasons of a row as extra badges", () => {
    const base = Array.from({ length: 6 }, (_, i) => trace(`t-${i}`));
    const { rows } = rankProblems([...base, trace("both", { failed_root: 1, cost: 2 })], []);
    expect(rows[0].reasons.map((r) => r.tier)).toEqual(["failed", "cost"]);
  });
});
