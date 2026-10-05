/**
 * 异常行批量复核（规格书 §4.3 + 本次需求）。
 *
 * 工作台三类桶：
 * - pending   待确认：有效行里 needsConfirm（数值可疑、胸腰差落不进任何档等）
 * - unmerged  没能归并：有效、非特殊、没有任何生效号型
 * - duplicate 疑似重复：possibleDuplicateOf 命中且尚未处置（同名 + 同班级 + 同身高体重）
 *
 * 关键约束：
 * 1) 「预演」与「真处置」走同一条 runMerge + buildSummary 代码路径——预演在项目深拷贝上做，
 *    真处置在真项目上做；提交时把预演结果与真处置结果逐项核对，对不上立即还原并拒绝提交。
 * 2) 每次处置保存逐人字段快照（touches），可整批回滚；回滚只还原本批动过的字段，
 *    不覆盖处置之间发生的逐行操作。只允许回滚最近一批未回滚的处置（LIFO），
 *    因为后批可能依赖前批结果，逐字段快照才能保证归并结果与人数一起回来。
 */
import type {
  BulkActionType,
  BulkDisposal,
  Gender,
  Person,
  PersonResult,
  PersonStatus,
  Project,
  ReviewBucketKey,
  SizeRule,
  SummaryRow
} from './types'
import { specialFlagLabel } from './sizeRules'
import { buildSummary, computeRuleSize, runMerge, type Summary, type SummaryTotals } from './merge'

/* ------------------------------ 三类桶归集 ------------------------------ */

export const REVIEW_BUCKETS: { key: ReviewBucketKey; label: string; hint: string; tone: 'warn' | 'danger' | 'info' }[] = [
  { key: 'pending', label: '待确认', hint: '数值可疑或胸腰差落不进任何一档，需要人工看一眼', tone: 'warn' },
  { key: 'unmerged', label: '没能归并', hint: '没有任何生效号型，这些行会导致守恒不成立', tone: 'danger' },
  { key: 'duplicate', label: '疑似重复', hint: '同名 + 同班级 + 同身高体重，只提示不自动删除', tone: 'info' }
]

/** 一行当前落入哪些桶（已判无效 / 已确认重复排除的行不在工作台上） */
export function bucketsOf(person: Person): ReviewBucketKey[] {
  if (person.status !== 'active') return []
  const buckets: ReviewBucketKey[] = []
  if (person.needsConfirm) buckets.push('pending')
  if (!person.specialFlag && !person.result) buckets.push('unmerged')
  if (person.possibleDuplicateOf) buckets.push('duplicate')
  return buckets
}

export function isReviewable(person: Person): boolean {
  return bucketsOf(person).length > 0
}

export const bucketLabel = (key: ReviewBucketKey): string =>
  REVIEW_BUCKETS.find((bucket) => bucket.key === key)?.label ?? key

export const bucketTone = (key: ReviewBucketKey): 'warn' | 'danger' | 'info' =>
  REVIEW_BUCKETS.find((bucket) => bucket.key === key)?.tone ?? 'info'

export type BucketCounts = Record<ReviewBucketKey, number>

export function reviewablePersons(project: Project): Person[] {
  return project.persons.filter(isReviewable)
}

export function countByBucket(persons: Person[]): BucketCounts {
  const counts: BucketCounts = { pending: 0, unmerged: 0, duplicate: 0 }
  for (const person of persons) {
    for (const bucket of bucketsOf(person)) counts[bucket] += 1
  }
  return counts
}

/** 去重后的工作台行数（一行可同时命中多个桶，只摆一次） */
export function reviewRowCount(project: Project): number {
  return reviewablePersons(project).length
}

/* ------------------------------ 筛选与分组 ------------------------------ */

export type ReviewFilter = {
  buckets: Set<ReviewBucketKey>
  keyword: string
}

export function matchReviewFilter(person: Person, filter: ReviewFilter): boolean {
  const buckets = bucketsOf(person)
  if (buckets.length === 0) return false
  if (![...filter.buckets].some((key) => buckets.includes(key))) return false
  const keyword = filter.keyword.trim()
  if (keyword === '') return true
  return (
    person.name.includes(keyword) ||
    person.orgUnit.includes(keyword) ||
    person.batch.includes(keyword) ||
    String(person.sourceRow ?? '') === keyword
  )
}

