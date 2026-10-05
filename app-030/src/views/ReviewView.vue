<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ensureMerged, flushProject, getProject, getRule, persistProject, store } from '../logic/store'
import { buildSummary, conservationText } from '../logic/merge'
import {
  REVIEW_BUCKETS,
  activeDisposals,
  applyBulkDisposal,
  bucketLabel,
  bucketTone,
  bucketsOf,
  buildReviewGroups,
  canRollback,
  countByBucket,
  disposalActionLabel,
  forecastDisposal,
  isReviewable,
  matchReviewFilter,
  reviewablePersons,
  rollbackBulkDisposal,
  type BulkActionParams,
  type ReviewGroupKind
} from '../logic/review'
import { bulkDisposalRows } from '../logic/exporter'
import { downloadText, toCsvText } from '../logic/csv'
import { isSizeCodeValid, normalizeSizeCodeInput, specialFlagLabel } from '../logic/sizeRules'
import { chestWaistDiffCm, formatCm } from '../logic/precision'
import type { BulkActionType, Person, PersonStatus, ReviewBucketKey } from '../logic/types'

const route = useRoute()
const project = computed(() => getProject(route.params.id as string))
const rule = computed(() => getRule(project.value?.ruleVersion ?? store.rules[0].version))

if (project.value) ensureMerged(project.value)

const summary = computed(() => (project.value ? buildSummary(project.value, rule.value) : null))

/* ------------------------------ 三类桶与筛选 ------------------------------ */

const enabledBuckets = ref<Set<ReviewBucketKey>>(new Set(['pending', 'unmerged', 'duplicate']))
const keyword = ref('')
const groupKind = ref<ReviewGroupKind>('orgUnit')

