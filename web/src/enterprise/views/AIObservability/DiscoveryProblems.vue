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
  DiscoveryProblems — Discovery's "Problem first" view of traces (AIO-30):
  ranked by what the spans show (failures, tool loops, cost and latency
  outliers, unpriced spend), with scored rows as the last tier, so an org with
  no eval job still gets a list. Each row says why it is listed. An empty list
  names every check that ran, so "nothing here" reads apart from "nothing
  measured".
-->
<template>
  <div class="flex min-h-0 flex-1 flex-col gap-2 p-2" data-test="ai-discovery-problems">
    <div class="flex flex-wrap items-center gap-2">
      <OSelect
        v-model="stream"
        :options="availableStreams.map((s) => ({ value: s, label: raw(s) }))"
        :label="t('llmAttribution.users.stream')"
        label-position="inside"
        size="sm"
        width="sm"
        data-test="ai-discovery-problems-stream"
      />
      <OSelect
        v-model="agentName"
        :options="agentNames.map((a) => ({ value: a, label: raw(a) }))"
        :label="t('llmAttribution.users.agent')"
        :placeholder="t('llmInsightsDrill.all')"
        label-position="inside"
        clearable
        size="sm"
        width="sm"
        data-test="ai-discovery-problems-agent"
      />
      <OToggleGroup
        :model-value="tier"
        data-test="ai-discovery-problems-tiers"
        @update:model-value="onTier"
      >
        <OToggleGroupItem value="all" size="sm">{{ t("discoveryProblems.all") }}</OToggleGroupItem>
        <OToggleGroupItem
          v-for="tt in PROBLEM_TIERS"
          :key="tt"
          :value="tt"
          size="sm"
          :data-test="`ai-discovery-problems-tier-${tt}`"
        >
          {{ t(`discoveryProblems.tiers.${tt}`) }} {{ result.counts[tt] }}
        </OToggleGroupItem>
        <OToggleGroupItem value="score" size="sm" data-test="ai-discovery-problems-tier-score">
          {{ t("discoveryProblems.tiers.score") }} {{ scoredCount }}
        </OToggleGroupItem>
      </OToggleGroup>
    </div>

    <!-- Scores add to the ranking; they do not gate it. -->
    <div
      v-if="scoredCount === 0 && !loading"
      class="rounded-default bg-surface-subtle flex items-center gap-2 px-3 py-2"
      data-test="ai-discovery-problems-no-scores"
    >
      <OIcon name="info" size="sm" class="text-text-secondary" />
      <span class="text-compact text-text-secondary flex-1">
        {{ t("discoveryProblems.noScores", { agent: subject }) }}
      </span>
      <OButton
        variant="outline"
        size="sm"
        data-test="ai-discovery-problems-evaluate"
        @click="evalOpen = true"
      >
        {{ t("oneClickEval.evaluate", { agent: subject }) }}
      </OButton>
    </div>

    <!-- Empty means checked: every check and its count. -->
    <div
      v-if="!loading && result.checked > 0 && !result.rows.length && scoredCount === 0"
      class="flex flex-col items-center gap-2 py-8"
      data-test="ai-discovery-problems-empty"
    >
      <span class="text-text-heading text-sm font-semibold">
        {{ t("discoveryProblems.emptyTitle", { n: result.checked }) }}
      </span>
      <span class="text-compact text-text-secondary">{{ t("discoveryProblems.emptyBody") }}</span>
      <ul class="text-compact text-text-secondary flex flex-col gap-0.5">
        <li v-for="tt in PROBLEM_TIERS" :key="tt">
          {{ `${t(`discoveryProblems.checks.${tt}`)} · 0` }}
        </li>
        <li>{{ t("discoveryProblems.checks.score") }}</li>
      </ul>
    </div>

    <OTable
      v-else
      :data="visibleRows"
      :columns="columns"
      row-key="traceId"
      :loading="loading"
      :show-global-filter="false"
      show-index
      pagination="client"
      class="min-h-0 flex-1"
      :empty-message="
        failed ? t('discoveryProblems.loadFailed') : t('discoveryProblems.noneInTier')
      "
      data-test="ai-discovery-problems-table"
      @row-click="(row: ProblemRow) => emit('open', { traceId: row.traceId, ts: row.ts, stream })"
    >
      <template #cell-ts="{ row }">
        {{ timestampToTimezoneDate(row.ts, timezone, "HH:mm:ss") }}
      </template>
      <template #cell-input="{ row }">
        <OTruncatedText class="text-compact text-text-body">{{
          question(row.input)
        }}</OTruncatedText>
      </template>
      <template #cell-why="{ row }">
        <div class="flex min-w-0 flex-wrap items-center gap-1.5">
          <OBadge
            :variant="row.reasons[0].tier === 'failed' ? 'error-soft' : 'warning-soft'"
            size="sm"
          >
            {{ t(`discoveryProblems.tiers.${row.reasons[0].tier}`) }}
          </OBadge>
          <span class="text-2xs text-text-secondary">{{ reasonText(row.reasons[0]) }}</span>
          <OBadge v-for="r in row.reasons.slice(1)" :key="r.tier" variant="default-soft" size="sm">
            + {{ t(`discoveryProblems.tiers.${r.tier}`) }}
          </OBadge>
        </div>
      </template>
    </OTable>

    <OneClickEvalDialog v-model:open="evalOpen" :agent="agentName" :stream="stream" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useStore } from "vuex";
