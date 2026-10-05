<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ensureMerged, flushProject, getProject, getRule, store } from '../logic/store'
import {
  DISPOSITION_ACTION_LABEL,
  REVIEW_CATEGORY_LABEL,
  RollbackBlockedError,
  commitDisposition,
  dispositionActionText,
  dispositionRows,
  listReviewRows,
  previewDisposition,
  resolveTargetIds,
  rollbackDisposition,
  rollbackableDisposition,
  scopeTextOf,
  validateRequest,
  workbenchStats,
  type DispositionRequest,
  type Preview
} from '../logic/review'
import { specialFlagLabel } from '../logic/sizeRules'
import { chestWaistDiffCm, formatCm } from '../logic/precision'
import { anomalyText } from '../logic/analyze'
import { buildSummary, conservationText } from '../logic/merge'
import { toCsvText, downloadText } from '../logic/csv'
import { exportBaseName } from '../logic/exporter'
import type {
  BatchDisposition,
  DispositionAction,
  DispositionScope,
  Person,
  ReviewCategory
} from '../logic/types'

const route = useRoute()
const project = computed(() => getProject(route.params.id as string))
const rule = computed(() => getRule(project.value?.ruleVersion ?? store.rules[0].version))

if (project.value) ensureMerged(project.value)

onMounted(() => {
  if (project.value) void flushProject(project.value)
})

const category = ref<ReviewCategory>('pending')
/** 整批范围：all（按勾选）/ org:班级名 / batch:批次名 */
const scopeFilter = ref('all')
const search = ref('')
const selectedIds = ref<Set<string>>(new Set())
const message = ref('')
const errorText = ref('')

const stats = computed(() => (project.value ? workbenchStats(project.value) : null))

const parsedScope = computed<{ kind: 'all' | 'org_unit' | 'batch'; value: string }>(() => {
  if (scopeFilter.value.startsWith('org:')) return { kind: 'org_unit', value: scopeFilter.value.slice(4) }
  if (scopeFilter.value.startsWith('batch:')) return { kind: 'batch', value: scopeFilter.value.slice(6) }
  return { kind: 'all', value: '' }
})

const groupOptions = computed(() => {
  if (!stats.value) return { orgUnits: [] as string[], batches: [] as string[] }
  return {
    orgUnits: stats.value.byOrgUnit.filter((item) => item[category.value] > 0).map((item) => item.orgUnit),
    batches: stats.value.byBatch.filter((item) => item[category.value] > 0).map((item) => item.batch)
  }
})

const filteredRows = computed(() => {
  if (!project.value) return []
  const keyword = search.value.trim()
  return listReviewRows(project.value, category.value).filter((person) => {
    if (parsedScope.value.kind === 'org_unit' && (person.orgUnit || '未填班级/车间') !== parsedScope.value.value) return false
    if (parsedScope.value.kind === 'batch' && (person.batch || '未分批') !== parsedScope.value.value) return false
    if (keyword === '') return true
    return (
      person.name.includes(keyword) ||
      person.orgUnit.includes(keyword) ||
      person.batch.includes(keyword) ||
      String(person.sourceRow ?? '') === keyword
    )
  })
})

const allVisibleSelected = computed(
  () => filteredRows.value.length > 0 && filteredRows.value.every((person) => selectedIds.value.has(person.id))
)

function toggleRow(id: string, checked: boolean): void {
  const next = new Set(selectedIds.value)
  if (checked) next.add(id)
  else next.delete(id)
  selectedIds.value = next
}

function toggleVisibleAll(checked: boolean): void {
  const next = new Set(selectedIds.value)
  for (const person of filteredRows.value) {
    if (checked) next.add(person.id)
    else next.delete(person.id)
  }
  selectedIds.value = next
}

function switchCategory(next: ReviewCategory): void {
  category.value = next
  scopeFilter.value = 'all'
  selectedIds.value = new Set()
  preview.value = null
  errorText.value = ''
}

/* ------------------------------ 整批处置表单 ------------------------------ */

const action = ref<DispositionAction>('flag_special')
const specialCode = ref(rule.value.specialFlags[0]?.code ?? '')
const sizeCode = ref('')
const reason = ref('')
const by = ref(store.operator)
const preview = ref<Preview | null>(null)

// 范围 / 关键词 / 类别变化后，旧预演立即失效，必须重新预演
watch([scopeFilter, search, category], () => {
  preview.value = null
})

