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
  budgetAlertPayloads,
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
  it("limits one feature's spend, and each user's or session's separately", () => {
    expect(budgetSql(feature, 0.8)).toBe(
      "SELECT SUM(gen_ai_usage_cost) AS spent FROM \"default\" WHERE feature_name = 'deep-research' HAVING SUM(gen_ai_usage_cost) >= 320",
    );
    const perSession = budgetSql(
      { ...feature, scope: "session", value: "", limitUsd: 50, period: "hour" },
      1,
    );
    expect(perSession).toContain(
      "GROUP BY gen_ai_conversation_id HAVING SUM(gen_ai_usage_cost) >= 50",
    );
  });

  it("makes a warning at 80% and a budget signal at 100%, readable back", () => {
    const [warn, over] = budgetAlertPayloads(feature, {
      folderId: "f",
      warnDestination: "slack",
      signalDestination: "litellm-hook",
      owner: "me",
      timezone: "UTC",
    }) as any[];
    expect(warn.name).toBe("deep-research-daily_warn");
    expect(over.destinations).toEqual(["litellm-hook"]);
    expect(over.trigger_condition.period).toBe(1440);
    expect(over.tags).toEqual(["pack:ai-budgets"]);
    expect(budgetFromAlert({ ...over, alert_id: "a1" })).toMatchObject({
      name: "deep-research-daily",
      scope: "feature",
      limitUsd: 400,
      alertIds: ["a1"],
    });
    expect(budgetFromAlert(warn)).toBeNull();
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