export type ReviewGroupKind = 'orgUnit' | 'batch'

export type ReviewGroup = {
  kind: ReviewGroupKind
  key: string
  label: string
  personIds: string[]
  bucketCounts: BucketCounts
}

/** 按班级 / 批次整批分组（分组只统计当前筛选结果，选一组即把该组在台上的行全选中） */
export function buildReviewGroups(persons: Person[], kind: ReviewGroupKind): ReviewGroup[] {
  const map = new Map<string, Person[]>()
  for (const person of persons) {
    const key = kind === 'orgUnit' ? person.orgUnit || '未填班级/车间' : person.batch || '未分批'
    const list = map.get(key)
    if (list) list.push(person)
    else map.set(key, [person])
  }
  return [...map.entries()]
    .map(([key, list]) => ({
      kind,
      key,
      label: key,
      personIds: list.map((person) => person.id),
      bucketCounts: countByBucket(list)
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
}

/* ------------------------------ 处置效果模型 ------------------------------ */

export type BulkActionParams =
  | { action: 'special'; specialFlagCode: string; reason: string; by: string }
  | { action: 'invalid'; targetStatus: Extract<PersonStatus, 'invalid' | 'duplicate'>; reason: string; by: string }
  | { action: 'assign_size'; sizeCode: string; reason: string; by: string }
  | { action: 'clear_duplicate'; reason: string; by: string }

export const BULK_ACTION_TEXT: Record<BulkActionType, string> = {
  special: '整批标记特殊体型',
  invalid: '整批判为无效/重复',
  assign_size: '整批统一填号型',
  clear_duplicate: '整批清除疑似重复'
}

export function bulkActionText(params: BulkActionParams, rule: SizeRule): string {
  switch (params.action) {
    case 'special':
      return `整批标记为「${specialFlagLabel(rule, params.specialFlagCode)}」`
    case 'invalid':
      return params.targetStatus === 'duplicate' ? '整批判为重复行并排除' : '整批判为无效行并排除'
    case 'assign_size':
      return `整批统一填号型 ${params.sizeCode}`
    case 'clear_duplicate':
      return '整批确认不是重复（清除疑似重复标记）'
  }
}

/** 处置后一人的目标字段（预演与真处置共用，保证两者结果必然一致） */
type TargetFields = {
  status: PersonStatus
  statusReason: string
  specialFlag: string | null
  needsConfirm: boolean
  possibleDuplicateOf: string | null
  result: PersonResult | null
}

function isApplicable(person: Person, params: BulkActionParams): { ok: boolean; reason: string } {
  switch (params.action) {
    case 'assign_size':
      // 已特殊单列的人不进常规档，避免整批填号时误改
      if (person.specialFlag) return { ok: false, reason: '已标记特殊体型，单列定制，不参与统一号型' }
      return { ok: true, reason: '' }
    case 'special':
    case 'invalid':
    case 'clear_duplicate':
      return { ok: true, reason: '' }
  }
}

function targetFieldsOf(person: Person, params: BulkActionParams, rule: SizeRule, at: number): TargetFields {
  switch (params.action) {
    case 'special':
      return {
        status: 'active',
        statusReason: '',
        specialFlag: params.specialFlagCode,
        needsConfirm: false,
        possibleDuplicateOf: person.possibleDuplicateOf,
        // runMerge 会对有效行重新归并；保留既有覆写（若有），否则随后重算
        result: person.result
      }
    case 'invalid':
      return {
        status: params.targetStatus,
        statusReason: params.reason,
        specialFlag: person.specialFlag,
        needsConfirm: person.needsConfirm,
        possibleDuplicateOf: person.possibleDuplicateOf,
        result: null
      }
    case 'assign_size': {
      const built = computeRuleSize(rule, person)
      return {
        status: 'active',
        statusReason: '',
        specialFlag: person.specialFlag,
        needsConfirm: false,
        possibleDuplicateOf: person.possibleDuplicateOf,
        result: {
          sizeCode: params.sizeCode,
          ruleSizeCode: built?.sizeCode ?? person.result?.ruleSizeCode ?? '',
          fit: built?.fit ?? person.result?.fit ?? null,
          ruleVersion: rule.version,
          manualOverride: { sizeCode: params.sizeCode, by: params.by, reason: params.reason, at }
        }
      }
    }
    case 'clear_duplicate':
      return {
        status: 'active',
        statusReason: '',
        specialFlag: person.specialFlag,
        // 与归并页单条「确认为不同人」一致：没有其它异常就退出待确认
        needsConfirm: person.anomaly.length > 0,
        possibleDuplicateOf: null,
        result: person.result
      }
  }
}

function applyTarget(person: Person, target: TargetFields): void {
  person.status = target.status
  person.statusReason = target.statusReason
  person.specialFlag = target.specialFlag
  person.needsConfirm = target.needsConfirm
  person.possibleDuplicateOf = target.possibleDuplicateOf
  person.result = target.result
}

/* ------------------------------ 预演（在项目深拷贝上做） ------------------------------ */

export type SizeDelta = {
  sizeCode: string
  gender: Gender
  isSpecial: boolean
  before: number
  after: number
  delta: number
}

export type RowCountKey = string

export type AffectedForecast = {
  personId: string
  skipped: boolean
  skipReason: string
}

export type DisposalForecast = {
  params: BulkActionParams
  affected: AffectedForecast[]
  affectedCount: number
  skippedCount: number
  beforeTotals: SummaryTotals
  afterTotals: SummaryTotals
  beforeRows: Map<RowCountKey, number>
  afterRows: Map<RowCountKey, number>
  sizeDeltas: SizeDelta[]
  beforeRemaining: number
  afterRemaining: number
  beforeUnmergedIds: string[]
  afterUnmergedIds: string[]
}

function rowCountsOf(summary: Summary): Map<RowCountKey, number> {
  const map = new Map<RowCountKey, number>()
  for (const row of summary.allRows) {
    map.set(`${row.isSpecial ? 'S' : 'R'}|${row.sizeCode}|${row.gender}`, row.qty)
  }
  return map
}

function cloneProject(project: Project): Project {
  return JSON.parse(JSON.stringify(project)) as Project
}

/**
 * 预演：在深拷贝项目上应用处置并重新归并，给出人数与各档变化。
 * 注意会先对真项目执行一次幂等归并，保证「处置前」基线与页面一致（不改动任何处置字段）。
 */
export function forecastDisposal(
  project: Project,
  rule: SizeRule,
  selectedIds: string[],
  params: BulkActionParams
): DisposalForecast {
  // 真项目先归并到最新（幂等），使 before 基线与页面/导出同源
  runMerge(project, rule)
  const beforeSummary = buildSummary(project, rule)

  const shadow = cloneProject(project)
  const byId = new Map(shadow.persons.map((person) => [person.id, person]))
  const at = Date.now()
  const affected: AffectedForecast[] = []
  let affectedCount = 0
  let skippedCount = 0

  for (const id of selectedIds) {
    const person = byId.get(id)
    if (!person) continue
    const applicable = isApplicable(person, params)
    if (!applicable.ok) {
      affected.push({ personId: id, skipped: true, skipReason: applicable.reason })
      skippedCount += 1
      continue
    }
    applyTarget(person, targetFieldsOf(person, params, rule, at))
    affected.push({ personId: id, skipped: false, skipReason: '' })
    affectedCount += 1
  }

  runMerge(shadow, rule)
  const afterSummary = buildSummary(shadow, rule)

  const beforeRows = rowCountsOf(beforeSummary)
  const afterRows = rowCountsOf(afterSummary)
  const deltaKeys = new Set<RowCountKey>([...beforeRows.keys(), ...afterRows.keys()])
  const sizeDeltas: SizeDelta[] = []
  for (const key of deltaKeys) {
    const before = beforeRows.get(key) ?? 0
    const after = afterRows.get(key) ?? 0
    if (before === after) continue
    const [kind, sizeCode, gender] = key.split('|')
    sizeDeltas.push({
      sizeCode,
      gender: gender as Gender,
      isSpecial: kind === 'S',
      before,
      after,
      delta: after - before
    })
  }
  sizeDeltas.sort((a, b) => a.delta - b.delta || a.sizeCode.localeCompare(b.sizeCode))

  // 处置前后还剩几条没处理（影子项目上重算三类桶）
  const remainingOf = (persons: Person[]) => persons.filter(isReviewable).length

  return {
    params,
    affected,
    affectedCount,
    skippedCount,
    beforeTotals: { ...beforeSummary.totals },
    afterTotals: { ...afterSummary.totals },
    beforeRows,
    afterRows,
    sizeDeltas,
    beforeRemaining: reviewablePersons(project).length,
    afterRemaining: remainingOf(shadow.persons),
    beforeUnmergedIds: beforeSummary.unmerged.map((item) => item.personId),
    afterUnmergedIds: afterSummary.unmerged.map((item) => item.personId)
  }
}

/* ------------------------------ 提交：真处置 + 严格核对 ------------------------------ */

export type VerifyMismatch = { field: string; expected: string; actual: string }

export function summarizeRows(rows: Map<RowCountKey, number>): string {
  return [...rows.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, qty]) => `${key}=${qty}`)
    .join(', ')
}

/** 逐项核对：人数总量、各档数量、未归并行集合、剩余待复核行数，全部一致才算通过 */
export function verifyForecast(
  forecast: DisposalForecast,
  actual: Summary,
  actualRemaining: number
): VerifyMismatch[] {
  const mismatches: VerifyMismatch[] = []
  for (const key of Object.keys(forecast.afterTotals) as (keyof SummaryTotals)[]) {
    const expected = forecast.afterTotals[key]
    const real = actual.totals[key]
    if (expected !== real) mismatches.push({ field: `人数·${key}`, expected: String(expected), actual: String(real) })
  }
  const actualRows = rowCountsOf(actual)
  const expectedText = summarizeRows(forecast.afterRows)
  const actualText = summarizeRows(actualRows)
  if (expectedText !== actualText) {
    mismatches.push({ field: '号型档分布', expected: expectedText, actual: actualText })
  }
  const actualUnmerged = actual.unmerged.map((item) => item.personId).sort()
  const expectedUnmerged = [...forecast.afterUnmergedIds].sort()
  if (actualUnmerged.join(',') !== expectedUnmerged.join(',')) {
    mismatches.push({
      field: '未归并行集合',
      expected: expectedUnmerged.join(',') || '（空）',
      actual: actualUnmerged.join(',') || '（空）'
    })
  }
  if (actualRemaining !== forecast.afterRemaining) {
    mismatches.push({
      field: '剩余待复核行数',
      expected: String(forecast.afterRemaining),
      actual: String(actualRemaining)
    })
  }
  return mismatches
}

/** 处置前逐人字段快照（只含本批可能改动的字段，回滚用） */
export function snapshotTouches(persons: Person[]): BulkDisposal['touches'] {
  return persons.map((person) => ({
    personId: person.id,
    status: person.status,
    statusReason: person.statusReason,
    specialFlag: person.specialFlag,
    needsConfirm: person.needsConfirm,
    possibleDuplicateOf: person.possibleDuplicateOf,
    result: person.result ? (JSON.parse(JSON.stringify(person.result)) as PersonResult) : null
  }))
}

export function makeDisposalId(): string {
  return `disp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export function buildScopeSummary(
  scope: { kind: 'group' | 'custom'; groupKind?: ReviewGroupKind; groupLabel?: string },
  affectedCount: number,
  buckets: ReviewBucketKey[]
): string {
  const bucketText = buckets.map(bucketLabel).join('/')
  const where =
    scope.kind === 'group'
      ? `${scope.groupKind === 'orgUnit' ? '班级/车间' : '批次'}「${scope.groupLabel ?? ''}」`
      : '自选行'
  return `${where} · ${bucketText} · ${affectedCount} 条`
}

export type ApplyDisposalInput = {
  selectedIds: string[]
  params: BulkActionParams
  buckets: ReviewBucketKey[]
  scope: { kind: 'group' | 'custom'; groupKind?: ReviewGroupKind; groupLabel?: string }
}

export type ApplyDisposalResult =
  | { ok: true; disposal: BulkDisposal; forecast: DisposalForecast; mismatches: [] }
  | { ok: false; error: string; mismatches: VerifyMismatch[] }

/**
 * 真处置：预演 → 留快照 → 应用 → 重新归并 → 与预演逐项核对。
 * 对不上立即按快照还原（归并结果一起回来）并拒绝提交，绝不让一份对不上的结果落盘。
 */
export function applyBulkDisposal(
  project: Project,
  rule: SizeRule,
  input: ApplyDisposalInput
): ApplyDisposalResult {
  if (!project.bulkDisposals) project.bulkDisposals = []
  const targets = project.persons.filter((person) => input.selectedIds.includes(person.id))
  if (targets.length === 0) return { ok: false, error: '没有选中任何可处置的行', mismatches: [] }

  // 1) 预演（内部先幂等归并真项目，基线与页面一致）
  const forecast = forecastDisposal(project, rule, input.selectedIds, input.params)
  if (forecast.affectedCount === 0) {
    return { ok: false, error: '选中的行都不适用该处置（如已特殊单列的行不能统一填常规号型），没有一条会被改动', mismatches: [] }
  }

  // 2) 留快照
  const touches = snapshotTouches(targets)

  // 3) 应用到真项目
  const at = Date.now()
  const byId = new Map(project.persons.map((person) => [person.id, person]))
  for (const id of input.selectedIds) {
    const person = byId.get(id)
    if (!person) continue
    const applicable = isApplicable(person, input.params)
    if (!applicable.ok) continue
    applyTarget(person, targetFieldsOf(person, input.params, rule, at))
  }

  // 4) 重新归并并核对
  runMerge(project, rule)
  const actual = buildSummary(project, rule)
  const actualRemaining = reviewablePersons(project).length
  const mismatches = verifyForecast(forecast, actual, actualRemaining)

  if (mismatches.length > 0) {
    // 5) 对不上：立即还原，不许提交
    restoreTouches(project, touches)
    runMerge(project, rule)
    return {
      ok: false,
      error: '预演结果与真处置不一致，已自动还原全部改动，本次处置未提交。请重新打开工作台再试。',
      mismatches
    }
  }

  // 6) 一致：写留痕批次
  const disposal: BulkDisposal = {
    id: makeDisposalId(),
    action: input.params.action,
    actionValue:
      input.params.action === 'special'
        ? input.params.specialFlagCode
        : input.params.action === 'invalid'
          ? input.params.targetStatus
          : input.params.action === 'assign_size'
            ? input.params.sizeCode
            : '',
    reason: input.params.reason,
    by: input.params.by,
    at,
    scopeSummary: buildScopeSummary(input.scope, forecast.affectedCount, input.buckets),
    orgUnit: input.scope.kind === 'group' && input.scope.groupKind === 'orgUnit' ? input.scope.groupLabel ?? '' : '',
    batch: input.scope.kind === 'group' && input.scope.groupKind === 'batch' ? input.scope.groupLabel ?? '' : '',
    buckets: [...input.buckets],
    affectedIds: forecast.affected.filter((item) => !item.skipped).map((item) => item.personId),
    affectedCount: forecast.affectedCount,
    touches,
    forecastTotals: Object.fromEntries(
      (Object.keys(forecast.afterTotals) as (keyof SummaryTotals)[]).map((key) => [key, forecast.afterTotals[key]])
    ),
    forecastRows: [...forecast.afterRows.entries()].map(([key, qty]) => {
      const [kind, sizeCode, gender] = key.split('|')
      return { sizeCode, gender: gender as Gender, isSpecial: kind === 'S', qty }
    }),
    forecastRemaining: forecast.afterRemaining,
    forecastUnmerged: forecast.afterUnmergedIds.length,
    rolledBack: false,
    rolledBackAt: null,
    rollbackBy: null
  }
  project.bulkDisposals.push(disposal)
  return { ok: true, disposal, forecast, mismatches: [] }
}

/** 按快照还原字段（真项目与克隆项目共用） */
export function restoreTouches(
  project: Project,
  touches: BulkDisposal['touches']
): void {
  const byId = new Map(project.persons.map((person) => [person.id, person]))
  for (const touch of touches) {
    const person = byId.get(touch.personId)
    if (!person) continue
    person.status = touch.status
    person.statusReason = touch.statusReason
    person.specialFlag = touch.specialFlag
    person.needsConfirm = touch.needsConfirm
    person.possibleDuplicateOf = touch.possibleDuplicateOf
    person.result = touch.result ? (JSON.parse(JSON.stringify(touch.result)) as PersonResult) : null
  }
}

/* ------------------------------ 整批回滚（LIFO） ------------------------------ */

export type RollbackResult =
  | { ok: true; disposal: BulkDisposal; mismatches: [] }
  | { ok: false; error: string; mismatches: VerifyMismatch[] }

/** 只能回滚最近一批未回滚的处置（更早的批次被后续批次依赖，回滚会产生交叉覆盖） */
export function canRollback(project: Project, disposalId: string): boolean {
  const list = project.bulkDisposals ?? []
  const index = list.findIndex((item) => item.id === disposalId)
  if (index < 0 || list[index].rolledBack) return false
  for (let i = index + 1; i < list.length; i += 1) {
    if (!list[i].rolledBack) return false
  }
  return true
}

/**
 * 整批回滚：先在克隆上按快照还原并算出「应该回到的结果」，
 * 再在真项目上还原、重新归并，逐项核对一致后才把批次标记为已回滚。
 * 回滚后归并结果、各档人数、剩余待复核行数一起回到处置之前。
 */
export function rollbackBulkDisposal(
  project: Project,
  rule: SizeRule,
  disposalId: string,
  by: string
): RollbackResult {
  const list = project.bulkDisposals ?? []
  const disposal = list.find((item) => item.id === disposalId)
  if (!disposal) return { ok: false, error: '找不到该处置批次', mismatches: [] }
  if (disposal.rolledBack) return { ok: false, error: '该批次已回滚，不能重复回滚', mismatches: [] }
  if (!canRollback(project, disposalId)) {
    return { ok: false, error: '只能回滚最近一批未回滚的处置；请先回滚之后的批次', mismatches: [] }
  }

  // 期望结果：克隆项目上还原本批快照
  const shadow = cloneProject(project)
  restoreTouches(shadow, disposal.touches)
  runMerge(shadow, rule)
  const expectedSummary = buildSummary(shadow, rule)
  const expectedRemaining = reviewablePersons(shadow).length

  // 真项目还原
  restoreTouches(project, disposal.touches)
  runMerge(project, rule)
  const actualSummary = buildSummary(project, rule)
  const actualRemaining = reviewablePersons(project).length

  const mismatches: VerifyMismatch[] = []
  const expectedRows = rowCountsOf(expectedSummary)
  const actualRows = rowCountsOf(actualSummary)
  if (summarizeRows(expectedRows) !== summarizeRows(actualRows)) {
    mismatches.push({ field: '号型档分布', expected: summarizeRows(expectedRows), actual: summarizeRows(actualRows) })
  }
  for (const key of Object.keys(expectedSummary.totals) as (keyof SummaryTotals)[]) {
    if (expectedSummary.totals[key] !== actualSummary.totals[key]) {
      mismatches.push({
        field: `人数·${key}`,
        expected: String(expectedSummary.totals[key]),
        actual: String(actualSummary.totals[key])
      })
    }
  }
  if (expectedRemaining !== actualRemaining) {
    mismatches.push({ field: '剩余待复核行数', expected: String(expectedRemaining), actual: String(actualRemaining) })
  }
  if (mismatches.length > 0) {
    return { ok: false, error: '回滚校验未通过，已停止；请重新归并后再核对数据', mismatches }
  }

  disposal.rolledBack = true
  disposal.rolledBackAt = Date.now()
  disposal.rollbackBy = by
  return { ok: true, disposal, mismatches: [] }
}

/* ------------------------------ 留痕展示 ------------------------------ */

export function disposalActionLabel(disposal: BulkDisposal, rule: SizeRule): string {
  switch (disposal.action) {
    case 'special':
      return `标记特殊体型「${specialFlagLabel(rule, disposal.actionValue)}」`
    case 'invalid':
      return disposal.actionValue === 'duplicate' ? '判为重复行并排除' : '判为无效行并排除'
    case 'assign_size':
      return `统一填号型 ${disposal.actionValue}`
    case 'clear_duplicate':
      return '确认不是重复，清除疑似重复标记'
  }
}

export function disposalTargetSummary(disposal: BulkDisposal): SummaryRow[] {
  return disposal.forecastRows
    .map((row) => ({ ...row }))
    .sort((a, b) => a.sizeCode.localeCompare(b.sizeCode))
}

export function activeDisposals(project: Project): BulkDisposal[] {
  return (project.bulkDisposals ?? []).filter((item) => !item.rolledBack)
}
