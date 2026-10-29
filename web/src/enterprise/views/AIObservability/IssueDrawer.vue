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
  IssueDrawer — one AI issue (AIO-33..36): impact first, the root cause handed
  to O2 AI, the evidence traces, and triage next to them: Mark fixed, Not a
  problem, Mute for 7 days. A rule issue also shows how often that rule was
  wrong and lets the threshold be tuned with a preview over the window, saved
  to the installed pack alert. "Turn this into a test" adds the worst trace to
  a dataset or starts an experiment.
-->
<template>
  <ODrawer
    :open="open"
    side="right"
    size="xl"
    :title="title"
    data-test="ai-issue-drawer"
    :primary-button-label="state === 'closed' ? undefined : t('aiIssues.markFixed')"
    primary-button-data-test="ai-issue-mark-fixed"
    :secondary-button-label="state === 'closed' ? undefined : t('aiIssues.notAProblem')"
    :neutral-button-label="state === 'open' ? t('aiIssues.mute', { days: MUTE_DAYS }) : undefined"
    @update:open="(v: boolean) => emit('update:open', v)"
    @click:primary="issue && emit('decide', issue, 'fixed')"
    @click:secondary="issue && emit('decide', issue, 'dismissed')"
    @click:neutral="issue && emit('decide', issue, 'muted')"
  >
    <div v-if="issue" class="flex flex-col gap-4 p-4">
      <div class="grid grid-cols-4 gap-2 max-md:grid-cols-2" data-test="ai-issue-impact">
        <div
          v-for="tile in tiles"
          :key="tile.label"
          class="rounded-default border-border-default border px-3 py-2"
        >
          <div class="text-2xs text-text-secondary font-semibold">{{ tile.label }}</div>
          <div class="text-text-heading text-lg font-bold">{{ tile.value }}</div>
        </div>
      </div>

      <section
        class="rounded-default border-border-default flex flex-col gap-2 border p-3"
        data-test="ai-issue-root-cause"
      >
        <div class="flex items-center justify-between gap-2">
          <span class="text-compact text-text-heading font-semibold">{{
            t("aiIssues.rootCause")
          }}</span>
          <OButton
            variant="primary"
            size="sm"
            icon-left="auto-awesome"
            data-test="ai-issue-explain"
            @click="emit('explain', issue)"
          >
            {{ t("aiIssues.explainWithAi") }}
          </OButton>
        </div>
        <span class="text-2xs text-text-secondary">{{ t("aiIssues.explainHelp") }}</span>
      </section>

      <section
        v-if="issue.traceIds.length"
        class="flex flex-col gap-1"
        data-test="ai-issue-evidence"
      >
        <span class="text-compact text-text-heading font-semibold">{{
          t("aiIssues.evidence")
        }}</span>
        <button
          v-for="id in issue.traceIds.slice(0, 8)"
          :key="id"
          type="button"
          class="text-compact text-text-link self-start font-mono hover:underline"
          :data-test="`ai-issue-trace-${id}`"
          @click="openTrace(id)"
        >
          {{ id }}<template v-if="id === issue.worstTraceId"> · {{ t("aiIssues.worst") }}</template>
        </button>
      </section>

      <!-- AIO-34: is this rule right, and where should it fire? -->
      <section
        v-if="issue.sources.includes('rule')"
        class="rounded-default border-border-default flex flex-col gap-2 border p-3"
        data-test="ai-issue-tuning"
      >
        <span class="text-compact text-text-heading font-semibold">{{
          t("aiIssues.isRuleRight")
        }}</span>
        <span class="text-2xs text-text-secondary">
          {{
            t("aiIssues.falseRate", {
              dismissed: closedByRule.dismissed,
              closed: closedByRule.closed,
            })
          }}
        </span>
        <div class="flex items-end gap-2">
          <OInput
            v-model.number="threshold"
            type="number"
            :label="t('aiIssues.firesAt')"
            class="w-40"
            data-test="ai-issue-threshold"
          />
          <OButton
            variant="outline"
            size="sm"
            :loading="previewing"
            data-test="ai-issue-preview"
            @click="preview"
          >
            {{ t("aiIssues.preview") }}
          </OButton>
          <OButton
            variant="outline"
            size="sm"
            :loading="saving"
            data-test="ai-issue-save-threshold"
            @click="saveThreshold"
          >
            {{ t("aiIssues.saveThreshold") }}
          </OButton>
        </div>
        <span
          v-if="previewCount !== null"
          class="text-2xs text-text-secondary"
          data-test="ai-issue-preview-count"
        >
          {{ t("aiIssues.previewCount", { n: previewCount, threshold }) }}
        </span>
      </section>

      <section class="flex flex-col gap-1.5" data-test="ai-issue-test">
        <span class="text-compact text-text-heading font-semibold">{{
          t("aiIssues.turnIntoTest")
        }}</span>
        <div class="flex flex-wrap gap-2">
          <OButton
            variant="outline"
            size="sm"
            :disabled="!issue.worstTraceId"
            data-test="ai-issue-add-dataset"
            @click="datasetOpen = true"
          >
            {{ t("aiIssues.addToDataset") }}
          </OButton>
          <OButton
            variant="outline"
            size="sm"
            data-test="ai-issue-run-experiment"
            @click="runExperiment"
          >
            {{ t("aiIssues.runExperiment") }}
          </OButton>
        </div>
      </section>
    </div>

    <AddToDatasetDrawer
      v-if="issue?.worstTraceId"
      :open="datasetOpen"
      :org-id="org()"
      ref-type="trace"
      :ref-id="issue.worstTraceId"
      :source-stream="stream"
      :ref-trace-start-time="issue.lastSeen"
      @update:open="(v: boolean) => (datasetOpen = v)"
    />
    <AiTraceDrawer v-model:open="traceOpen" :trace="trace" />
  </ODrawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useStore } from "vuex";