/** 当前表单作用到的目标人数（勾选 或 当前班级/批次整批） */
const targetCount = computed(() => {
  const current = project.value
  if (!current) return 0
  const scope = currentScope()
  if (!scope) return 0
  return resolveTargetIds(current, category.value, scope).length
})

function currentScope(): DispositionScope | null {
  const current = project.value
  if (!current) return null
  const scope0 = parsedScope.value
  if (scope0.kind === 'org_unit') return { type: 'org_unit', value: scope0.value, targetIds: [] }
  if (scope0.kind === 'batch') return { type: 'batch', value: scope0.value, targetIds: [] }
  // selected 模式只提交当前类别下确实勾选、且仍属于异常行的 id
  const valid = new Set(listReviewRows(current, category.value).map((person) => person.id))
  return { type: 'selected', value: '', targetIds: [...selectedIds.value].filter((id) => valid.has(id)) }
}

function buildRequest(): DispositionRequest {
  return {
    categories: [category.value],
    scope: currentScope() ?? { type: 'selected', value: '', targetIds: [] },
    action: action.value,
    payload: action.value === 'flag_special' ? specialCode.value : sizeCode.value,
    reason: reason.value,
    by: by.value
  }
}

function runPreview(): void {
  const current = project.value
  if (!current) return
  errorText.value = ''
  message.value = ''
  const request = buildRequest()
  const targets = resolveTargetIds(current, category.value, request.scope)
  const invalid = validateRequest(rule.value, request, targets.length)
  if (invalid) {
    errorText.value = invalid
    preview.value = null
    return
  }
  try {
    preview.value = previewDisposition(current, rule.value, request)
  } catch (caught) {
    errorText.value = caught instanceof Error ? caught.message : String(caught)
    preview.value = null
  }
}

async function submitDisposition(): Promise<void> {
  const current = project.value
  const activePreview = preview.value
  if (!current || !activePreview) return
  try {
    const record = commitDisposition(current, rule.value, activePreview)
    ensureMerged(current)
    await flushProject(current)
    selectedIds.value = new Set()
    preview.value = null
    reason.value = ''
    sizeCode.value = ''
    message.value =
      `已完成整批处置：${scopeTextOf(category.value, record.scope, record.count)}；` +
      `${dispositionActionText(rule.value, record)} ${record.count} 条；` +
      `有效人数 ${record.beforeTotals.validRows} → ${record.afterTotals.validRows}，` +
      `未处理异常 ${record.beforeTotals.pendingReviewCount} → ${record.afterTotals.pendingReviewCount}。可在下方「整批处置留痕」一次回滚。`
    errorText.value = ''
  } catch (caught) {
    errorText.value = caught instanceof Error ? caught.message : String(caught)
    preview.value = null
  }
}

async function rollback(record: BatchDisposition): Promise<void> {
  const current = project.value
  if (!current) return
  const confirmed = window.confirm(
    `确定整批回滚「${record.scopeText}」吗？\n回滚后这 ${record.count} 条的归并结果与人数都会恢复到处置之前。`
  )
  if (!confirmed) return
  try {
    rollbackDisposition(current, rule.value, record, by.value || store.operator)
    ensureMerged(current)
    await flushProject(current)
    preview.value = null
    message.value = `已整批回滚「${record.scopeText}」，归并结果与人数已恢复为处置前：${conservationText(
      buildSummary(current, rule.value)
    )}`
    errorText.value = ''
  } catch (caught) {
    if (caught instanceof RollbackBlockedError) {
      errorText.value = caught.message
    } else {
      errorText.value = caught instanceof Error ? caught.message : String(caught)
    }
  }
}

const dispositionList = computed(() =>
  [...(project.value?.dispositions ?? [])].sort((a, b) => b.at - a.at)
)
const latestRollbackable = computed(() => (project.value ? rollbackableDisposition(project.value) : null))

function exportDispositions(): void {
  const current = project.value
  if (!current) return
  void flushProject(current)
  const ctx = {
    project: current,
    rule: rule.value,
    summary: buildSummary(current, rule.value),
    operator: store.operator,
    generatedAt: new Date()
  }
  downloadText(
    toCsvText(dispositionRows(current, rule.value)),
    exportBaseName(ctx, '整批处置留痕', 'csv')
  )
}

