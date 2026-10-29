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
  Issues (AIO-33..36) — AI failures, rule hits, cost spikes, unpriced models and
  unhealthy scores in one list, one row per cause, impact first. "Explain" hands
  the issue to O2 AI for a cited root cause that can reach past the AI spans
  into logs, metrics, pods and deploys. Triage (Mark fixed, Not a problem,
  Mute) lives in the issue drawer.
-->
<template>
  <AiPageShell
    data-test="ai-issues"
    :title="t('aiIssues.title')"
    :subtitle="t('aiIssues.subtitle')"
    icon="report-problem"
    :date-state="dateState"
    :last-run-at="lastRunAt"
    :is-loading="loading"
    @date-change="onDateChange"
    @refresh="reload"
  >
    <div class="px-page-edge flex min-h-0 flex-1 flex-col gap-2 py-2">
      <div class="flex flex-wrap items-center gap-2">
        <OSelect
          v-model="stream"
          :options="availableStreams.map((s) => ({ value: s, label: raw(s) }))"
          :label="t('llmAttribution.users.stream')"
          label-position="inside"
          size="sm"
          width="sm"
          data-test="ai-issues-stream"
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
          data-test="ai-issues-agent"
        />
        <OToggleGroup
          :model-value="state"
          data-test="ai-issues-state"
          @update:model-value="(v) => (state = v as IssueState)"
        >
          <OToggleGroupItem
            v-for="s in STATES"
            :key="s"
            :value="s"
            size="sm"
            :data-test="`ai-issues-state-${s}`"
          >
            {{ t(`aiIssues.states.${s}`) }} {{ countByState[s] }}
          </OToggleGroupItem>
        </OToggleGroup>
        <OToggleGroup
          :model-value="source"
          data-test="ai-issues-source"
          @update:model-value="(v) => (source = v as IssueSource | 'all')"
        >
          <OToggleGroupItem value="all" size="sm">{{
            t("discoveryProblems.all")
          }}</OToggleGroupItem>
          <OToggleGroupItem
            v-for="s in ISSUE_SOURCES"
            :key="s"
            :value="s"
            size="sm"
            :data-test="`ai-issues-source-${s}`"
          >
            {{ t(`aiIssues.sources.${s}`) }} {{ countBySource[s] }}
          </OToggleGroupItem>
        </OToggleGroup>
      </div>

      <OTable
        :data="visible"
        :columns="columns"
        row-key="key"
        :loading="loading"
        :show-global-filter="false"
        pagination="client"
        class="min-h-0 flex-1"
        :empty-message="t(`aiIssues.empty.${state}`)"
        data-test="ai-issues-table"
        @row-click="openIssue"
      >
        <template #cell-issue="{ row }">
          <div class="flex min-w-0 flex-col gap-0.5">
            <OTruncatedText class="text-compact text-text-body font-medium">{{
              issueTitle(row)
            }}</OTruncatedText>
            <div class="flex flex-wrap items-center gap-1">
              <OBadge v-for="s in row.sources" :key="s" variant="default-soft" size="sm">
                {{ t(`aiIssues.sources.${s}`) }}
              </OBadge>
              <span class="text-2xs text-text-secondary">
                {{
                  t("aiIssues.since", {
                    at: timestampToTimezoneDate(row.firstSeen, timezone, "MMM d HH:mm"),
                  })
                }}
              </span>
            </div>
          </div>
        </template>
        <template #cell-traces="{ row }">{{ row.traceIds.length || "—" }}</template>
        <template #cell-spend="{ row }">{{
          row.spend ? `$${row.spend.toFixed(2)}` : "—"
        }}</template>
        <template #cell-cause="{ row }">
          <span @click.stop>
            <OButton
              v-if="row.kind === 'unpriced'"
              variant="outline"
              size="xs"
              :data-test="`ai-issues-add-price-${row.key}`"
              @click="addPrice"
            >
              {{ t("aiIssues.addPrice") }}
            </OButton>
            <OButton
              v-else
              variant="outline"
              size="xs"
              icon-left="auto-awesome"
              :data-test="`ai-issues-explain-${row.key}`"
              @click="explain(row)"
            >
              {{ t("aiIssues.explain") }}
            </OButton>
          </span>
        </template>
      </OTable>
    </div>

    <IssueDrawer
      v-model:open="drawerOpen"
      :issue="selected"
      :state="selected ? stateOf(selected) : 'open'"
      :stream="stream"
      :title="selected ? issueTitle(selected) : raw('')"
      :closed-by-rule="closedByRule"
      @explain="explain"
      @decide="decide"
    />
  </AiPageShell>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useStore } from "vuex";
