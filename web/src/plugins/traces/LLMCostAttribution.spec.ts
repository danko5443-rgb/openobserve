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

const executeQuery = vi.fn();

vi.mock("./composables/useLLMStreamQuery", () => ({
  useLLMStreamQuery: () => ({ executeQuery, cancelAll: vi.fn() }),
}));

vi.mock("@/composables/useStreams", () => ({
  default: () => ({
    getStream: vi.fn(async () => ({ schema: [{ name: "tenant_id" }, { name: "feature_name" }] })),
  }),
}));

vi.mock("vuex", () => ({
  useStore: () => ({ state: { selectedOrganization: { identifier: "o" } } }),
}));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("./LLMPanelCard.vue", () => ({
  default: { name: "LLMPanelCard", template: `<div><slot name="actions" /><slot /></div>` },
}));

vi.mock("@/lib/core/Table/OTable.vue", () => ({
  default: {
    name: "OTable",
    props: ["data"],
    template: `<div><div v-for="row in data" :key="row.key" :data-test="'row-' + row.key">
      <slot name="cell-value" :row="row" /></div></div>`,
  },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import LLMCostAttribution from "./LLMCostAttribution.vue";

const hit = (v: string, cost: number) => ({ v, cost, tokens: cost * 100, traces: 1 });
const segment = (w: any, key: string) => w.find(`[data-test="o-segmented-bar-segment-${key}"]`);
const dot = (w: any, key: string) => w.find(`[data-test="row-${key}"] [aria-hidden="true"]`);

async function mountPanel() {
  const wrapper = mount(LLMCostAttribution, {
    props: { stream: "llm", scope: "", startTime: 1, endTime: 2 },
    global: { stubs: { OButton: true } },
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LLMCostAttribution share bar", () => {
  it("draws a segment per value sized by share, leaving Unattributed as the empty track", async () => {
    executeQuery.mockResolvedValue([hit("acme", 6), hit("globex", 3), hit("", 1)]);
    const wrapper = await mountPanel();

    const acme = segment(wrapper, "v:acme");
    expect(acme.attributes("style")).toContain("width: 60%");
    expect(acme.attributes("style")).toMatch(/var\(--color-chart-series-\d+\)/);
    expect(segment(wrapper, "none").exists()).toBe(false);
    // The table is the legend: each row's dot is its segment's colour.
    expect(dot(wrapper, "v:acme").element.style.backgroundColor).toBe(
      acme.element.style.backgroundColor,
    );
    expect(dot(wrapper, "none").classes()).toContain("bg-border-default");
  });

  it("keeps a value's colour when the other values change", async () => {
    executeQuery.mockResolvedValue([hit("acme", 6), hit("globex", 3)]);
    const wrapper = await mountPanel();
    const before = segment(wrapper, "v:acme").element.style.backgroundColor;

    executeQuery.mockResolvedValue([hit("initech", 9), hit("acme", 1)]);
    await wrapper.setProps({ scope: "x = 1" });
    await flushPromises();

    expect(segment(wrapper, "v:acme").element.style.backgroundColor).toBe(before);
  });
});