/* -------------------------------- 展示辅助 -------------------------------- */

const genderText = (gender: string): string => (gender === 'male' ? '男' : '女')

function anomalyReason(person: Person): string {
  const parts = person.anomaly.map((code) => anomalyText(code))
  if (person.possibleDuplicateOf) parts.unshift(`与 ${person.possibleDuplicateOf} 疑似重复`)
  if (person.statusReason) parts.push(person.statusReason)
  return parts.length ? parts.join('；') : '命中异常规则，请复核'
}

function personHint(person: Person): string {
  if (category.value === 'duplicate') return `疑似与 ${person.possibleDuplicateOf ?? '—'} 重复`
  if (category.value === 'unmerged') return anomalyReason(person)
  return anomalyReason(person)
}

const tabs: { key: ReviewCategory; count: () => number }[] = [
  { key: 'pending', count: () => stats.value?.pending ?? 0 },
  { key: 'unmerged', count: () => stats.value?.unmerged ?? 0 },
  { key: 'duplicate', count: () => stats.value?.duplicate ?? 0 }
]

function rowClasses(person: Person): Record<string, boolean> {
  return {
    'row-invalid': person.status !== 'active',
    'row-selected': selectedIds.value.has(person.id)
  }
}

const increasedDeltas = computed(() => (preview.value?.deltas ?? []).filter((delta) => delta.delta > 0))
const decreasedDeltas = computed(() => (preview.value?.deltas ?? []).filter((delta) => delta.delta < 0))
const bucketLabel = (sizeCode: string, isSpecial: boolean): string =>
  isSpecial ? `${specialFlagLabel(rule.value, sizeCode)}（${sizeCode}）` : sizeCode

const actionOptions: { value: DispositionAction; label: string }[] = [
  { value: 'flag_special', label: DISPOSITION_ACTION_LABEL.flag_special },
  { value: 'mark_invalid', label: DISPOSITION_ACTION_LABEL.mark_invalid },
  { value: 'mark_duplicate', label: DISPOSITION_ACTION_LABEL.mark_duplicate },
  { value: 'assign_size', label: DISPOSITION_ACTION_LABEL.assign_size }
]

const statusBadgeClass = computed(() => {
  if (!preview.value) return ''
  return preview.value.afterTotals.unmergedCount === 0 && preview.value.afterTotals.pendingReviewCount === 0
    ? 'badge-ok'
    : 'badge-warn'
})
</script>

