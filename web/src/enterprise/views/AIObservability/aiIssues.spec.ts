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
  clusterIssues,
  costSpikeIssues,
  errorClass,
  failureIssues,
  issueState,
  latestDispositions,
  rootCausePrompt,
  ruleIssues,
} from "./aiIssues";

const hit = (trace: string, over: Record<string, unknown> = {}) => ({
  trace_id: trace,
  agent: "research-agent",
  tool: "web_search",
  calls: 12,
  first_ts: 100,
  last_ts: 200,
  session: `s-${trace}`,
  user_id: "u1",
  ...over,
});

describe("AI issues (AIO-33..36)", () => {
  it("groups rule hits by rule, agent and tool, worst trace first", () => {
    const [issue] = ruleIssues([hit("t1", { calls: 12 }), hit("t2", { calls: 15 })], []);
    expect(issue).toMatchObject({
      key: "rule:loop:research-agent:web_search",
      kind: "loop",
      magnitude: 15,
      worstTraceId: "t2",
      sessions: 2,
      users: 1,
    });
    expect(issue.traceIds).toEqual(["t1", "t2"]);
  });

  it("groups failures by a normalized error class", () => {
    expect(errorClass("429 from the provider after 3 retries")).toBe(
      "429 from the provider after # retries",
    );
    expect(errorClass("timeout after 30 s")).toBe("timeout after # s");
    const issues = failureIssues([
      { trace_id: "a", agent: "x", error_message: "429 after 3 retries", cost: 1 },
      { trace_id: "b", agent: "x", error_message: "429 after 4 retries", cost: 2 },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].spend).toBe(3);
  });

  it("merges a rule cluster and a failure cluster that share most traces", () => {
    const rule = ruleIssues([hit("t1"), hit("t2")], []);
    const failure = failureIssues([
      { trace_id: "t1", agent: "research-agent", error_message: "429", cost: 1 },
      { trace_id: "t2", agent: "research-agent", error_message: "429", cost: 1 },
    ]);
    const [merged, ...rest] = clusterIssues([...rule, ...failure]);
    expect(rest).toEqual([]);
    expect(merged.sources).toEqual(["rule", "failure"]);
    expect(merged.kind).toBe("loop");
  });

  it("flags an agent whose cost per trace doubled, above the floor", () => {
    const [spike] = costSpikeIssues([
      { agent: "omp", period: "before", traces: 10, cost: 2 },
      { agent: "omp", period: "now", traces: 10, cost: 5 },
      { agent: "calm", period: "before", traces: 10, cost: 2 },
      { agent: "calm", period: "now", traces: 10, cost: 2.5 },
    ]);
    expect(spike).toMatchObject({ key: "cost_spike:omp", magnitude: 2.5 });
  });

  it("reopens a fixed issue seen again, and honours mutes until they end", () => {
    const issue = { ...ruleIssues([hit("t1")], [])[0], lastSeen: 500 };
    const decided = latestDispositions([
      { issue_key: issue.key, status: "muted", at: 100, until: 1000 },
      { issue_key: issue.key, status: "fixed", at: 400 },
    ]);
    expect(issueState(issue, decided.get(issue.key), 600)).toBe("open");
    expect(issueState({ ...issue, lastSeen: 300 }, decided.get(issue.key), 600)).toBe("closed");
    expect(issueState(issue, { status: "muted", at: 100, until: 1000 }, 600)).toBe("muted");
    expect(issueState(issue, { status: "muted", at: 100, until: 1000 }, 2000)).toBe("open");
    expect(issueState(issue, { status: "dismissed", at: 1 }, 2000)).toBe("closed");
  });

  it("asks O2 AI to look past the AI spans, with example traces", () => {
    const prompt = rootCausePrompt(ruleIssues([hit("t1")], [])[0], "default", "1d");
    expect(prompt).toContain('agent "research-agent" calls the tool "web_search" 12+ times');
    expect(prompt).toContain("for example t1");
    expect(prompt).toContain("logs, metrics, Kubernetes state and recent deploys");
  });
});
