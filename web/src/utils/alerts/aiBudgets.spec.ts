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
  budgetAlertPayload,
  budgetFromAlert,
  budgetSpend,
  budgetSql,
  budgetState,
  type BudgetDef,
} from "./aiBudgets";

const feature: BudgetDef = {
  name: "deep-research-daily",
  scope: "feature",
  value: "deep-research",
  limitUsd: 400,
  period: "day",
  stream: "default",
};

describe("budgets (AIO-38)", () => {
  it("groups spend by the scope's column, unaliased, so the SQL multi-alert accepts it", () => {
    expect(budgetSql(feature)).toBe(
      "SELECT feature_name, SUM(gen_ai_usage_cost) AS spent FROM \"default\" WHERE feature_name = 'deep-research' GROUP BY feature_name ORDER BY spent DESC",
    );
    const perSession = budgetSql({ ...feature, scope: "session", value: "", period: "hour" }, 100);
    expect(perSession).toContain(
      "WHERE gen_ai_conversation_id IS NOT NULL AND gen_ai_conversation_id != '' GROUP BY gen_ai_conversation_id ORDER BY spent DESC LIMIT 100",
    );
  });

  it("is one alert, warning at 80% and critical at 100% of each key's spend, readable back", () => {
    const alert = budgetAlertPayload(feature, {
      folderId: "f",
      destination: "litellm-hook",
      owner: "me",
      timezone: "UTC",
    });
    expect(alert.name).toBe("deep-research-daily");
    expect(alert.destinations).toEqual(["litellm-hook"]);
    expect(alert.query_condition.sql).not.toContain("HAVING");
    expect(alert.query_condition.aggregation).toMatchObject({
      having: { column: "spent", operator: ">=", value: 400 },
      warning_value: 320,
      multi_alert: true,
    });
    expect(alert.trigger_condition).toMatchObject({ operator: ">=", threshold: 1, period: 1440 });
    expect(alert.tags).toEqual(["pack:ai-budgets"]);
    expect(budgetFromAlert(alert)).toEqual(feature);
    expect(budgetFromAlert({ stream_name: "default", context_attributes: {} })).toBeNull();
  });

  it("states under, warning and over, and counts each-scope keys over", () => {
    expect(budgetState(100, 400)).toBe("under");
    expect(budgetState(330, 400)).toBe("warning");
    expect(budgetState(412, 400)).toBe("over");
    const each = budgetSpend({ ...feature, scope: "user", limitUsd: 25 }, [
      { budget_key: "a", spent: 30 },
      { budget_key: "b", spent: 10 },
    ]);
    expect(each).toEqual({ spent: 40, over: 1, largest: 30, keys: 2 });
  });
});
