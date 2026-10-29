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
import { compareWindows, introducedClasses, watchPair, type WindowMeasures } from "./releaseWatch";

const m = (over: Partial<WindowMeasures>): WindowMeasures => ({
  traces: 1000,
  failed: 30,
  sessions: 300,
  cost: 600,
  p95Us: 38_000_000,
  ...over,
});

describe("release watch (AIO-39)", () => {
  it("compares the newest version with the one before it", () => {
    const pair = watchPair([
      { name: "omp", version: "18.8.5", first_seen: 1 } as any,
      { name: "omp", version: "18.8.6", first_seen: 5 } as any,
      { name: "omp", version: "18.8.4", first_seen: 0 } as any,
    ]);
    expect(pair?.next.version).toBe("18.8.6");
    expect(pair?.prev.version).toBe("18.8.5");
    expect(watchPair([{ name: "omp", version: "1", first_seen: 1 } as any])).toBeNull();
  });

  it("calls a failure-rate rise a regression only beyond noise and 10%", () => {
    const [fr] = compareWindows(m({}), m({ failed: 64 }));
    expect(fr.verdict).toBe("regressed");
    expect(compareWindows(m({}), m({ failed: 31 }))[0].verdict).toBe("nochange");
  });

  it("flags cost per session on large arms, indicative on small ones", () => {
    expect(compareWindows(m({}), m({ cost: 1300 }))[1].verdict).toBe("regressed");
    expect(compareWindows(m({ sessions: 10 }), m({ sessions: 10, cost: 1300 }))[1].verdict).toBe(
      "indicative",
    );
  });

  it("names the failure classes the new version introduced", () => {
    const out = introducedClasses(["429 a"], ["tool timeout 3", "tool timeout 4", "429 b"], (s) =>
      s.replace(/\d+/g, "#").replace(/ [ab]$/, ""),
    );
    expect(out).toEqual([{ cls: "tool timeout #", traces: 2 }]);
  });
});
