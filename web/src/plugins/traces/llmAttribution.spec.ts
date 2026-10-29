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
import { costByDimensionSql, coverageSql, toAttributionRows, usersSql } from "./llmAttribution";

describe("cost attribution (AIO-27)", () => {
  it("attributes a trace's whole cost to the value set on any of its spans", () => {
    const sql = costByDimensionSql("s", "tenant_id", "gen_ai_agent_name = 'a'");
    expect(sql).toContain("COALESCE(MAX(tenant_id), '') AS v");
    expect(sql).toContain("FROM \"s\" WHERE gen_ai_agent_name = 'a' GROUP BY trace_id");
  });

  it("keeps unattributed spend visible so the shares add up", () => {
    const out = toAttributionRows(
      [
        { v: "acme", cost: 6, tokens: 10, traces: 3 },
        { v: "", cost: 2, tokens: 4, traces: 1 },
        { v: "globex", cost: 1, tokens: 2, traces: 1 },
        { v: "initech", cost: 1, tokens: 2, traces: 1 },
      ],
      2,
    );
    expect(out.total).toBe(10);
    expect(out.rows.map((r) => r.value)).toEqual(["acme", "globex"]);
    expect(out.more).toMatchObject({ value: "1", cost: 1 });
    expect(out.unattributed).toMatchObject({ cost: 2, share: 0.2 });
    expect(out.attributedShare).toBe(0.8);
  });

  it("lists users without a tenant column and escapes the search", () => {
    const sql = usersSql("s", { scope: "", tenantColumn: null, search: "u_1%" });
    expect(sql).toContain("'' AS tenant");
    expect(sql).toContain("user_id LIKE '%u\\_1\\%%'");
  });

  it("counts the traces carrying each column, and still counts traces when the stream has none", () => {
    const sql = coverageSql("s", ["tenant_id"], "");
    expect(sql).toContain("SUM(tenant_id_set) AS tenant_id");
    expect(sql).toContain("GROUP BY trace_id");
    expect(coverageSql("s", [], "")).toBe(
      'SELECT COUNT(*) AS traces FROM (SELECT trace_id FROM "s" GROUP BY trace_id)',
    );
  });
});