import { raw, useI18nTyped, type I18nText } from "@/types/i18n";
import AiPageShell from "@/enterprise/components/AIObservability/AiPageShell.vue";
import OTable from "@/lib/core/Table/OTable.vue";
import { COL, type OTableColumnDef } from "@/lib/core/Table/OTable.types";
import OSelect from "@/lib/forms/Select/OSelect.vue";
import OToggleGroup from "@/lib/core/ToggleGroup/OToggleGroup.vue";
import OToggleGroupItem from "@/lib/core/ToggleGroup/OToggleGroupItem.vue";
import OButton from "@/lib/core/Button/OButton.vue";
import OBadge from "@/lib/core/Badge/OBadge.vue";
import OTruncatedText from "@/lib/core/Typography/OTruncatedText.vue";
import { toast } from "@/lib/feedback/Toast/useToast";
import http from "@/services/http";
import onlineEvalsService from "@/services/online-evals.service";
import useStreams from "@/composables/useStreams";
import { useAiDateController } from "@/enterprise/composables/useAiDateController";
import { useLlmPageScope } from "@/enterprise/composables/useLlmPageScope";
import { useLLMStreamQuery } from "@/plugins/traces/composables/useLLMStreamQuery";
import { timestampToTimezoneDate } from "@/utils/timezone";
import IssueDrawer from "./IssueDrawer.vue";
import { pricingGapsRoute } from "@/plugins/traces/llmDataTrust.utils";
import {
  DISPOSITIONS_STREAM,
  FAILING_MIN_CALLS,
  ISSUE_SOURCES,
  MUTE_DAYS,
  RULE_MIN_CALLS,
  clusterIssues,
  costSpikeIssues,
  costWindowsSql,
  dispositionsSql,
  failedTracesSql,
  failureIssues,
  issueState,
  latestDispositions,
  rootCausePrompt,
  ruleHitsSql,
  ruleIssues,
  scoreIssues,
  unpricedIssues,
  unpricedModelsSql,
  type Disposition,
  type DispositionStatus,
  type Issue,
  type IssueSource,
  type IssueState,
} from "./aiIssues";

defineOptions({ name: "AIIssuesPage" });
const emit = defineEmits<{ (e: "sendToAiChat", value: unknown, append?: boolean): void }>();

const STATES: IssueState[] = ["open", "muted", "closed"];

const { t } = useI18nTyped();
const store = useStore();
const router = useRouter();
const { getStream } = useStreams(t);
const { executeQuery } = useLLMStreamQuery();
const {
  dateState,
  timeRange,
  onDateChange: onDateStateChange,
  mountResolve,
} = useAiDateController();
const {
  stream,
  agentName,
  availableStreams,
  agentNames,
  scope,
  load: loadScope,
} = useLlmPageScope(t);

const org = () => store.state.selectedOrganization?.identifier ?? "";
const timezone = computed(() => store.state.timezone || "UTC");
const issues = ref<Issue[]>([]);
const dispositions = ref<Map<string, Disposition>>(new Map());
const loading = ref(false);
const lastRunAt = ref<number | null>(null);
const state = ref<IssueState>("open");
const route = useRoute();
// Agent Behavior's Issues card links here filtered to Source: Rule.
const source = ref<IssueSource | "all">(
  ISSUE_SOURCES.includes(route.query.source as IssueSource)
    ? (route.query.source as IssueSource)
    : "all",
);
const drawerOpen = ref(false);
const selected = ref<Issue | null>(null);
let seq = 0;

const stateOf = (i: Issue) => issueState(i, dispositions.value.get(i.key), Date.now() * 1000);
const countByState = computed(() =>
  Object.fromEntries(STATES.map((s) => [s, issues.value.filter((i) => stateOf(i) === s).length])),
);
const countBySource = computed(() =>
  Object.fromEntries(
    ISSUE_SOURCES.map((s) => [
      s,
      issues.value.filter((i) => stateOf(i) === state.value && i.sources.includes(s)).length,
    ]),
  ),
);
const visible = computed(() =>
  issues.value.filter(
    (i) =>
      stateOf(i) === state.value && (source.value === "all" || i.sources.includes(source.value)),
  ),
);
// The false-positive share behind "Is this rule right?" (AIO-34).
const closedByRule = computed(() => {
  const rule = issues.value.filter((i) => i.sources.includes("rule"));
  const decided = rule.filter((i) => dispositions.value.has(i.key));
  return {
    dismissed: decided.filter((i) => dispositions.value.get(i.key)?.status === "dismissed").length,
    closed: decided.length,
  };
});

const columns: OTableColumnDef[] = [
  { id: "issue", header: t("aiIssues.issue"), meta: { align: "left", flex: true } },
  { id: "traces", header: t("llmAttribution.traces"), size: COL.count, meta: { align: "right" } },
  {
    id: "sessions",
    header: t("llmAttribution.users.sessionsCol"),
    accessorKey: "sessions",
    size: COL.count,
    meta: { align: "right" },
  },
  { id: "spend", header: t("aiIssues.spend"), size: COL.price, meta: { align: "right" } },
  { id: "cause", header: t("aiIssues.rootCause"), size: COL.type, meta: { align: "left" } },
];

