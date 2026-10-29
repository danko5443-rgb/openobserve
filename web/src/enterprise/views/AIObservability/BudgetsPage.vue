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
  Budgets (AIO-38) — spend limits per agent, feature, user, model or session,
  as alerts: a warning at 80% and an over-budget alert at 100% whose webhook is
  the signal a gateway enforces. Spent against limit is read live from the
  trace cost columns. Unpriced spend is named, never counted as $0.
-->
<template>
  <AiPageShell
    data-test="ai-budgets"
    :title="t('aiBudgets.title')"
    :subtitle="t('aiBudgets.subtitle')"
    icon="account-balance"
    :date-state="dateState"
    :last-run-at="lastRunAt"
    :is-loading="loading"
    date-disabled
    @date-change="onDateStateChange"
    @refresh="reload"
  >
    <div class="px-page-edge flex min-h-0 flex-1 flex-col gap-2 py-2">
      <div class="flex items-center gap-2">
        <OSelect
          v-model="stream"
          :options="availableStreams.map((s) => ({ value: s, label: raw(s) }))"
          :label="t('llmAttribution.users.stream')"
          label-position="inside"
          size="sm"
          width="sm"
          data-test="ai-budgets-stream"
          @update:model-value="reload"
        />
        <span class="text-2xs text-text-secondary flex-1">{{ t("aiBudgets.signalNote") }}</span>
        <OButton
          variant="primary"
          size="sm"
          icon-left="add"
          data-test="ai-budgets-new"
          @click="openNew"
        >
          {{ t("aiBudgets.new") }}
        </OButton>
      </div>

      <OBanner
        v-if="unpricedTraces > 0"
        variant="warning"
        icon="warning"
        data-test="ai-budgets-unpriced"
      >
        <div class="flex items-center gap-2">
          <span class="flex-1 text-sm">{{ t("aiBudgets.unpriced", { n: unpricedTraces }) }}</span>
          <OButton
            variant="outline"
            size="sm"
            @click="router.push(pricingGapsRoute(stream, org()))"
          >
            {{ t("aiIssues.addPrice") }}
          </OButton>
        </div>
      </OBanner>

      <OTable
        :data="rows"
        :columns="columns"
        row-key="name"
        :loading="loading"
        :show-global-filter="false"
        pagination="none"
        class="min-h-0 flex-1"
        :empty-message="t('aiBudgets.empty')"
        data-test="ai-budgets-table"
      >
        <template #cell-budget="{ row }">
          <div class="flex flex-col">
            <span class="text-compact text-text-body font-medium">{{ row.name }}</span>
            <span class="text-2xs text-text-secondary">{{ scopeLabel(row) }}</span>
          </div>
        </template>
        <template #cell-spent="{ row }">
          <div class="flex flex-col gap-1">
            <span class="text-compact">{{ spentLabel(row) }}</span>
            <OProgressBar
              :value="Math.min(100, (row.shown / Math.max(row.limitUsd, 0.0001)) * 100)"
              :variant="
                row.state === 'over' ? 'danger' : row.state === 'warning' ? 'warning' : 'default'
              "
              size="sm"
              class="w-48"
              aria-hidden="true"
            />
          </div>
        </template>
        <template #cell-state="{ row }">
          <OBadge
            :variant="
              row.state === 'over'
                ? 'error-soft'
                : row.state === 'warning'
                  ? 'warning-soft'
                  : 'success-soft'
            "
            size="sm"
            :data-test="`ai-budgets-state-${row.name}`"
          >
            {{
              t(
                `aiBudgets.states.${row.state}`,
                { n: row.over },
                row.state === "over" && isEach(row.scope) ? row.over : 0,
              )
            }}
          </OBadge>
        </template>
      </OTable>
    </div>

    <ODialog
      v-model:open="dialogOpen"
      size="md"
      :title="t('aiBudgets.new')"
      :primary-button-label="t('aiBudgets.create')"
      :primary-button-disabled="!canCreate"
      :primary-button-loading="creating"
      primary-button-data-test="ai-budgets-create"
      :secondary-button-label="t('common.cancel')"
      data-test="ai-budgets-dialog"
      @click:primary="create"
      @click:secondary="dialogOpen = false"
    >
      <div class="flex flex-col gap-3">
        <OInput
          v-model="draft.name"
          :label="t('aiBudgets.name')"
          :placeholder="raw('deep-research-daily')"
          data-test="ai-budgets-name"
        />
        <OSelect
          v-model="draft.scope"
          :options="SCOPES.map((s) => ({ value: s, label: t(`aiBudgets.scopes.${s}`) }))"
          :label="t('aiBudgets.limits')"
          data-test="ai-budgets-scope"
        />
        <OInput
          v-if="!isEach(draft.scope)"
          v-model="draft.value"
          :label="t(`aiBudgets.scopes.${draft.scope}`)"
          data-test="ai-budgets-value"
        />
        <div class="grid grid-cols-2 gap-3">
          <OInput
            v-model.number="draft.limitUsd"
            type="number"
            :label="t('aiBudgets.limit')"
            data-test="ai-budgets-limit"
          />
          <OSelect
            v-if="draft.scope !== 'session'"
            v-model="draft.period"
            :options="[
              { value: 'day', label: t('aiBudgets.periods.day') },
              { value: 'month', label: t('aiBudgets.periods.month') },
            ]"
            :label="t('aiBudgets.period')"
            data-test="ai-budgets-period"
          />
        </div>
        <OSelect
          v-model="warnDestination"
          :options="destinationOptions"
          :label="t('aiBudgets.warnAt')"
          :placeholder="t('aiAlertPack.noDestination')"
          clearable
          data-test="ai-budgets-warn-destination"
        />
        <OSelect
          v-model="signalDestination"
          :options="destinationOptions"
          :label="t('aiBudgets.overAt')"
          :help-text="t('aiBudgets.signalHelp')"
          :placeholder="t('aiAlertPack.noDestination')"
          clearable
          data-test="ai-budgets-signal-destination"
        />
      </div>
    </ODialog>
  </AiPageShell>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { useStore } from "vuex";
