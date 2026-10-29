<!-- Copyright 2026 OpenObserve Inc.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
-->

<!--
  AiIssuesCard — rule hits on Agent Behavior (AIO-33): one row per rule, agent
  and tool from the ai-agents pack's SQL, with its traces and last time seen.
  "View all in Issues" opens the Issues page filtered to Source: Rule, where
  each issue is triaged.
-->
<template>
  <div
    class="bg-card-glass-bg rounded-default border-border-default flex flex-col overflow-hidden border"
    data-test="agent-behavior-issues-card"
  >
    <PanelSectionHeader
      :title="t('aiIssues.card.title')"
      :hint="t('aiIssues.card.hint')"
      icon="report-problem"
      tone="warning"
    >
      <template #actions>
        <OButton
          variant="outline"
          size="sm"
          data-test="agent-behavior-issues-view-all"
          @click="viewAll"
        >
          {{ t("aiIssues.card.viewAll") }}
        </OButton>
      </template>
    </PanelSectionHeader>
    <OTable
      :data="issues"
      :columns="columns"
      row-key="key"
      :loading="loading"
      :frame="false"
      :show-global-filter="false"
      pagination="none"
      :empty-message="t('aiIssues.card.none')"
      data-test="agent-behavior-issues-table"
    >
      <template #cell-kind="{ row }">
        {{
          t(
            row.kind === "loop"
              ? "aiAlertPack.rules.repeatedToolCalls.title"
              : "aiAlertPack.rules.repeatedFailingToolCalls.title",
          )
        }}
      </template>
      <template #cell-traces="{ row }">{{ row.traceIds.length }}</template>
      <template #cell-lastSeen="{ row }">
        {{ timestampToTimezoneDate(row.lastSeen, timezone, "MMM d HH:mm") }}
      </template>
    </OTable>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useStore } from "vuex";
import { useI18nTyped } from "@/types/i18n";
import OTable from "@/lib/core/Table/OTable.vue";
import { COL, type OTableColumnDef } from "@/lib/core/Table/OTable.types";
import OButton from "@/lib/core/Button/OButton.vue";
import PanelSectionHeader from "./PanelSectionHeader.vue";
import { useLLMStreamQuery } from "@/plugins/traces/composables/useLLMStreamQuery";
import { timestampToTimezoneDate } from "@/utils/timezone";
import { FAILING_MIN_CALLS, RULE_MIN_CALLS, ruleHitsSql, ruleIssues, type Issue } from "./aiIssues";

const props = defineProps<{
  sourceStream?: string;
  /** The agent in scope, by name; empty = every agent. */
  agentName?: string;
  startTime?: number;
  endTime?: number;
}>();

const { t } = useI18nTyped();
const store = useStore();
const router = useRouter();
const { executeQuery } = useLLMStreamQuery();
const timezone = computed(() => store.state.timezone || "UTC");
const issues = ref<Issue[]>([]);
const loading = ref(false);
let seq = 0;

const columns: OTableColumnDef[] = [
  { id: "kind", header: t("aiIssues.issue"), meta: { align: "left" } },
  {
    id: "agent",
    header: t("aiObservability.behavior.colAgent"),
    accessorKey: "agent",
    meta: { align: "left", autoWidth: true },
  },
  {
    id: "tool",
    header: t("aiObservability.behavior.colTool"),
    accessorKey: "tool",
    meta: { align: "left", autoWidth: true },
  },
  { id: "traces", header: t("llmAttribution.traces"), size: COL.count, meta: { align: "right" } },
  {
    id: "lastSeen",
    header: t("aiIssues.lastSeen"),
    size: COL.dateAbsolute,
    meta: { align: "left" },
  },
];

async function load() {
  if (!props.sourceStream || !props.startTime || !props.endTime) return;
  const mine = ++seq;
  loading.value = true;
  const scope = props.agentName
    ? `gen_ai_agent_name = '${props.agentName.replace(/'/g, "''")}'`
    : "";
  try {
    const [loops, failing] = await Promise.all([
      executeQuery(
        ruleHitsSql(props.sourceStream, scope, false, RULE_MIN_CALLS),
        props.startTime,
        props.endTime,
      ),
      executeQuery(
        ruleHitsSql(props.sourceStream, scope, true, FAILING_MIN_CALLS),
        props.startTime,
        props.endTime,
      ),
    ]);
    if (mine === seq) {
      issues.value = ruleIssues(loops as any[], failing as any[])
        .sort((a, b) => b.lastSeen - a.lastSeen)
        .slice(0, 5);
    }
  } catch {
    if (mine === seq) issues.value = [];
  } finally {
    if (mine === seq) loading.value = false;
  }
}

function viewAll() {
  router.push({
    name: "aiIssues",
    query: { org_identifier: store.state.selectedOrganization?.identifier, source: "rule" },
  });
}

watch(() => [props.sourceStream, props.agentName, props.startTime, props.endTime], load, {
  immediate: true,
});
</script>