import { raw, useI18nTyped, type I18nText } from "@/types/i18n";
import ODrawer from "@/lib/overlay/Drawer/ODrawer.vue";
import OButton from "@/lib/core/Button/OButton.vue";
import OInput from "@/lib/forms/Input/OInput.vue";
import { toast } from "@/lib/feedback/Toast/useToast";
import alertsService from "@/services/alerts";
import AddToDatasetDrawer from "@/enterprise/components/AIObservability/AddToDatasetDrawer.vue";
import AiTraceDrawer from "@/plugins/traces/AiTraceDrawer.vue";
import type { AiDrawerTrace } from "@/plugins/traces/AiTraceDrawer.types";
import { useLLMStreamQuery } from "@/plugins/traces/composables/useLLMStreamQuery";
import { timestampToTimezoneDate } from "@/utils/timezone";
import { AI_AGENTS_PACK, packAlertName, repeatedToolCallsSql } from "@/utils/alerts/aiAgentsPack";
import {
  FAILING_MIN_CALLS,
  MUTE_DAYS,
  RULE_MIN_CALLS,
  ruleHitsSql,
  type DispositionStatus,
  type Issue,
  type IssueState,
} from "./aiIssues";

const props = defineProps<{
  open: boolean;
  issue: Issue | null;
  state: IssueState;
  stream: string;
  title: I18nText;
  closedByRule: { dismissed: number; closed: number };
}>();
const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "explain", issue: Issue): void;
  (e: "decide", issue: Issue, status: DispositionStatus): void;
}>();

const { t } = useI18nTyped();
const store = useStore();
const router = useRouter();
const { executeQuery } = useLLMStreamQuery();
const org = () => store.state.selectedOrganization?.identifier ?? "";
const timezone = computed(() => store.state.timezone || "UTC");