import { raw, useI18nTyped } from "@/types/i18n";
import AiPageShell from "@/enterprise/components/AIObservability/AiPageShell.vue";
import OTable from "@/lib/core/Table/OTable.vue";
import { COL, type OTableColumnDef } from "@/lib/core/Table/OTable.types";
import OButton from "@/lib/core/Button/OButton.vue";
import OBadge from "@/lib/core/Badge/OBadge.vue";
import OBanner from "@/lib/feedback/Banner/OBanner.vue";
import OProgressBar from "@/lib/data/ProgressBar/OProgressBar.vue";
import ODialog from "@/lib/overlay/Dialog/ODialog.vue";
import OInput from "@/lib/forms/Input/OInput.vue";
import OSelect from "@/lib/forms/Select/OSelect.vue";
import { toast } from "@/lib/feedback/Toast/useToast";
import alertsService from "@/services/alerts";
import destinationService from "@/services/alert_destination";
import useStreams from "@/composables/useStreams";
import { createFolderByType, getFoldersListByType } from "@/utils/commons";
import { useAiDateController } from "@/enterprise/composables/useAiDateController";
import { useLlmPageScope } from "@/enterprise/composables/useLlmPageScope";
import { useLLMStreamQuery } from "@/plugins/traces/composables/useLLMStreamQuery";
import { pricingGapsRoute } from "@/plugins/traces/llmDataTrust.utils";
import {
  PERIOD_MINUTES,
  budgetAlertPayloads,
  budgetFromAlert,
  budgetSpend,
  budgetSql,
  budgetState,
  isEach,
  type BudgetDef,
  type BudgetScope,
  type BudgetState,
} from "@/utils/alerts/aiBudgets";

defineOptions({ name: "AIBudgetsPage" });

const FOLDER = "AI budgets";
const SCOPES: BudgetScope[] = ["agent", "feature", "user", "model", "session"];

const { t } = useI18nTyped();
const store = useStore();
const router = useRouter();
const { getStream } = useStreams(t);
const { executeQuery } = useLLMStreamQuery();
const { dateState, timeRange, onDateChange: onDateStateChange } = useAiDateController();
const { stream, availableStreams, load: loadScope } = useLlmPageScope(t);

const org = () => store.state.selectedOrganization?.identifier ?? "";
type Row = BudgetDef & {
  spent: number;
  shown: number;
  over: number;
  keys: number;
  state: BudgetState;
};
const rows = ref<Row[]>([]);
const loading = ref(false);
const lastRunAt = ref<number | null>(null);
const unpricedTraces = ref(0);
const dialogOpen = ref(false);
const creating = ref(false);
const destinations = ref<string[]>([]);
const warnDestination = ref<string | null>(null);
const signalDestination = ref<string | null>(null);
const draft = reactive<BudgetDef>({
  name: "",
  scope: "agent",
  value: "",
  limitUsd: 100,
  period: "day",
  stream: "",
});

const destinationOptions = computed(() =>
  destinations.value.map((d) => ({ value: d, label: raw(d) })),
);
const canCreate = computed(
  () =>
    !!draft.name.trim() &&
    draft.limitUsd > 0 &&
    (isEach(draft.scope) || !!draft.value.trim()) &&
    !!stream.value,
);

const columns: OTableColumnDef[] = [
  { id: "budget", header: t("aiBudgets.budget"), meta: { align: "left", flex: true } },
  {
    id: "spent",
    header: t("aiBudgets.spentLimit"),
    size: COL.description,
    meta: { align: "left" },
  },
  { id: "state", header: t("aiBudgets.state"), size: COL.type, meta: { align: "left" } },
];