import { raw, useI18nTyped } from "@/types/i18n";
import OTable from "@/lib/core/Table/OTable.vue";
import { COL, type OTableColumnDef } from "@/lib/core/Table/OTable.types";
import OSelect from "@/lib/forms/Select/OSelect.vue";
import OToggleGroup from "@/lib/core/ToggleGroup/OToggleGroup.vue";
import OToggleGroupItem from "@/lib/core/ToggleGroup/OToggleGroupItem.vue";
import OButton from "@/lib/core/Button/OButton.vue";
import OIcon from "@/lib/core/Icon/OIcon.vue";
import OBadge from "@/lib/core/Badge/OBadge.vue";
import OTruncatedText from "@/lib/core/Typography/OTruncatedText.vue";
import OneClickEvalDialog from "@/enterprise/components/onlineEvals/OneClickEvalDialog.vue";
import useStreams from "@/composables/useStreams";
import { useLlmPageScope } from "@/enterprise/composables/useLlmPageScope";
import { useLLMStreamQuery } from "@/plugins/traces/composables/useLLMStreamQuery";
import { messagesFromInput } from "@/plugins/traces/threadView.utils";
import { formatTokens } from "@/utils/llmUtils";
import { formatTimeWithSuffix } from "@/utils/zincutils";
import { timestampToTimezoneDate } from "@/utils/timezone";
import {
  PROBLEM_TIERS,
  problemTracesSql,
  rankProblems,
  toolLoopsSql,
  type ProblemReason,
  type ProblemRow,
  type ProblemTier,
} from "./discoveryProblems";

const props = defineProps<{ startTime: number; endTime: number; scoredCount: number }>();
const emit = defineEmits<{
  (e: "open", target: { traceId: string; ts: number; stream: string }): void;
  (e: "show-scored"): void;
}>();

const { t } = useI18nTyped();
const store = useStore();
const { getStream } = useStreams(t);
const { executeQuery } = useLLMStreamQuery();
const {
  stream,
  agentName,
  availableStreams,
  agentNames,
  scope,
  load: loadScope,
} = useLlmPageScope(t);

const timezone = computed(() => store.state.timezone || "UTC");
const tier = ref<ProblemTier | "all">("all");
// The Score tier is the existing scored list: the page shows it instead.
function onTier(v: unknown) {
  if (v === "score") emit("show-scored");
  else tier.value = (v as ProblemTier | "all") || "all";
}
const loading = ref(false);
const failed = ref(false);
const evalOpen = ref(false);
const result = ref<ReturnType<typeof rankProblems>>({
  rows: [],
  counts: { failed: 0, loop: 0, cost: 0, slow: 0, unpriced: 0 },
  checked: 0,
});
let seq = 0;

const subject = computed(() => agentName.value || stream.value);
const visibleRows = computed(() =>
  tier.value === "all"
    ? result.value.rows
    : result.value.rows.filter((r) => r.reasons.some((x) => x.tier === tier.value)),
);

const columns: OTableColumnDef[] = [
  {
    id: "ts",
    header: t("discoveryProblems.time"),
    size: COL.dateAbsolute,
    meta: { align: "left" },
  },
  {
    id: "rootOp",
    header: t("discoveryProblems.trace"),
    accessorKey: "rootOp",
    size: COL.name,
    meta: { align: "left" },
  },
  {
    id: "input",
    header: t("discoveryProblems.input"),
    size: COL.description,
    meta: { align: "left" },
  },
  { id: "why", header: t("discoveryProblems.why"), meta: { align: "left", flex: true } },
];

const question = (input: unknown) =>
  messagesFromInput(input).find((m) => m.role === "user" && m.content)?.content ?? "";

function reasonText(r: ProblemReason) {
  const d = r.detail;
  switch (r.tier) {
    case "failed":
      return t(
        d.where === "root"
          ? "discoveryProblems.why_failedRoot"
          : "discoveryProblems.why_failedTurn",
        {
          message: d.message || "—",
        },
      );
    case "loop":
      return t("discoveryProblems.why_loop", { tool: d.tool, calls: d.calls });
    case "cost":
      return t("discoveryProblems.why_cost", {
        cost: `$${Number(d.cost).toFixed(2)}`,
        factor: d.factor,
        median: `$${Number(d.median).toFixed(2)}`,
      });
    case "slow":
      return t("discoveryProblems.why_slow", {
        duration: formatTimeWithSuffix(Number(d.durationUs)),
        factor: d.factor,
        median: formatTimeWithSuffix(Number(d.medianUs)),
      });
    case "unpriced":
      return t("discoveryProblems.why_unpriced", {
        tokens: formatTokens(Number(d.tokens)),
        model: d.model || "—",
      });
  }
}

async function load() {
  await loadScope(props.startTime, props.endTime);
  if (!stream.value) return;
  const mine = ++seq;
  loading.value = true;
  failed.value = false;
  try {
    const schema = await getStream(stream.value, "traces", true).catch(() => null);
    const names = new Set((schema?.schema ?? []).map((f: any) => f.name));
    const [traces, loops] = await Promise.all([
      executeQuery(
        problemTracesSql(stream.value, scope.value, {
          statusMessage: names.has("status_message"),
          costStatus: names.has("gen_ai_usage_cost_status"),
        }),
        props.startTime,
        props.endTime,
      ),
      executeQuery(toolLoopsSql(stream.value, scope.value), props.startTime, props.endTime).catch(
        () => [],
      ),
    ]);
    if (mine === seq) result.value = rankProblems(traces as any[], loops as any[]);
  } catch (e) {
    if (mine !== seq) return;
    failed.value = true;
    console.error("[Discovery problems] fetch error", e);
  } finally {
    if (mine === seq) loading.value = false;
  }
}

watch(() => [props.startTime, props.endTime, stream.value, agentName.value], load, {
  immediate: true,
});
defineExpose({ refresh: load });
</script>