function issueTitle(i: Issue): I18nText {
  switch (i.kind) {
    case "loop":
      return t("aiIssues.titles.loop", { agent: i.agent, tool: i.tool, calls: i.magnitude });
    case "failing_tool":
      return t("aiIssues.titles.failingTool", { agent: i.agent, tool: i.tool });
    case "failure":
      return t("aiIssues.titles.failure", { agent: i.agent || "—", error: i.errorClass || "—" });
    case "cost_spike":
      return t("aiIssues.titles.costSpike", { agent: i.agent, factor: i.magnitude });
    case "unpriced":
      return t("aiIssues.titles.unpriced", { model: i.model });
    case "score_drop":
      return t("aiIssues.titles.scoreDrop", { config: i.config, share: i.magnitude });
  }
}

async function runOrEmpty(sql: string, start: number, end: number): Promise<any[]> {
  try {
    return (await executeQuery(sql, start, end)) as any[];
  } catch {
    return [];
  }
}

async function reload() {
  const { startTime, endTime } = timeRange.value;
  await loadScope(startTime, endTime);
  if (!stream.value) return;
  const mine = ++seq;
  loading.value = true;
  try {
    const schema = await getStream(stream.value, "traces", true).catch(() => null);
    const names = new Set((schema?.schema ?? []).map((f: any) => f.name));
    const s = scope.value;
    const span = endTime - startTime;
    const [loops, failing, failed, windows, unpriced, decisions, quality] = await Promise.all([
      runOrEmpty(ruleHitsSql(stream.value, s, false, RULE_MIN_CALLS), startTime, endTime),
      runOrEmpty(ruleHitsSql(stream.value, s, true, FAILING_MIN_CALLS), startTime, endTime),
      runOrEmpty(failedTracesSql(stream.value, s, names.has("status_message")), startTime, endTime),
      runOrEmpty(costWindowsSql(stream.value, s, startTime), startTime - span, endTime),
      names.has("gen_ai_usage_cost_status")
        ? runOrEmpty(unpricedModelsSql(stream.value, s), startTime, endTime)
        : Promise.resolve([]),
      runOrEmpty(dispositionsSql(), startTime - 30 * 86_400_000_000, Date.now() * 1000),
      onlineEvalsService.quality
        .list(org(), {
          start_time: startTime,
          end_time: endTime,
          ...(agentName.value ? { agent_name: agentName.value } : {}),
        })
        .catch(() => []),
    ]);
    if (mine !== seq) return;
    issues.value = clusterIssues([
      ...ruleIssues(loops, failing),
      ...failureIssues(failed),
      ...costSpikeIssues(windows),
      ...unpricedIssues(unpriced),
      ...scoreIssues(quality, agentName.value ?? ""),
    ]);
    dispositions.value = latestDispositions(decisions);
  } finally {
    if (mine === seq) {
      loading.value = false;
      lastRunAt.value = Date.now();
    }
  }
}

function openIssue(issue: Issue) {
  selected.value = issue;
  drawerOpen.value = true;
}

// A cited root cause from O2 AI: the issue and its traces, past the AI spans.
function explain(issue: Issue) {
  emit(
    "sendToAiChat",
    {
      query: raw(
        rootCausePrompt(
          issue,
          stream.value,
          String(dateState.value.relativeTimePeriod ?? "custom"),
        ),
      ),
      autoSend: true,
    },
    false,
  );
}

function addPrice() {
  router.push(pricingGapsRoute(stream.value, org()));
}

// One record per decision; read back with the issues (AIO-34). Mute lasts MUTE_DAYS.
async function decide(issue: Issue, status: DispositionStatus) {
  const nowUs = Date.now() * 1000;
  try {
    await http().post(`/api/${org()}/${DISPOSITIONS_STREAM}/_json`, [
      {
        issue_key: issue.key,
        status,
        until: status === "muted" ? nowUs + MUTE_DAYS * 86_400_000_000 : 0,
        by_user: store.state.userInfo?.email ?? "",
      },
    ]);
    dispositions.value = new Map(dispositions.value).set(issue.key, {
      status,
      at: nowUs,
      until: status === "muted" ? nowUs + MUTE_DAYS * 86_400_000_000 : undefined,
    });
    drawerOpen.value = false;
    toast({ variant: "success", message: t(`aiIssues.decided.${status}`) });
  } catch (e: any) {
    toast({
      variant: "error",
      message: t("aiIssues.decideFailed", {
        reason: e?.response?.data?.message ?? String(e?.message ?? e),
      }),
    });
  }
}

async function onDateChange(value: any) {
  onDateStateChange(value);
  await nextTick();
  reload();
}

watch([stream, agentName], reload);
onMounted(() => {
  mountResolve();
  reload();
});
</script>