<template>
  <section v-if="!project || !stats" class="empty">项目不存在，请回到项目列表重新选择。</section>
  <section v-else>
    <div class="page-head">
      <div>
        <h1>{{ project.name }} · 异常行批量复核工作台</h1>
        <div class="sub">
          依据规则版本 <b>{{ project.ruleVersion }}</b>（{{ rule.label }}）｜
          待确认 / 没能归并 / 疑似重复三类异常集中处置，处置前先预演后果，预演与真处置不一致不许提交
        </div>
      </div>
      <div class="spacer"></div>
      <div class="toolbar">
        <RouterLink class="btn btn-sm" :to="`/merge/${project.id}`">归并结果</RouterLink>
        <RouterLink class="btn btn-sm btn-primary" :to="`/summary/${project.id}`">汇总与守恒</RouterLink>
      </div>
    </div>

    <p v-if="message" class="notice notice-ok">{{ message }}</p>
    <p v-if="errorText" class="notice notice-error">{{ errorText }}</p>

    <div class="card" :class="stats.totalUnique ? 'card-accent-warn' : 'card-accent-ok'">
      <div class="card-body tight">
        <div class="stat-row">
          <div class="stat"><div class="stat-label">待确认</div><div class="stat-value">{{ stats.pending }}</div></div>
          <div class="stat"><div class="stat-label">没能归并</div><div class="stat-value">{{ stats.unmerged }}</div></div>
          <div class="stat"><div class="stat-label">疑似重复</div><div class="stat-value">{{ stats.duplicate }}</div></div>
          <div class="stat">
            <div class="stat-label">还剩异常未处理（去重）</div>
            <div class="stat-value">{{ stats.totalUnique }}</div>
          </div>
        </div>
        <p class="hint" style="margin-top: 8px">
          三类异常可能有交叉（例如既待确认又没能归并），「未处理」按人头去重计数；整批处置后这里、归并结果与导出表同步变化。
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="toolbar">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            class="btn btn-sm"
            :class="category === tab.key ? 'btn-primary' : ''"
            type="button"
            @click="switchCategory(tab.key)"
          >
            {{ REVIEW_CATEGORY_LABEL[tab.key] }}（{{ tab.count() }}）
          </button>
        </div>
        <div class="spacer"></div>
        <div class="toolbar">
          <select class="select btn-sm" style="width: auto" v-model="scopeFilter">
            <option value="all">全部班级 / 批次</option>
            <option v-for="name in groupOptions.orgUnits" :key="`org-${name}`" :value="`org:${name}`">
              班级/车间：{{ name }}
            </option>
            <option v-for="name in groupOptions.batches" :key="`batch-${name}`" :value="`batch:${name}`">
              批次：{{ name }}
            </option>
          </select>
          <input v-model="search" class="input" style="width: 160px" type="search" placeholder="姓名 / 班级 / 批次 / 行号" />
        </div>
      </div>

      <div class="table-scroll">
        <table class="data-table review-table">
          <thead>
            <tr>
              <th class="check-col">
                <input type="checkbox" :checked="allVisibleSelected" :disabled="filteredRows.length === 0"
                       @change="toggleVisibleAll(($event.target as HTMLInputElement).checked)" />
              </th>
              <th class="num">行号</th>
              <th>姓名</th>
              <th>性别</th>
              <th>班级/车间</th>
              <th>批次</th>
              <th class="num">身高</th>
              <th class="num">胸围</th>
              <th class="num">腰围</th>
              <th class="num">胸腰差</th>
              <th>当前归属</th>
              <th>状态</th>
              <th>异常说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="person in filteredRows" :key="person.id" :class="rowClasses(person)">
              <td class="check-col">
                <input
                  type="checkbox"
                  :checked="selectedIds.has(person.id)"
                  @change="toggleRow(person.id, ($event.target as HTMLInputElement).checked)"
                />
              </td>
              <td class="num">{{ person.sourceRow ?? '—' }}</td>
              <td>{{ person.name }}</td>
              <td>{{ genderText(person.gender) }}</td>
              <td>{{ person.orgUnit || '—' }}</td>
              <td>{{ person.batch || '—' }}</td>
              <td class="num">{{ formatCm(person.heightCm) }}</td>
              <td class="num">{{ formatCm(person.chestCm) }}</td>
              <td class="num">{{ formatCm(person.waistCm) }}</td>
              <td class="num">
                {{ person.chestCm > 0 && person.waistCm > 0 ? formatCm(chestWaistDiffCm(person.chestCm, person.waistCm)) : '—' }}
              </td>
              <td>
                <span v-if="person.specialFlag" class="badge badge-warn">{{ specialFlagLabel(rule, person.specialFlag) }}</span>
                <b v-else-if="person.result?.sizeCode">{{ person.result.sizeCode }}</b>
                <span v-else class="badge badge-danger">未归并</span>
              </td>
              <td>
                <span class="badge badge-warn">有效·待复核</span>
              </td>
              <td>{{ personHint(person) }}</td>
            </tr>
            <tr v-if="filteredRows.length === 0">
              <td colspan="13" class="row-subtotal">这一类异常已经处理完了。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card card-accent-warn">
      <div class="card-head">
        <h3>整批处置（{{ parsedScope.kind === 'all' ? `已勾选 ${selectedIds.size} 条` : `当前范围内 ${targetCount} 条将整批选中` }}）</h3>
        <div class="spacer"></div>
        <span class="hint">一次给整批人同一种处理，并写明原因；每一次整批处置都留下批次、操作人与条数</span>
      </div>
      <div class="card-body">
        <div class="form-grid">
          <label class="field">
            <span class="field-label">处置方式 <b class="req">*</b></span>
            <select v-model="action" class="select" @change="preview = null">
              <option v-for="option in actionOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <label v-if="action === 'flag_special'" class="field">
            <span class="field-label">特殊体型标记 <b class="req">*</b></span>
            <select v-model="specialCode" class="select" @change="preview = null">
              <option v-for="flag in rule.specialFlags" :key="flag.code" :value="flag.code">{{ flag.label }}</option>
            </select>
          </label>
          <label v-if="action === 'assign_size'" class="field">
            <span class="field-label">统一号型 <b class="req">*</b></span>
            <input v-model="sizeCode" class="input" type="text" placeholder="170/88A" @input="preview = null" />
          </label>
          <label class="field">
            <span class="field-label">操作人 <b class="req">*</b></span>
            <input v-model="by" class="input" type="text" maxlength="16" @input="preview = null" />
          </label>
          <label class="field field-wide">
            <span class="field-label">
              处置原因 <b class="req">*</b>
              <span class="hint">（{{ action === 'assign_size' ? '整批填号型必须写明原因并留痕' : '整批处置必须留痕' }}）</span>
            </span>
            <input
              v-model="reason"
              class="input"
              type="text"
              :placeholder="
                action === 'mark_invalid'
                  ? '如：现场复核为废表/重复录入，整批不计入有效人数'
                  : action === 'mark_duplicate'
                    ? '如：与正式名单逐条比对确认为同一批重复录入'
                    : action === 'flag_special'
                      ? '如：班主任现场确认该批均为加肥体型，转定制'
                      : '如：厂方确认该批统一按 170/88A 下单'
              "
              @input="preview = null"
            />
          </label>
        </div>
        <div class="toolbar" style="margin-top: 10px">
          <button class="btn" type="button" @click="runPreview">先预演后果</button>
          <span class="hint">
            将处置 <b>{{ targetCount }}</b> 条
            <template v-if="parsedScope.kind === 'org_unit'">（班级/车间「{{ parsedScope.value }}」整批）</template>
            <template v-else-if="parsedScope.kind === 'batch'">（批次「{{ parsedScope.value }}」整批）</template>
            ；点处置前必须先预演，提交时会再算一遍，人数对不上会整批还原、不许提交。
          </span>
        </div>
      </div>
    </div>

    <div v-if="preview" class="card card-accent-ok">
      <div class="card-head">
        <h3>预演后果（尚未提交，名单没有任何改动）</h3>
        <div class="spacer"></div>
        <span class="badge" :class="statusBadgeClass">
          处置后未归并 {{ preview.afterTotals.unmergedCount }} 条 ｜ 异常剩余 {{ preview.afterTotals.pendingReviewCount }} 条
        </span>
      </div>
      <div class="card-body tight">
        <div class="equation" :class="preview.afterTotals.unmergedCount === 0 ? 'equation-ok' : 'equation-bad'">
          有效人数：{{ preview.beforeTotals.validRows }} → <b>{{ preview.afterTotals.validRows }}</b>
          ｜ 常规档：{{ preview.beforeTotals.regularQty }} → {{ preview.afterTotals.regularQty }}
          ｜ 特殊单列：{{ preview.beforeTotals.specialQty }} → {{ preview.afterTotals.specialQty }}
          ｜ 总套数：{{ preview.beforeTotals.accountedQty }} → {{ preview.afterTotals.accountedQty }}
        </div>
        <div class="stat-row" style="margin-top: 10px">
          <div class="stat">
            <div class="stat-label">无效行（前→后）</div>
            <div class="stat-value">{{ preview.beforeTotals.invalidRows }} → {{ preview.afterTotals.invalidRows }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">重复行（前→后）</div>
            <div class="stat-value">{{ preview.beforeTotals.duplicateRows }} → {{ preview.afterTotals.duplicateRows }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">人工覆写（前→后）</div>
            <div class="stat-value">{{ preview.beforeTotals.overrideCount }} → {{ preview.afterTotals.overrideCount }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">还剩异常没处理</div>
            <div class="stat-value">{{ preview.afterTotals.pendingReviewCount }}</div>
          </div>
        </div>

        <div class="grid-2" style="margin-top: 10px">
          <div>
            <h4>人数会增加的档（{{ increasedDeltas.length }}）</h4>
            <table v-if="increasedDeltas.length" class="data-table">
              <thead><tr><th>号型/标记</th><th>性别</th><th class="num">前</th><th class="num">后</th><th class="num">增加</th></tr></thead>
              <tbody>
                <tr v-for="delta in increasedDeltas" :key="`up-${delta.bucket.sizeCode}-${delta.bucket.gender}`">
                  <td>{{ bucketLabel(delta.bucket.sizeCode, delta.bucket.isSpecial) }}</td>
                  <td>{{ genderText(delta.bucket.gender) }}</td>
                  <td class="num">{{ delta.before }}</td>
                  <td class="num">{{ delta.after }}</td>
                  <td class="num"><b class="delta-up">+{{ delta.delta }}</b></td>
                </tr>
              </tbody>
            </table>
            <p v-else class="hint">没有人数增加的档。</p>
          </div>
          <div>
            <h4>人数会减少的档（{{ decreasedDeltas.length }}）</h4>
            <table v-if="decreasedDeltas.length" class="data-table">
              <thead><tr><th>号型/标记</th><th>性别</th><th class="num">前</th><th class="num">后</th><th class="num">减少</th></tr></thead>
              <tbody>
                <tr v-for="delta in decreasedDeltas" :key="`down-${delta.bucket.sizeCode}-${delta.bucket.gender}`">
                  <td>{{ bucketLabel(delta.bucket.sizeCode, delta.bucket.isSpecial) }}</td>
                  <td>{{ genderText(delta.bucket.gender) }}</td>
                  <td class="num">{{ delta.before }}</td>
                  <td class="num">{{ delta.after }}</td>
                  <td class="num"><b class="delta-down">{{ delta.delta }}</b></td>
                </tr>
              </tbody>
            </table>
            <p v-else class="hint">没有人数减少的档。</p>
          </div>
        </div>

        <p class="notice notice-ok" style="margin-top: 10px">
          预演处置 {{ preview.targetIds.length }} 条：{{ scopeTextOf(category, preview.request.scope, preview.targetIds.length) }}；
          处置后守恒{{ preview.afterTotals.unmergedCount === 0 ? '成立，可以导出下单表' : `仍不成立，还有 ${preview.afterTotals.unmergedCount} 条未归并` }}。
        </p>
        <div class="toolbar" style="margin-top: 8px">
          <button class="btn btn-primary" type="button" @click="submitDisposition">
            确认处置 {{ preview.targetIds.length }} 条（提交时再核对一遍）
          </button>
          <button class="btn" type="button" @click="preview = null">取消</button>
          <span class="hint">真处置后的人数 / 分堆与这份预演逐人逐条比对，对不上会自动整批还原并阻止提交。</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>整批处置留痕（每一次整批处置：哪一批、谁做的、处置多少条）</h3>
        <div class="spacer"></div>
        <button class="btn btn-sm" type="button" :disabled="dispositionList.length === 0" @click="exportDispositions">
          导出处置留痕 CSV
        </button>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>处置批次/范围</th>
              <th>类别</th>
              <th>处置动作</th>
              <th class="num">条数</th>
              <th>操作人</th>
              <th>原因</th>
              <th class="num">有效人数</th>
              <th class="num">剩余异常</th>
              <th>状态 / 回滚</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="record in dispositionList" :key="record.id" :class="record.rolledBack ? 'row-rolledback' : ''">
              <td>{{ new Date(record.at).toLocaleString('zh-CN') }}</td>
              <td>{{ record.scopeText }}</td>
              <td>{{ record.categories.map((item) => REVIEW_CATEGORY_LABEL[item]).join('、') }}</td>
              <td>{{ dispositionActionText(rule, record) }}</td>
              <td class="num">{{ record.count }}</td>
              <td>{{ record.by }}</td>
              <td>{{ record.reason }}</td>
              <td class="num">{{ record.beforeTotals.validRows }} → {{ record.afterTotals.validRows }}</td>
              <td class="num">{{ record.beforeTotals.pendingReviewCount }} → {{ record.afterTotals.pendingReviewCount }}</td>
              <td>
                <span v-if="record.rolledBack" class="badge">
                  已回滚（{{ record.rolledBackBy }}，{{ record.rolledBackAt ? new Date(record.rolledBackAt).toLocaleString('zh-CN') : '' }}）
                </span>
                <template v-else>
                  <span class="badge badge-ok">生效中</span>
                  <button
                    v-if="latestRollbackable?.id === record.id"
                    class="btn btn-sm btn-danger"
                    style="margin-left: 6px"
                    type="button"
                    @click="rollback(record)"
                  >
                    一次回滚到处置前
                  </button>
                  <span v-else class="hint" style="margin-left: 6px">需先回滚更近的处置</span>
                </template>
              </td>
            </tr>
            <tr v-if="dispositionList.length === 0">
              <td colspan="10" class="row-subtotal">还没有整批处置记录。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