const datasetOpen = ref(false);
const traceOpen = ref(false);
const trace = ref<AiDrawerTrace | null>(null);
const threshold = ref(RULE_MIN_CALLS);
const previewCount = ref<number | null>(null);
const previewing = ref(false);
const saving = ref(false);

const failing = computed(() => props.issue?.kind === "failing_tool");
watch(
  () => props.issue?.key,
  () => {
    threshold.value = failing.value ? FAILING_MIN_CALLS : RULE_MIN_CALLS;
    previewCount.value = null;
  },
);

const tiles = computed(() => {
  const i = props.issue;
  if (!i) return [];
  return [
    { label: t("llmAttribution.traces"), value: raw(String(i.traceIds.length || "—")) },
    { label: t("llmAttribution.users.sessionsCol"), value: raw(String(i.sessions || "—")) },
    { label: t("aiIssues.users"), value: raw(String(i.users || "—")) },
    { label: t("aiIssues.spend"), value: raw(i.spend ? `$${i.spend.toFixed(2)}` : "—") },
    {
      label: t("aiIssues.firstSeen"),
      value: raw(
        i.firstSeen ? timestampToTimezoneDate(i.firstSeen, timezone.value, "MMM d HH:mm") : "—",
      ),
    },
    {
      label: t("aiIssues.lastSeen"),
      value: raw(
        i.lastSeen ? timestampToTimezoneDate(i.lastSeen, timezone.value, "MMM d HH:mm") : "—",
      ),
    },
  ];
});

function openTrace(traceId: string) {
  const at = props.issue?.lastSeen ?? Date.now() * 1000;
  trace.value = {
    traceId,
    stream: props.stream,
    startTime: at - 86_400_000_000,
    endTime: at + 3_600_000_000,
  };
  traceOpen.value = true;
}

// How many traces of this agent and tool the rule would match at the new threshold.
async function preview() {
  const i = props.issue;
  if (!i?.tool) return;
  previewing.value = true;
  try {
    const scope = `gen_ai_agent_name = '${i.agent.replace(/'/g, "''")}' AND gen_ai_tool_name = '${i.tool.replace(/'/g, "''")}'`;
    const rows = (await executeQuery(
      ruleHitsSql(props.stream, scope, failing.value, Number(threshold.value) || 1),
      i.firstSeen,
      Date.now() * 1000,
    )) as any[];
    previewCount.value = new Set(rows.map((r) => r.trace_id)).size;
  } finally {
    previewing.value = false;
  }
}

// The threshold lives in the installed pack alert's SQL; rewrite that alert.
async function saveThreshold() {
  const i = props.issue;
  if (!i) return;
  saving.value = true;
  try {
    const ruleId = failing.value ? "repeated_failing_tool_calls" : "repeated_tool_calls";
    const spec = AI_AGENTS_PACK.find((r) => r.id === ruleId)!.spec!(props.stream);
    const name = packAlertName(spec, props.stream);
    const list = await alertsService.listByFolderId(1, 100, "name", false, name, org());
    const entry = (list.data?.list ?? []).find((a: any) => a.name === name);
    if (!entry) {
      toast({ variant: "warning", message: t("aiIssues.ruleNotInstalled") });
      return;
    }
    const id = entry.alert_id ?? entry.id;
    const full = (await alertsService.get_by_alert_id(org(), id)).data;
    full.query_condition.sql = repeatedToolCallsSql(props.stream, {
      minCalls: Number(threshold.value) || 1,
      failingOnly: failing.value,
    });
    await alertsService.update_by_alert_id(org(), full, full.folder_id);
    toast({
      variant: "success",
      message: t("aiIssues.thresholdSaved", { threshold: threshold.value }),
    });
  } catch (e: any) {
    toast({ variant: "error", message: e?.response?.data?.message ?? String(e?.message ?? e) });
  } finally {
    saving.value = false;
  }
}

function runExperiment() {
  router.push({ name: "aiExperimentCreate", query: { org_identifier: org() } });
}
</script>