function scopeLabel(b: BudgetDef) {
  const period = t(`aiBudgets.periods.${b.period}`);
  return isEach(b.scope)
    ? t("aiBudgets.eachScope", { scope: t(`aiBudgets.scopes.${b.scope}`), period })
    : t("aiBudgets.valueScope", {
        scope: t(`aiBudgets.scopes.${b.scope}`),
        value: b.value,
        period,
      });
}

function spentLabel(r: Row) {
  return isEach(r.scope)
    ? t("aiBudgets.spentEach", {
        limit: `$${r.limitUsd}`,
        over: r.over,
        keys: r.keys,
        largest: `$${r.shown.toFixed(2)}`,
      })
    : t("aiBudgets.spentOf", {
        spent: `$${r.spent.toFixed(2)}`,
        limit: `$${r.limitUsd}`,
        pct: r.limitUsd > 0 ? Math.round((r.spent / r.limitUsd) * 100) : 0,
      });
}

async function folderId(create: boolean): Promise<string | null> {
  const folders: Array<{ folderId: string; name: string }> =
    (await getFoldersListByType(store, "alerts")) ?? [];
  const found = folders.find((f) => f.name === FOLDER);
  if (found || !create) return found?.folderId ?? null;
  const created: any = await createFolderByType(
    store,
    { name: FOLDER, description: t("aiBudgets.folderDescription") },
    "alerts",
  );
  return created?.data?.folderId ?? "default";
}

async function reload() {
  await loadScope(timeRange.value.startTime, timeRange.value.endTime);
  loading.value = true;
  try {
    const id = await folderId(false);
    const list = id
      ? ((await alertsService.listByFolderId(1, 500, "name", false, "", org(), id)).data?.list ??
        [])
      : [];
    const overAlerts = list.filter((a: any) => String(a.name).endsWith("_over"));
    const defs = (
      await Promise.all(
        overAlerts.map((a: any) =>
          alertsService
            .get_by_alert_id(org(), a.alert_id ?? a.id, id)
            .then((r) => budgetFromAlert(r.data))
            .catch(() => null),
        ),
      )
    ).filter((d): d is BudgetDef & { alertIds: string[] } => !!d);
    const now = Date.now() * 1000;
    rows.value = await Promise.all(
      defs.map(async (b) => {
        const hits = (await executeQuery(
          budgetSql(b),
          now - PERIOD_MINUTES[b.period] * 60_000_000,
          now,
        ).catch(() => [])) as any[];
        const s = budgetSpend(b, hits);
        const shown = isEach(b.scope) ? s.largest : s.spent;
        return {
          ...b,
          ...s,
          shown,
          state: isEach(b.scope)
            ? s.over > 0
              ? "over"
              : budgetState(s.largest, b.limitUsd)
            : budgetState(s.spent, b.limitUsd),
        };
      }),
    );
    await loadUnpriced(now);
  } finally {
    loading.value = false;
    lastRunAt.value = Date.now();
  }
}

// Budgets count priced calls only: name what is missing this month.
async function loadUnpriced(now: number) {
  unpricedTraces.value = 0;
  if (!stream.value) return;
  const schema = await getStream(stream.value, "traces", true).catch(() => null);
  if (!(schema?.schema ?? []).some((f: any) => f.name === "gen_ai_usage_cost_status")) return;
  const hits = (await executeQuery(
    `SELECT COUNT(*) AS n FROM "${stream.value}" WHERE gen_ai_usage_cost_status = 'unpriced'`,
    now - PERIOD_MINUTES.month * 60_000_000,
    now,
  ).catch(() => [])) as any[];
  unpricedTraces.value = Number(hits[0]?.n) || 0;
}

async function openNew() {
  dialogOpen.value = true;
  try {
    const res: any = await destinationService.list({
      org_identifier: org(),
      page_num: 1,
      page_size: 100000,
      sort_by: "name",
      desc: false,
      module: "alert",
    });
    destinations.value = (Array.isArray(res?.data) ? res.data : [])
      .map((d: any) => d?.name)
      .filter(Boolean);
  } catch {
    destinations.value = [];
  }
}

async function create() {
  if (!canCreate.value) return;
  creating.value = true;
  try {
    const id = (await folderId(true)) ?? "default";
    const b: BudgetDef = {
      ...draft,
      name: draft.name.trim(),
      value: draft.value.trim(),
      period: draft.scope === "session" ? "hour" : draft.period,
      stream: stream.value,
    };
    for (const payload of budgetAlertPayloads(b, {
      folderId: id,
      warnDestination: warnDestination.value ?? "",
      signalDestination: signalDestination.value ?? "",
      owner: store.state.userInfo?.email ?? "",
      timezone: store.state.timezone || "UTC",
    })) {
      await alertsService.create_by_alert_id(org(), payload, id);
    }
    toast({ variant: "success", message: t("aiBudgets.created", { name: b.name }) });
    dialogOpen.value = false;
    await reload();
  } catch (e: any) {
    toast({ variant: "error", message: e?.response?.data?.message ?? String(e?.message ?? e) });
  } finally {
    creating.value = false;
  }
}

onMounted(reload);
</script>
