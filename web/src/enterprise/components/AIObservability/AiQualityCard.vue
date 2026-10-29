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
  AiQualityCard — the quality signal on Insights (AIO-26). It follows the score
  config with the most scores for the agent in scope, and compares its average
  (or healthy share) with the window just before. With no scores it offers the
  one-click evaluation (AIO-23). Hidden when the Quality API is not available.
-->
<template>
  <div
    v-if="state !== 'hidden'"
    class="bg-card-glass-bg rounded-default border-border-default flex items-center gap-4 border px-3.5 py-2.5"
    data-test="ai-quality-card"
  >
    <template v-if="state === 'loading'">
      <OSkeleton type="text" class="h-10 w-full" />
    </template>

    <template v-else-if="state === 'empty'">
      <OIcon name="fact-check" size="md" class="text-text-secondary shrink-0" />
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="text-compact text-text-heading font-medium">{{
          t("aiQualityCard.noScores")
        }}</span>
        <span class="text-2xs text-text-secondary">
          {{ t("aiQualityCard.noScoresBody", { agent: subjectLabel }) }}
        </span>
      </div>
      <OButton
        variant="primary"
        size="sm"
        icon-left="auto-awesome"
        data-test="ai-quality-card-evaluate"
        @click="evalOpen = true"
      >
        {{ t("oneClickEval.evaluate", { agent: subjectLabel }) }}
      </OButton>
    </template>

    <template v-else-if="main">
      <div class="flex min-w-0 flex-col gap-0.5">
        <span class="text-2xs text-text-secondary font-semibold">
          {{ t("aiQualityCard.title") }} ·
          {{ t("aiQualityCard.subtitle", { config: main.name }) }}
        </span>
        <div class="flex items-baseline gap-2">
          <span
            class="text-text-secondary text-2xl leading-none font-bold"
            data-test="ai-quality-card-value"
          >
            {{ formatValue(value(main)) }}
          </span>
          <span class="text-2xs text-text-secondary">{{ t("aiQualityCard.thisPeriod") }}</span>
          <span
            v-if="delta !== null"
            class="text-2xs"
            :class="
              delta < 0 ? 'text-error-600' : delta > 0 ? 'text-success-600' : 'text-text-secondary'
            "
            data-test="ai-quality-card-delta"
            >{{ delta > 0 ? "▲" : delta < 0 ? "▼" : "" }} {{ formatValue(Math.abs(delta)) }}</span
          >
        </div>
        <span v-if="main.unhealthy !== null" class="text-2xs text-text-secondary">
          {{ t("aiQualityCard.unhealthy", { unhealthy: main.unhealthy, total: main.total }) }}
        </span>
      </div>
      <KpiSparkline
        v-if="series.length > 1"
        :data="series"
        color="#10b981"
        :height="36"
        class="min-w-0 flex-1"
      />
      <span v-else class="flex-1" />
      <OButton variant="outline" size="sm" data-test="ai-quality-card-open" @click="openQuality">
        {{ t("aiQualityCard.openInQuality") }}
      </OButton>
    </template>

    <OneClickEvalDialog
      v-model:open="evalOpen"
      :agent="agent?.name ?? null"
      :stream="stream"
      :traces-per-day="tracesPerDay"
    />
  </div>
</template>

<script lang="ts" setup>
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useStore } from "vuex";
import { useI18nTyped } from "@/types/i18n";
import OButton from "@/lib/core/Button/OButton.vue";
import OIcon from "@/lib/core/Icon/OIcon.vue";
import OSkeleton from "@/lib/feedback/Skeleton/OSkeleton.vue";
import KpiSparkline from "@/plugins/traces/KpiSparkline.vue";
import OneClickEvalDialog from "@/enterprise/components/onlineEvals/OneClickEvalDialog.vue";
import onlineEvalsService, {
  type QualityConfigSummary,
  type QualityListParams,
} from "@/services/online-evals.service";
import type { GenAiAgentListItem } from "@/services/gen-ai-agent-mapping.service";

const props = defineProps<{
  agent: GenAiAgentListItem | null;
  stream: string;
  startTime: number;
  endTime: number;
  /** Traces in scope per day, for the one-click estimate. */
  tracesPerDay?: number;
}>();

const { t } = useI18nTyped();
const store = useStore();
const router = useRouter();
const org = () => store.state.selectedOrganization?.identifier ?? "";

const state = ref<"loading" | "hidden" | "empty" | "ready">("loading");
const main = ref<QualityConfigSummary | null>(null);
const previous = ref<QualityConfigSummary | null>(null);
const series = ref<number[]>([]);
const evalOpen = ref(false);
let seq = 0;

const subjectLabel = computed(() => props.agent?.name || props.stream);

/** Numeric configs: the average. Boolean and categorical: the healthy share. */
function value(c: QualityConfigSummary): number {
  if (c.average !== null && c.dataType === "numeric") return c.average;
  return c.total > 0 && c.unhealthy !== null ? (c.total - c.unhealthy) / c.total : 0;
}

function formatValue(v: number): string {
  return main.value?.dataType === "numeric" ? v.toFixed(2) : `${(v * 100).toFixed(0)}%`;
}

const delta = computed(() =>
  main.value && previous.value && previous.value.total > 0
    ? value(main.value) - value(previous.value)
    : null,
);

function params(start: number, end: number): QualityListParams {
  const a = props.agent;
  return {
    start_time: start,
    end_time: end,
    ...(a?.id ? { agent_id: a.id } : a?.name ? { agent_name: a.name } : {}),
    ...(a?.env ? { agent_env: a.env } : {}),
    ...(a?.version ? { agent_version: a.version } : {}),
  };
}

async function load() {
  const mine = ++seq;
  state.value = "loading";
  try {
    const now = params(props.startTime, props.endTime);
    const configs = await onlineEvalsService.quality.list(org(), now);
    if (mine !== seq) return;
    const top = configs.filter((c) => c.total > 0).sort((a, b) => b.total - a.total)[0] ?? null;
    main.value = top;
    if (!top) {
      state.value = "empty";
      return;
    }
    const span = props.endTime - props.startTime;
    const [timeline, before] = await Promise.all([
      onlineEvalsService.quality.timeline(org(), top.configId, now).catch(() => ({ timeline: [] })),
      onlineEvalsService.quality
        .list(org(), params(props.startTime - span, props.startTime))
        .catch(() => []),
    ]);
    if (mine !== seq) return;
    series.value = timeline.timeline.map((b) =>
      top.dataType === "numeric"
        ? (b.average ?? 0)
        : b.count > 0
          ? (b.count - (b.unhealthy ?? 0)) / b.count
          : 0,
    );
    previous.value = before.find((c) => c.configId === top.configId) ?? null;
    state.value = "ready";
  } catch {
    // No evaluations on this deployment, or no permission: the card stays out.
    if (mine === seq) state.value = "hidden";
  }
}

function openQuality() {
  router.push({
    name: "aiEvaluations",
    query: {
      org_identifier: org(),
      tab: "quality",
      config: main.value?.configId,
      ...(props.agent?.name ? { agent: props.agent.name } : {}),
    },
  });
}

watch(
  () => [props.agent?.name, props.agent?.env, props.agent?.version, props.startTime, props.endTime],
  load,
  { immediate: true },
);
</script>