function toggleBucket(key: ReviewBucketKey): void {
  const next = new Set(enabledBuckets.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  enabledBuckets.value = next
}

const allReviewable = computed(() => (project.value ? reviewablePersons(project.value) : []))
const bucketCounts = computed(() => countByBucket(allReviewable.value))

const filteredPersons = computed(() =>
  allReviewable.value.filter((person) =>
    matchReviewFilter(person, { buckets: enabledBuckets.value, keyword: keyword.value })
  )
)

const groups = computed(() => buildReviewGroups(filteredPersons.value, groupKind.value))

/* ------------------------------ 勾选（按班级 / 批次整批选中） ------------------------------ */

const selectedIds = ref<Set<string>>(new Set())

function isSelected(id: string): boolean {
  return selectedIds.value.has(id)
}

function toggleRow(id: string): void {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

/** 选中某班级 / 某批次当前在台上的全部行（再点一次取消） */
function toggleGroup(group: { personIds: string[] }): void {
  const next = new Set(selectedIds.value)
  const allIn = group.personIds.every((id) => next.has(id))
  for (const id of group.personIds) {
    if (allIn) next.delete(id)
    else next.add(id)
  }
  selectedIds.value = next
}

function groupChecked(group: { personIds: string[] }): boolean {
  return group.personIds.some((id) => selectedIds.value.has(id))
}

function groupAllChecked(group: { personIds: string[] }): boolean {
  return group.personIds.every((id) => selectedIds.value.has(id))
}

function selectAllFiltered(): void {
  selectedIds.value = new Set(filteredPersons.value.map((person) => person.id))
}

function clearSelection(): void {
  selectedIds.value = new Set()
}

const selectedPersons = computed(() =>
  (project.value?.persons ?? []).filter((person) => selectedIds.value.has(person.id) && isReviewable(person))
)
const selectedBucketCounts = computed(() => countByBucket(selectedPersons.value))

/* ------------------------------ 处置表单 ------------------------------ */

const form = reactive<{
  action: BulkActionType
  specialFlagCode: string
  targetStatus: Extract<PersonStatus, 'invalid' | 'duplicate'>
  sizeCode: string
  reason: string
  by: string
}>({
  action: 'special',
  specialFlagCode: '',
  targetStatus: 'invalid',
  sizeCode: '',
  reason: '',
  by: store.operator
})

const quickReasons: Record<BulkActionType, string[]> = {
  special: ['现场复核为特殊体型，单列定制', '加肥加大，与厂方电话确认', '体型超常规档，单独量体定制'],
  invalid: ['现场联系不上，信息无法核对，整批判无效', '重复登记 / 重复录入，排除', '纸张记录作废，数据无效'],
  assign_size: ['胸腰差记录疑似有误，经与班主任核对统一归此号型', '现场复核实测一致，整批按此号型下单', '厂家建议同批统一号型'],
  clear_duplicate: ['已逐人核对，同名不同人，全部保留']
}

const formError = ref('')

function buildParams(): { params: BulkActionParams | null; error: string } {
  const reason = form.reason.trim()
  const by = form.by.trim()
  if (by === '') return { params: null, error: '请填写操作人（每一批处置都要留是谁做的）' }
  if (reason === '') return { params: null, error: '请写明处置原因（整批处置必须写明原因）' }
  switch (form.action) {
    case 'special':
      if (!form.specialFlagCode) return { params: null, error: '请选择一种特殊体型标记' }
      return { params: { action: 'special', specialFlagCode: form.specialFlagCode, reason, by }, error: '' }
    case 'invalid':
      return { params: { action: 'invalid', targetStatus: form.targetStatus, reason, by }, error: '' }
    case 'assign_size': {
      const code = normalizeSizeCodeInput(form.sizeCode)
      if (!isSizeCodeValid(rule.value, code)) {
        return { params: null, error: '号型格式不正确，应形如 170/88A（型别为 Y/A/B/C）' }
      }
      return { params: { action: 'assign_size', sizeCode: code, reason, by }, error: '' }
    }
    case 'clear_duplicate':
      return { params: { action: 'clear_duplicate', reason, by }, error: '' }
  }
}

/**
 * 预演：纯计算（在项目深拷贝上做），与真处置共用同一条归并 + 汇总路径。
 * 勾选或动作一变就重算，提交前看到的数字就是提交后的数字。
 */
const preview = computed(() => {
  const current = project.value
  if (!current || selectedPersons.value.length === 0) return null
  const built = buildParams()
  if (!built.params) return { params: null as BulkActionParams | null, error: built.error }
  const forecast = forecastDisposal(current, rule.value, selectedPersons.value.map((p) => p.id), built.params)
  return { params: built.params, error: '', forecast }
})

const message = ref('')
const messageKind = ref<'ok' | 'error'>('ok')
const submitting = ref(false)

function currentScope(): { kind: 'group' | 'custom'; groupKind?: ReviewGroupKind; groupLabel?: string } {
  // 勾选恰好等于当前筛选下某个班级/批次整组时按组留痕；当前筛选只有整组一组时也算
  const selected = new Set(selectedPersons.value.map((person) => person.id))
  if (selected.size === filteredPersons.value.length && groups.value.length === 1) {
    return { kind: 'group', groupKind: groupKind.value, groupLabel: groups.value[0].label }
  }
  const exact = groups.value.find((group) => group.personIds.length === selected.size && group.personIds.every((id) => selected.has(id)))
  if (exact) return { kind: 'group', groupKind: groupKind.value, groupLabel: exact.label }
  return { kind: 'custom' }
}

async function submit(): Promise<void> {
  const current = project.value
  if (!current || !preview.value?.params || !preview.value.forecast) return
  if (submitting.value) return
  submitting.value = true
  try {
    const result = applyBulkDisposal(current, rule.value, {
      selectedIds: selectedPersons.value.map((person) => person.id),
      params: preview.value.params,
      buckets: [...enabledBuckets.value],
      scope: currentScope()
    })
    if (!result.ok) {
      messageKind.value = 'error'
      message.value = result.error
      formError.value = result.mismatches
        .map((item) => `${item.field}：演算 ${item.expected} ≠ 实际 ${item.actual}`)
        .join('；')
      return
    }
    persistProject(current, true)
    await flushProject(current)
    const after = result.forecast.afterTotals
    messageKind.value = 'ok'
    message.value =
      `已整批处置 ${result.disposal.affectedCount} 条（${disposalActionLabel(result.disposal, rule.value)}）：` +
      `有效人数 ${result.forecast.beforeTotals.validRows} → ${after.validRows}，` +
      `剩余待复核 ${result.forecast.afterRemaining} 条。演算与真处置逐项一致，已留痕并可整批回滚。`
    formError.value = ''
    form.reason = ''
    selectedIds.value = new Set()
  } finally {
    submitting.value = false
  }
}

/* ------------------------------ 整批回滚 ------------------------------ */

const disposals = computed(() => {
  if (!project.value) return []
  const list = project.value.bulkDisposals ?? []
  const order = new Map(list.map((item, index) => [item.id, index]))
  return [...list].sort((a, b) => b.at - a.at || (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0))
})
const activeCount = computed(() => (project.value ? activeDisposals(project.value).length : 0))

async function rollback(disposalId: string): Promise<void> {
  const current = project.value
  if (!current) return
  const disposal = disposals.value.find((item) => item.id === disposalId)
  if (!disposal) return
  if (!window.confirm(`确认整批回滚「${disposalActionLabel(disposal, rule.value)}」（${disposal.affectedCount} 条）？\n归并结果与各档人数将一起回到处置之前。`)) {
    return
  }
  const result = rollbackBulkDisposal(current, rule.value, disposalId, form.by.trim() || store.operator)
  if (!result.ok) {
    messageKind.value = 'error'
    message.value = result.error
    return
  }
  persistProject(current, true)
  await flushProject(current)
  messageKind.value = 'ok'
  message.value = `已整批回滚 ${result.disposal.affectedCount} 条，归并结果与人数已恢复到处置之前`
}

function exportLog(): void {
  const current = project.value
  if (!current) return
  const rows = bulkDisposalRows({ project: current, rule: rule.value, operator: store.operator, generatedAt: new Date() })
  downloadText(toCsvText(rows), `${current.name.replace(/[\\/:*?"<>|\s]/g, '_')}-批量复核留痕.csv`)
}

/* ------------------------------ 展示辅助 ------------------------------ */

const genderText = (gender: string): string => (gender === 'male' ? '男' : '女')

function personHint(person: Person): string {
  if (person.statusReason) return person.statusReason
  if (person.possibleDuplicateOf) return `疑似重复：${person.possibleDuplicateOf}`
  if (!person.result) return '胸腰差落不进任何一档，未自动归并'
  return '数值可疑，请现场复核'
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN')
}

function groupToneClass(tone: 'warn' | 'danger' | 'info'): string {
  return tone === 'danger' ? 'badge-danger' : tone === 'warn' ? 'badge-warn' : 'badge-info'
}
</script>

<template>
  <section v-if="!project || !summary" class="empty">项目不存在，请回到项目列表重新选择。</section>
  <section v-else>
    <div class="page-head">
      <div>
        <h1>{{ project.name }} · 异常行批量复核工作台</h1>
        <div class="sub">
          依据规则版本 <b>{{ project.ruleVersion }}</b>｜待确认、没能归并、疑似重复三类摆在一起，按班级 / 批次整批选中后一次处置
        </div>
      </div>
      <div class="spacer"></div>
      <div class="toolbar">
        <RouterLink class="btn btn-sm" :to="`/merge/${project.id}`">返回归并</RouterLink>
        <RouterLink class="btn btn-sm btn-primary" :to="`/summary/${project.id}`">查看汇总与守恒</RouterLink>
      </div>
    </div>

    <p v-if="message" class="notice" :class="messageKind === 'ok' ? 'notice-ok' : 'notice-error'">{{ message }}</p>

    <div class="card" :class="allReviewable.length ? 'card-accent-warn' : 'card-accent-ok'">
      <div class="card-head">
        <h3>当前态势</h3>
        <div class="spacer"></div>
        <span class="badge" :class="summary.conserved ? 'badge-ok' : 'badge-danger'">
          {{ summary.conserved ? '守恒通过' : `不守恒：${summary.unmerged.length} 行未归并` }}
        </span>
      </div>
      <div class="card-body tight">
        <div class="equation" :class="summary.conserved ? 'equation-ok' : 'equation-bad'">{{ conservationText(summary) }}</div>
        <div class="stat-row" style="margin-top: 10px">
          <div class="stat"><div class="stat-label">总录入</div><div class="stat-value">{{ summary.totals.totalRows }}</div></div>
          <div class="stat"><div class="stat-label">有效人数</div><div class="stat-value">{{ summary.totals.validRows }}</div></div>
          <div class="stat"><div class="stat-label">常规档</div><div class="stat-value">{{ summary.totals.regularQty }}</div></div>
          <div class="stat"><div class="stat-label">特殊单列</div><div class="stat-value">{{ summary.totals.specialQty }}</div></div>
          <div class="stat">
            <div class="stat-label">待复核（三类去重）</div>
            <div class="stat-value" :class="allReviewable.length ? 'bad' : 'ok'">{{ allReviewable.length }}</div>
          </div>
        </div>
      </div>
    </div>

    <template v-if="allReviewable.length === 0">
      <div class="card card-accent-ok">
        <div class="empty">
          没有待复核的异常行：待确认、没能归并、疑似重复三类都已清零。可以去「汇总与守恒」核对后导出下单表。
        </div>
      </div>
    </template>

    <template v-else>
      <!-- 三类桶 + 分组 + 搜索 -->
      <div class="card">
        <div class="card-head">
          <h3>工作台（{{ filteredPersons.length }} 行）</h3>
          <div class="spacer"></div>
          <div class="toolbar">
            <button
              v-for="bucket in REVIEW_BUCKETS"
              :key="bucket.key"
              type="button"
              class="btn btn-sm"
              :class="enabledBuckets.has(bucket.key) ? groupToneClass(bucketTone(bucket.key)) : ''"
              :style="enabledBuckets.has(bucket.key) ? '' : 'opacity: 0.45'"
              @click="toggleBucket(bucket.key)"
            >
              {{ bucket.label }} {{ bucketCounts[bucket.key] }}
            </button>
            <select v-model="groupKind" class="select btn-sm" style="width: auto">
              <option value="orgUnit">按班级/车间分组</option>
              <option value="batch">按批次分组</option>
            </select>
            <input v-model="keyword" class="input" style="width: 180px" type="search" placeholder="姓名 / 班级 / 批次 / 行号" />
          </div>
        </div>
        <div class="card-body tight">
          <p class="hint">
            一行可能同时命中多类（例如胸腰差落不进档又疑似重复）；勾选分组前的复选框即整批选中该班级 / 批次当前在台上的行。
          </p>

          <!-- 按班级 / 批次整批选中 -->
          <div class="review-groups">
            <div v-for="group in groups" :key="group.kind + group.key" class="review-group-chip">
              <label class="review-group-label">
                <input
                  type="checkbox"
                  :checked="groupAllChecked(group)"
                  :indeterminate.prop="groupChecked(group) && !groupAllChecked(group)"
                  @change="toggleGroup(group)"
                />
                <b>{{ group.label }}</b>
                <span class="hint">{{ group.personIds.length }} 行</span>
              </label>
              <div class="review-group-badges">
                <span v-for="bucket in REVIEW_BUCKETS" :key="bucket.key">
                  <span
                    v-if="group.bucketCounts[bucket.key] > 0"
                    class="badge"
                    :class="groupToneClass(bucketTone(bucket.key))"
                  >
                    {{ bucket.label }} {{ group.bucketCounts[bucket.key] }}
                  </span>
                </span>
              </div>
            </div>
          </div>

          <div class="toolbar" style="margin: 8px 0">
            <button class="btn btn-sm" type="button" @click="selectAllFiltered">全选当前筛选（{{ filteredPersons.length }}）</button>
            <button class="btn btn-sm" type="button" @click="clearSelection">清空勾选</button>
            <div class="spacer"></div>
            <span class="hint">
              已选 <b>{{ selectedPersons.length }}</b> 行
              <span v-if="selectedPersons.length">
                （待确认 {{ selectedBucketCounts.pending }} / 未归并 {{ selectedBucketCounts.unmerged }} / 疑似重复
                {{ selectedBucketCounts.duplicate }}）
              </span>
            </span>
          </div>

          <div class="table-scroll" style="max-height: 420px">
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width: 36px"></th>
                  <th class="num">行号</th>
                  <th>姓名</th>
                  <th>性别</th>
                  <th>班级/车间</th>
                  <th>批次</th>
                  <th class="num">身高</th>
                  <th class="num">胸围</th>
                  <th class="num">腰围</th>
                  <th class="num">胸腰差</th>
                  <th>命中类型</th>
                  <th>规则号型</th>
                  <th>提示</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="person in filteredPersons" :key="person.id">
                  <td>
                    <input type="checkbox" :checked="isSelected(person.id)" @change="toggleRow(person.id)" />
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
                    <span
                      v-for="bucket in bucketsOf(person)"
                      :key="bucket"
                      class="badge"
                      :class="groupToneClass(bucketTone(bucket))"
                      style="margin-right: 3px"
                    >
                      {{ bucketLabel(bucket) }}
                    </span>
                  </td>
                  <td>{{ person.result?.ruleSizeCode || '未归并' }}</td>
                  <td class="hint" style="white-space: normal; min-width: 180px">{{ personHint(person) }}</td>
                </tr>
                <tr v-if="filteredPersons.length === 0" class="row-subtotal">
                  <td colspan="13">当前筛选下没有异常行</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 整批处置 + 预演 -->
      <div v-if="selectedPersons.length > 0" class="card card-accent-warn">
        <div class="card-head">
          <h3>整批处置（{{ selectedPersons.length }} 行）——先演算后果，确认一致再提交</h3>
          <div class="spacer"></div>
          <span class="badge badge-warn">演算与真处置对不上就不许提交</span>
        </div>
        <div class="card-body">
          <div class="form-grid">
            <label class="field">
              <span class="field-label">处置方式 <b class="req">*</b></span>
              <select v-model="form.action" class="select">
                <option value="special">整批打上同一种特殊体型标记</option>
                <option value="invalid">整批判成无效 / 重复行</option>
                <option value="assign_size">整批填同一个号型（写明原因，逐人留痕）</option>
                <option value="clear_duplicate">整批确认不是重复（清除疑似重复标记）</option>
              </select>
            </label>
            <label v-if="form.action === 'special'" class="field">
              <span class="field-label">特殊体型标记 <b class="req">*</b></span>
              <select v-model="form.specialFlagCode" class="select">
                <option value="">请选择…</option>
                <option v-for="flag in rule.specialFlags" :key="flag.code" :value="flag.code">{{ flag.label }}</option>
              </select>
            </label>
            <label v-if="form.action === 'invalid'" class="field">
              <span class="field-label">判为 <b class="req">*</b></span>
              <select v-model="form.targetStatus" class="select">
                <option value="invalid">无效行（信息无法核对）</option>
                <option value="duplicate">重复行（确认重复并排除）</option>
              </select>
            </label>
            <label v-if="form.action === 'assign_size'" class="field">
              <span class="field-label">统一号型 <b class="req">*</b></span>
              <input v-model="form.sizeCode" class="input" type="text" placeholder="170/88A" list="review-size-candidates" />
              <datalist id="review-size-candidates">
                <option v-for="row in summary.allRows.filter((r) => !r.isSpecial)" :key="`${row.sizeCode}-${row.gender}`" :value="row.sizeCode" />
              </datalist>
            </label>
            <label class="field">
              <span class="field-label">操作人 <b class="req">*</b></span>
              <input v-model="form.by" class="input" type="text" maxlength="16" />
            </label>
            <label class="field" style="grid-column: 1 / -1">
              <span class="field-label">处置原因 <b class="req">*</b>（整批同因，留痕可查）</span>
              <input v-model="form.reason" class="input" type="text" list="quick-reasons" placeholder="如：现场复核为特殊体型，单列定制" />
              <datalist id="quick-reasons">
                <option v-for="text in quickReasons[form.action]" :key="text" :value="text" />
              </datalist>
            </label>
          </div>

          <!-- 预演结果 -->
          <div class="forecast-box" style="margin-top: 12px">
            <div v-if="preview?.error || !preview?.forecast" class="notice notice-warn">
              {{ preview?.error || '填写处置方式后这里会演算后果' }}
            </div>
            <template v-else>
              <div class="forecast-head">
                <b>预演后果</b>
                <span class="hint">（在项目副本上按同一套归并规则演算，提交时会再逐项核对，不一致自动还原）</span>
              </div>
              <div class="stat-row" style="margin-top: 8px">
                <div class="stat">
                  <div class="stat-label">有效人数</div>
                  <div class="stat-value">
                    {{ preview.forecast.beforeTotals.validRows }}
                    <span class="forecast-arrow">→</span>
                    <b :class="preview.forecast.afterTotals.validRows === preview.forecast.beforeTotals.validRows ? '' : 'bad'">
                      {{ preview.forecast.afterTotals.validRows }}
                    </b>
                  </div>
                </div>
                <div class="stat">
                  <div class="stat-label">常规档合计</div>
                  <div class="stat-value">
                    {{ preview.forecast.beforeTotals.regularQty }}
                    <span class="forecast-arrow">→</span>
                    <b>{{ preview.forecast.afterTotals.regularQty }}</b>
                  </div>
                </div>
                <div class="stat">
                  <div class="stat-label">特殊单列</div>
                  <div class="stat-value">
                    {{ preview.forecast.beforeTotals.specialQty }}
                    <span class="forecast-arrow">→</span>
                    <b>{{ preview.forecast.afterTotals.specialQty }}</b>
                  </div>
                </div>
                <div class="stat">
                  <div class="stat-label">未归并行</div>
                  <div class="stat-value">
                    {{ preview.forecast.beforeUnmergedIds.length }}
                    <span class="forecast-arrow">→</span>
                    <b :class="preview.forecast.afterUnmergedIds.length === 0 ? 'ok' : 'bad'">
                      {{ preview.forecast.afterUnmergedIds.length }}
                    </b>
                  </div>
                </div>
                <div class="stat">
                  <div class="stat-label">剩余待复核</div>
                  <div class="stat-value">
                    {{ preview.forecast.beforeRemaining }}
                    <span class="forecast-arrow">→</span>
                    <b :class="preview.forecast.afterRemaining === 0 ? 'ok' : ''">{{ preview.forecast.afterRemaining }}</b>
                  </div>
                </div>
              </div>
              <p v-if="preview.forecast.skippedCount > 0" class="notice notice-warn" style="margin-top: 8px">
                有 {{ preview.forecast.skippedCount }} 行不适用本处置（已特殊单列的行不参与统一号型），将原样跳过，实际处置
                {{ preview.forecast.affectedCount }} 行。
              </p>
              <div v-if="preview.forecast.sizeDeltas.length" class="table-wrap" style="margin-top: 8px">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>号型 / 特殊档</th>
                      <th>性别</th>
                      <th class="num">处置前</th>
                      <th class="num">处置后</th>
                      <th class="num">变化</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="delta in preview.forecast.sizeDeltas" :key="`${delta.isSpecial}-${delta.sizeCode}-${delta.gender}`">
                      <td>
                        <b>{{ delta.isSpecial ? specialFlagLabel(rule, delta.sizeCode) : delta.sizeCode }}</b>
                        <span v-if="delta.isSpecial" class="badge badge-warn" style="margin-left: 4px">特殊</span>
                      </td>
                      <td>{{ genderText(delta.gender) }}</td>
                      <td class="num">{{ delta.before }}</td>
                      <td class="num">{{ delta.after }}</td>
                      <td class="num" :class="delta.delta > 0 ? 'delta-up' : 'delta-down'">
                        {{ delta.delta > 0 ? `+${delta.delta}` : delta.delta }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-else class="hint" style="margin-top: 8px">号型档人数不发生变化（如仅清除疑似重复标记、数据本身保留）。</p>

              <div class="toolbar" style="margin-top: 10px">
                <button class="btn btn-primary" type="button" :disabled="submitting" @click="submit">
                  确认整批处置 {{ preview.forecast.affectedCount }} 行
                </button>
                <span class="hint">提交时再次演算并与真处置逐项核对：有效人数、各档人数、未归并集合、剩余条数；对不上自动还原且不留痕。</span>
              </div>
            </template>
          </div>
          <p v-if="formError" class="notice notice-error" style="margin-top: 10px">{{ formError }}</p>
        </div>
      </div>
    </template>

    <!-- 留痕 -->
    <div class="card">
      <div class="card-head">
        <h3>整批处置留痕（{{ disposals.length }} 批）</h3>
        <div class="spacer"></div>
        <span class="hint">每一批都记录是哪一批、谁做的、处置了多少条；最近一批未回滚的处置可一键整批回滚</span>
        <button class="btn btn-sm" type="button" :disabled="disposals.length === 0" @click="exportLog">导出留痕 CSV</button>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>处置批次（范围）</th>
              <th>处置方式</th>
              <th class="num">条数</th>
              <th>原因</th>
              <th>操作人</th>
              <th class="num">处置后有效人数</th>
              <th class="num">处置后剩余待复核</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="disposal in disposals" :key="disposal.id" :class="disposal.rolledBack ? 'row-rolledback' : ''">
              <td>{{ formatTime(disposal.at) }}</td>
              <td style="white-space: normal; min-width: 180px">{{ disposal.scopeSummary }}</td>
              <td>{{ disposalActionLabel(disposal, rule) }}</td>
              <td class="num">{{ disposal.affectedCount }}</td>
              <td style="white-space: normal; min-width: 180px">{{ disposal.reason }}</td>
              <td>{{ disposal.by }}</td>
              <td class="num">{{ disposal.forecastTotals.validRows ?? '—' }}</td>
              <td class="num">{{ disposal.forecastRemaining }}</td>
              <td>
                <span v-if="disposal.rolledBack" class="badge">已回滚（{{ disposal.rollbackBy }}）</span>
                <span v-else class="badge badge-ok">生效中</span>
              </td>
              <td>
                <button
                  v-if="!disposal.rolledBack"
                  class="btn btn-sm btn-danger"
                  type="button"
                  :disabled="!canRollback(project, disposal.id)"
                  :title="canRollback(project, disposal.id) ? '' : '只能回滚最近一批未回滚的处置'"
                  @click="rollback(disposal.id)"
                >
                  整批回滚
                </button>
                <span v-else class="hint">
                  {{ disposal.rolledBackAt ? formatTime(disposal.rolledBackAt) : '' }}
                </span>
              </td>
            </tr>
            <tr v-if="disposals.length === 0" class="row-subtotal">
              <td colspan="10">还没有整批处置记录</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card-body tight">
        <p class="hint">
          回滚把该批逐人字段（有效/无效状态、特殊标记、生效号型、待确认与疑似重复标记）恢复到处置之前，再按规则版本
          {{ project.ruleVersion }} 重新归并；页面、归并结果与导出表看到的都是恢复后的同一份结果。
          当前生效中的整批处置 {{ activeCount }} 批。
        </p>
      </div>
    </div>
  </section>
</template>
