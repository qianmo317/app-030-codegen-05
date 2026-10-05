/**
 * 异常行批量复核工作台（规格书 §4.3 的批量化实现）。
 *
 * 把三类异常行摆在同一个工作台上：
 *   pending    待确认（数值可疑：胸腰差为负、胸围小于身高一半…，仍计入有效人数）
 *   unmerged   未能归并（胸腰差落不进任何一型别区间）
 *   duplicate  疑似重复（同名 + 同班级 + 同身高体重，只提示不自动删除）
 *
 * 支持按班级 / 批次整批选中，一次打上同一种特殊体型标记、整批判成无效行、
 * 整批确认重复并排除、或整批填同一个号型并写明原因。
 *
 * 所有处置都先在项目克隆上「预演」，提交时在真项目上再算一遍并逐字段比对；
 * 预演人数与真处置不一致则整批回退、拒绝提交。整批处置可整体回滚，
 * 回滚后归并结果与人数跟着回到处置之前——页面、归并结果、导出表因此始终同一份。
 */
import { runMerge, buildSummary, computeRuleSize, type Summary } from './merge'
import { isSizeCodeValid, normalizeSizeCodeInput, specialFlagLabel } from './sizeRules'
import type {
  BatchDisposition,
  DispositionAction,
  DispositionScope,
  Person,
  PersonResult,
  PersonSnapshot,
  Project,
  ReviewCategory,
  SizeRule,
  TotalsSnapshot
} from './types'

export const REVIEW_CATEGORY_LABEL: Record<ReviewCategory, string> = {
  pending: '待确认',
  unmerged: '没能归并',
  duplicate: '疑似重复'
}

export const DISPOSITION_ACTION_LABEL: Record<DispositionAction, string> = {
  flag_special: '标记同一种特殊体型',
  mark_invalid: '整批判为无效行',
  mark_duplicate: '确认重复并排除',
  assign_size: '整批填同一个号型'
}

/* ------------------------------- 工作台选行 ------------------------------- */

/** 待确认：有效行里仍需要人工确认的（疑似重复的在「疑似重复」类单列） */
export function isPendingPerson(person: Person): boolean {
  return person.status === 'active' && person.needsConfirm && person.possibleDuplicateOf === null
}

/** 没能归并：有效行里分不进任何号型桶（胸腰差落不进任何一型别档） */
export function isUnmergedPerson(person: Person): boolean {
  return person.status === 'active' && !person.specialFlag && !person.result
}

/** 疑似重复：导入时按同名 + 同班级 + 同身高体重识别，只提示不删除；已排除/判无效的算处理过，不再占工作台 */
export function isDuplicateSuspect(person: Person): boolean {
  return person.possibleDuplicateOf !== null && person.status === 'active'
}

export function reviewCategoryOf(person: Person, category: ReviewCategory): boolean {
  if (category === 'pending') return isPendingPerson(person)
  if (category === 'unmerged') return isUnmergedPerson(person)
  return isDuplicateSuspect(person)
}

/** 三类异常的并集（去重）：工作台「还剩几条没处理」按人头计 */
export function isAnyReviewPerson(person: Person): boolean {
  return isPendingPerson(person) || isUnmergedPerson(person) || isDuplicateSuspect(person)
}

export function listReviewRows(project: Project, category: ReviewCategory): Person[] {
  return project.persons.filter((person) => reviewCategoryOf(person, category))
}

export type WorkbenchStats = {
  pending: number
  unmerged: number
  duplicate: number
  /** 三类并集去重后的总条数 */
  totalUnique: number
  byOrgUnit: { orgUnit: string; pending: number; unmerged: number; duplicate: number; total: number }[]
  byBatch: { batch: string; pending: number; unmerged: number; duplicate: number; total: number }[]
}

export function workbenchStats(project: Project): WorkbenchStats {
  const orgMap = new Map<string, { pending: number; unmerged: number; duplicate: number; total: number; ids: Set<string> }>()
  const batchMap = new Map<string, { pending: number; unmerged: number; duplicate: number; total: number; ids: Set<string> }>()
  let pending = 0
  let unmerged = 0
  let duplicate = 0
  const anyIds = new Set<string>()

  const bump = (
    map: Map<string, { pending: number; unmerged: number; duplicate: number; total: number; ids: Set<string> }>,
    key: string,
    person: Person,
    category: ReviewCategory
  ): void => {
    if (!map.has(key)) map.set(key, { pending: 0, unmerged: 0, duplicate: 0, total: 0, ids: new Set() })
    const group = map.get(key)!
    group[category] += 1
    if (!group.ids.has(person.id)) {
      group.ids.add(person.id)
      group.total += 1
    }
  }

  for (const person of project.persons) {
    const flags = { pending: isPendingPerson(person), unmerged: isUnmergedPerson(person), duplicate: isDuplicateSuspect(person) }
    if (flags.pending) {
      pending += 1
      bump(orgMap, person.orgUnit || '未填班级/车间', person, 'pending')
      bump(batchMap, person.batch || '未分批', person, 'pending')
    }
    if (flags.unmerged) {
      unmerged += 1
      bump(orgMap, person.orgUnit || '未填班级/车间', person, 'unmerged')
      bump(batchMap, person.batch || '未分批', person, 'unmerged')
    }
    if (flags.duplicate) {
      duplicate += 1
      bump(orgMap, person.orgUnit || '未填班级/车间', person, 'duplicate')
      bump(batchMap, person.batch || '未分批', person, 'duplicate')
    }
    if (flags.pending || flags.unmerged || flags.duplicate) anyIds.add(person.id)
  }

  return {
    pending,
    unmerged,
    duplicate,
    totalUnique: anyIds.size,
    byOrgUnit: [...orgMap.entries()]
      .map(([orgUnit, value]) => ({ orgUnit, pending: value.pending, unmerged: value.unmerged, duplicate: value.duplicate, total: value.total }))
      .sort((a, b) => a.orgUnit.localeCompare(b.orgUnit, 'zh-Hans-CN')),
    byBatch: [...batchMap.entries()]
      .map(([batch, value]) => ({ batch, pending: value.pending, unmerged: value.unmerged, duplicate: value.duplicate, total: value.total }))
      .sort((a, b) => a.batch.localeCompare(b.batch, 'zh-Hans-CN'))
  }
}

/* ------------------------------- 范围与动作 ------------------------------- */

/** 解析一次整批处置真正作用到的人（当前类别内，再按勾选 / 班级 / 批次过滤） */
export function resolveTargetIds(project: Project, category: ReviewCategory, scope: DispositionScope): string[] {
  const inCategory = listReviewRows(project, category)
  let targets: Person[]
  if (scope.type === 'selected') {
    const wanted = new Set(scope.targetIds)
    targets = inCategory.filter((person) => wanted.has(person.id))
  } else if (scope.type === 'org_unit') {
    targets = inCategory.filter((person) => (person.orgUnit || '未填班级/车间') === scope.value)
  } else {
    targets = inCategory.filter((person) => (person.batch || '未分批') === scope.value)
  }
  return targets.map((person) => person.id)
}

export function scopeTextOf(
  category: ReviewCategory,
  scope: DispositionScope,
  count: number
): string {
  const categoryText = REVIEW_CATEGORY_LABEL[category]
  if (scope.type === 'org_unit') return `${categoryText} · 班级/车间「${scope.value}」整批（${count} 条）`
  if (scope.type === 'batch') return `${categoryText} · 批次「${scope.value}」整批（${count} 条）`
  return `${categoryText} · 勾选的 ${count} 条`
}

export type DispositionRequest = {
  categories: ReviewCategory[]
  scope: DispositionScope
  action: DispositionAction
  /** flag_special 时为特殊体型码；assign_size 时为号型 */
  payload: string
  reason: string
  by: string
}

/** 提交前的表单级校验（不改动任何数据）；返回面向操作人的错误信息，没问题返回 null */
export function validateRequest(
  rule: SizeRule,
  request: DispositionRequest,
  targetCount: number
): string | null {
  if (request.categories.length === 0) return '请先选择至少一类异常行'
  if (targetCount <= 0) return '当前范围里没有可处置的异常行'
  if (request.by.trim() === '') return '请填写操作人（每一次整批处置都要留痕是谁做的）'
  if (request.reason.trim() === '') {
    if (request.action === 'assign_size') return '请写明整批填这个号型的原因'
    return '请写明处置原因（整批处置必须留痕）'
  }
  if (request.action === 'flag_special') {
    if (!request.payload || !rule.specialFlags.some((flag) => flag.code === request.payload)) {
      return '请选择一种特殊体型标记'
    }
  }
  if (request.action === 'assign_size') {
    const code = normalizeSizeCodeInput(request.payload)
    if (!isSizeCodeValid(rule, code)) {
      return '号型格式不正确，应形如 170/88A（型别为 Y/A/B/C）'
    }
  }
  return null
}

/* ------------------------------- 快照与指纹 ------------------------------- */

export function snapshotPerson(person: Person): PersonSnapshot {
  return {
    status: person.status,
    statusReason: person.statusReason,
    specialFlag: person.specialFlag,
    needsConfirm: person.needsConfirm,
    possibleDuplicateOf: person.possibleDuplicateOf,
    anomaly: [...person.anomaly],
    result: person.result ? cloneResult(person.result) : null
  }
}

function cloneResult(result: PersonResult): PersonResult {
  return {
    sizeCode: result.sizeCode,
    ruleSizeCode: result.ruleSizeCode,
    fit: result.fit,
    ruleVersion: result.ruleVersion,
    manualOverride: result.manualOverride ? { ...result.manualOverride } : undefined
  }
}

function applySnapshot(person: Person, snapshot: PersonSnapshot): void {
  person.status = snapshot.status
  person.statusReason = snapshot.statusReason
  person.specialFlag = snapshot.specialFlag
  person.needsConfirm = snapshot.needsConfirm
  person.possibleDuplicateOf = snapshot.possibleDuplicateOf
  person.anomaly = [...snapshot.anomaly]
  person.result = snapshot.result ? cloneResult(snapshot.result) : null
}

/**
 * 全体人员的指纹（双 32 位哈希 + 长度）。任何一条相关字段被改动都会变；
 * 回滚前发现指纹与处置时不一致，就说明期间有人动过名单，拒绝覆盖式回滚。
 */
export function projectFingerprint(project: Project): string {
  let h1 = 0x811c9dc5
  let h2 = 5381
  const parts: string[] = []
  for (const person of project.persons) {
    const piece = [
      person.id,
      person.name,
      person.gender,
      person.orgUnit,
      person.batch,
      person.heightCm,
      person.weightKg ?? '',
      person.chestCm,
      person.waistCm,
      person.note,
      person.sourceRow ?? '',
      person.status,
      person.statusReason,
      person.specialFlag ?? '',
      person.needsConfirm ? '1' : '0',
      person.possibleDuplicateOf ?? '',
      person.anomaly.join(','),
      person.result
        ? [
            person.result.sizeCode,
            person.result.ruleSizeCode,
            person.result.fit ?? '',
            person.result.ruleVersion,
            person.result.manualOverride
              ? [person.result.manualOverride.sizeCode, person.result.manualOverride.by, person.result.manualOverride.reason, person.result.manualOverride.at].join('~')
              : ''
          ].join('#')
        : ''
    ].join('|')
    parts.push(piece)
    for (let i = 0; i < piece.length; i += 1) {
      const code = piece.charCodeAt(i)
      h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
      h2 = (((h2 << 5) + h2 + code) | 0) >>> 0
    }
  }
  const joined = parts.join(';')
  return `${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}-${joined.length}`
}

/* ------------------------------- 汇总快照与分堆对比 ------------------------------- */

export type BucketRef = { sizeCode: string; gender: Person['gender']; isSpecial: boolean }
export type BucketMap = Map<string, number>

export function bucketKey(bucket: BucketRef): string {
  return `${bucket.isSpecial ? 'S' : 'R'}|${bucket.sizeCode}|${bucket.gender}`
}

export function summaryBucketMap(summary: Summary): BucketMap {
  const map: BucketMap = new Map()
  for (const row of summary.allRows) {
    map.set(bucketKey(row), row.qty)
  }
  return map
}

export function totalsSnapshotOf(project: Project, summary: Summary): TotalsSnapshot {
  return {
    totalRows: summary.totals.totalRows,
    invalidRows: summary.totals.invalidRows,
    duplicateRows: summary.totals.duplicateRows,
    validRows: summary.totals.validRows,
    regularQty: summary.totals.regularQty,
    specialQty: summary.totals.specialQty,
    accountedQty: summary.totals.accountedQty,
    overrideCount: summary.totals.overrideCount,
    unmergedCount: summary.unmerged.length,
    pendingReviewCount: project.persons.filter(isAnyReviewPerson).length
  }
}

export type BucketDelta = { bucket: BucketRef; before: number; after: number; delta: number }

/** 两版分堆的差异：哪些档人数增加、哪些减少（数量不变的档不列出） */
export function diffBuckets(before: BucketMap, after: BucketMap): BucketDelta[] {
  const keys = new Set([...before.keys(), ...after.keys()])
  const deltas: BucketDelta[] = []
  for (const key of keys) {
    const beforeQty = before.get(key) ?? 0
    const afterQty = after.get(key) ?? 0
    if (beforeQty === afterQty) continue
    const [kind, sizeCode, gender] = key.split('|')
    deltas.push({
      bucket: { sizeCode, gender: gender as Person['gender'], isSpecial: kind === 'S' },
      before: beforeQty,
      after: afterQty,
      delta: afterQty - beforeQty
    })
  }
  deltas.sort((a, b) => b.delta - a.delta || a.bucket.sizeCode.localeCompare(b.bucket.sizeCode))
  return deltas
}

/* ------------------------------- 预演与提交 ------------------------------- */

export type Preview = {
  request: DispositionRequest
  targetIds: string[]
  /** 预演时就锁定的处置时间，提交时写同一个时间戳，保证逐人快照可严格比对 */
  at: number
  beforeTotals: TotalsSnapshot
  afterTotals: TotalsSnapshot
  beforeBuckets: BucketMap
  afterBuckets: BucketMap
  deltas: BucketDelta[]
  /** 预演时（真实项目上的）指纹；提交时若名单已变，要求重新预演 */
  fingerprint: string
  /** 预演后每个目标人员的字段快照，提交后用于逐字段核对 */
  afterSnapshots: Record<string, PersonSnapshot>
}

function cloneProject(project: Project): Project {
  return JSON.parse(JSON.stringify(project)) as Project
}

function computeRuleSizeSafe(rule: SizeRule, person: Person) {
  try {
    return computeRuleSize(rule, person)
  } catch {
    return null
  }
}

/** 把一个动作施加到目标人员（不重新归并，由调用方统一 runMerge） */
function applyAction(project: Project, rule: SizeRule, targets: Person[], request: DispositionRequest, at: number): void {
  const reason = request.reason.trim()
  for (const person of targets) {
    if (request.action === 'flag_special') {
      // 特殊体型单列：不混入常规档，复核疑问随之关闭
      person.status = 'active'
      person.statusReason = ''
      person.specialFlag = request.payload
      person.needsConfirm = false
      person.possibleDuplicateOf = null
      person.result = null
    } else if (request.action === 'mark_invalid') {
      person.status = 'invalid'
      person.statusReason = reason
      person.specialFlag = null
      person.needsConfirm = false
      person.possibleDuplicateOf = null
      person.result = null
    } else if (request.action === 'mark_duplicate') {
      person.status = 'duplicate'
      person.statusReason = reason
      person.specialFlag = null
      person.needsConfirm = false
      person.result = null
    } else {
      // assign_size：整批填同一个号型，属于人工覆写，必须写明原因并留痕
      const code = normalizeSizeCodeInput(request.payload)
      person.status = 'active'
      person.statusReason = ''
      person.specialFlag = null
      person.needsConfirm = false
      person.possibleDuplicateOf = null
      // 规则号型当场重算（没落进任何档时为空），比沿用旧 result 更稳；runMerge 会保持覆写生效值
      const built = computeRuleSizeSafe(rule, person)
      person.result = {
        sizeCode: code,
        ruleSizeCode: built?.sizeCode ?? '',
        fit: built?.fit ?? null,
        ruleVersion: rule.version,
        manualOverride: { sizeCode: code, by: request.by.trim(), reason, at }
      }
    }
  }
  void project
}

function makeDispositionId(): string {
  return `disp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 预演：在项目克隆上完整执行一遍处置（含重新归并），算出后果但不动真数据。
 * 告诉操作人：有效人数会变成多少、哪些档增加 / 减少、还剩几条没处理。
 */
export function previewDisposition(project: Project, rule: SizeRule, request: DispositionRequest): Preview {
  const category = request.categories[0]
  const targetIds = resolveTargetIds(project, category, request.scope)
  const error = validateRequest(rule, request, targetIds.length)
  if (error) throw new Error(error)

  const beforeSummary = buildSummary(project, rule)
  const beforeTotals = totalsSnapshotOf(project, beforeSummary)
  const beforeBuckets = summaryBucketMap(beforeSummary)

  const clone = cloneProject(project)
  const cloneRule = JSON.parse(JSON.stringify(rule)) as SizeRule
  const cloneTargets = targetIds
    .map((id) => clone.persons.find((person) => person.id === id))
    .filter((person): person is Person => Boolean(person))
  const at = Date.now()
  applyAction(clone, cloneRule, cloneTargets, request, at)
  runMerge(clone, cloneRule)

  const afterSummary = buildSummary(clone, cloneRule)
  const afterTotals = totalsSnapshotOf(clone, afterSummary)
  const afterBuckets = summaryBucketMap(afterSummary)

  const afterSnapshots: Record<string, PersonSnapshot> = {}
  for (const person of cloneTargets) afterSnapshots[person.id] = snapshotPerson(person)

  return {
    request,
    targetIds,
    at,
    beforeTotals,
    afterTotals,
    beforeBuckets,
    afterBuckets,
    deltas: diffBuckets(beforeBuckets, afterBuckets),
    fingerprint: projectFingerprint(project),
    afterSnapshots
  }
}

export class DispositionMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DispositionMismatchError'
  }
}

/**
 * 真处置：在真项目上把预演再算一遍，人数 / 分堆 / 逐人结果必须与预演一致，
 * 任何一处对不上都不留痕、不落盘、整批还原，不许提交。
 */
export function commitDisposition(project: Project, rule: SizeRule, preview: Preview): BatchDisposition {
  const { request } = preview
  if (preview.fingerprint !== projectFingerprint(project)) {
    throw new DispositionMismatchError('名单在预演之后发生过变化，请重新预演后再提交')
  }

  const targetMap = new Map<string, Person>()
  for (const id of preview.targetIds) {
    const person = project.persons.find((item) => item.id === id)
    if (!person) throw new DispositionMismatchError('预演选中的行已不存在，请重新预演后再提交')
    targetMap.set(id, person)
  }
  if (targetMap.size !== preview.targetIds.length) {
    throw new DispositionMismatchError('预演选中的行与当前名单不一致，请重新预演后再提交')
  }

  const beforeSnapshots: Record<string, PersonSnapshot> = {}
  for (const person of targetMap.values()) beforeSnapshots[person.id] = snapshotPerson(person)

  const beforeTotals = totalsSnapshotOf(project, buildSummary(project, rule))
  if (!totalsEqual(beforeTotals, preview.beforeTotals)) {
    throw new DispositionMismatchError('处置前的人数与预演时不一致，请重新预演后再提交')
  }

  const now = preview.at
  applyAction(project, rule, [...targetMap.values()], request, now)
  runMerge(project, rule)

  // 逐字段核对：预演里每个人处置后应有的样子
  for (const [id, expected] of Object.entries(preview.afterSnapshots)) {
    const actual = snapshotPerson(targetMap.get(id)!)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      // 还原后抛出，保证真数据不被半次处置污染
      for (const [personId, snapshot] of Object.entries(beforeSnapshots)) {
        const person = targetMap.get(personId)
        if (person) applySnapshot(person, snapshot)
      }
      runMerge(project, rule)
      throw new DispositionMismatchError(`预演与真处置在「${targetMap.get(id)?.name ?? id}」一行上对不上，已整批还原，不许提交`)
    }
  }

  const afterSummary = buildSummary(project, rule)
  const afterTotals = totalsSnapshotOf(project, afterSummary)
  if (!totalsEqual(afterTotals, preview.afterTotals)) {
    for (const [personId, snapshot] of Object.entries(beforeSnapshots)) {
      const person = targetMap.get(personId)
      if (person) applySnapshot(person, snapshot)
    }
    runMerge(project, rule)
    throw new DispositionMismatchError('预演算出来的人数与真处置之后不一致，已整批还原，不许提交')
  }
  const afterBuckets = summaryBucketMap(afterSummary)
  if (!bucketsEqual(afterBuckets, preview.afterBuckets)) {
    for (const [personId, snapshot] of Object.entries(beforeSnapshots)) {
      const person = targetMap.get(personId)
      if (person) applySnapshot(person, snapshot)
    }
    runMerge(project, rule)
    throw new DispositionMismatchError('预演算出来的分堆与真处置之后不一致，已整批还原，不许提交')
  }

  const category = request.categories[0]
  const scope: DispositionScope = {
    type: request.scope.type,
    value: request.scope.value,
    targetIds: [...preview.targetIds]
  }
  const record: BatchDisposition = {
    id: makeDispositionId(),
    categories: [...request.categories],
    scope,
    scopeText: scopeTextOf(category, scope, preview.targetIds.length),
    action: request.action,
    payload: request.action === 'flag_special' || request.action === 'assign_size' ? normalizePayload(request) : '',
    reason: request.reason.trim(),
    by: request.by.trim(),
    at: now,
    count: preview.targetIds.length,
    targetIds: [...preview.targetIds],
    before: beforeSnapshots,
    after: preview.afterSnapshots,
    beforeTotals: preview.beforeTotals,
    afterTotals,
    fingerprintBefore: preview.fingerprint,
    fingerprintAfter: projectFingerprint(project),
    rolledBack: false,
    rolledBackAt: null,
    rolledBackBy: null
  }
  project.dispositions = [...(project.dispositions ?? []), record]
  return record
}

function normalizePayload(request: DispositionRequest): string {
  return request.action === 'assign_size' ? normalizeSizeCodeInput(request.payload) : request.payload
}

function totalsEqual(a: TotalsSnapshot, b: TotalsSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function bucketsEqual(a: BucketMap, b: BucketMap): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) if (b.get(key) !== value) return false
  return true
}

/* -------------------------------- 回滚 -------------------------------- */

/** 可回滚：必须是最近一次未回滚的整批处置（线性撤销，语义与人数恢复都可预测） */
export function rollbackableDisposition(project: Project): BatchDisposition | null {
  const list = project.dispositions ?? []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!list[i].rolledBack) return list[i]
  }
  return null
}

export class RollbackBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RollbackBlockedError'
  }
}

/**
 * 整批回滚：把本批每个人的处置相关字段按处置前快照逐字段恢复，再重新归并。
 * 期间名单（含本批人员）被任何操作改过（指纹不一致）则拒绝回滚，避免误伤新数据；
 * 恢复后还要断言人数与归并分堆确实回到处置之前，对不上同样拒绝。
 */
export function rollbackDisposition(project: Project, rule: SizeRule, record: BatchDisposition, by: string): void {
  const latest = rollbackableDisposition(project)
  if (!latest || latest.id !== record.id) {
    throw new RollbackBlockedError('只能整体回滚最近一次未回滚的整批处置')
  }
  if (projectFingerprint(project) !== record.fingerprintAfter) {
    throw new RollbackBlockedError(
      '处置之后名单又被改过（单条复核、重新导入或再次整批处置等），直接回滚会覆盖这些改动；请先核对名单'
    )
  }

  const targets: Person[] = []
  for (const id of record.targetIds) {
    const person = project.persons.find((item) => item.id === id)
    if (!person) {
      throw new RollbackBlockedError('本批处置的行已不在名单中，无法整批回滚')
    }
    targets.push(person)
  }

  for (const person of targets) {
    const snapshot = record.before[person.id]
    if (!snapshot) throw new RollbackBlockedError(`缺少「${person.name}」处置前的快照，无法回滚`)
    applySnapshot(person, snapshot)
  }
  runMerge(project, rule)

  const restored = buildSummary(project, rule)
  const restoredTotals = totalsSnapshotOf(project, restored)
  if (!totalsEqual(restoredTotals, record.beforeTotals)) {
    // 恢复未达到处置前状态：按处置后快照重新应用，保证现场不被破坏
    for (const person of targets) {
      const snapshot = record.after[person.id]
      if (snapshot) applySnapshot(person, snapshot)
    }
    runMerge(project, rule)
    throw new RollbackBlockedError('回滚后人数与处置前对不上，已恢复为回滚前状态，请人工核对')
  }

  record.rolledBack = true
  record.rolledBackAt = Date.now()
  record.rolledBackBy = by.trim() || '现场录入员'
}

/* -------------------------------- 展示辅助 -------------------------------- */

export function dispositionActionText(rule: SizeRule, record: BatchDisposition): string {
  switch (record.action) {
    case 'flag_special':
      return `整批标记为${specialFlagLabel(rule, record.payload)}`
    case 'mark_invalid':
      return '整批判为无效行'
    case 'mark_duplicate':
      return '整批确认重复并排除'
    case 'assign_size':
      return `整批填号型 ${record.payload}`
  }
}

/** 整批处置留痕导出列（审计：哪一批 / 谁做的 / 处置多少条 / 是否已回滚） */
export const DISPOSITION_HEADER = [
  '时间',
  '处置批次/范围',
  '异常类别',
  '处置动作',
  '处置条数',
  '操作人',
  '原因',
  '有效人数(前→后)',
  '未处理异常(前→后)',
  '状态',
  '回滚时间',
  '回滚人'
]

export function dispositionRows(project: Project, rule: SizeRule): (string | number)[][] {
  const rows: (string | number)[][] = [DISPOSITION_HEADER]
  for (const record of [...(project.dispositions ?? [])].sort((a, b) => b.at - a.at)) {
    rows.push([
      new Date(record.at).toLocaleString('zh-CN'),
      record.scopeText,
      record.categories.map((category) => REVIEW_CATEGORY_LABEL[category]).join('、'),
      dispositionActionText(rule, record),
      record.count,
      record.by,
      record.reason,
      `${record.beforeTotals.validRows} → ${record.afterTotals.validRows}`,
      `${record.beforeTotals.pendingReviewCount} → ${record.afterTotals.pendingReviewCount}`,
      record.rolledBack ? '已回滚' : '生效中',
      record.rolledBackAt ? new Date(record.rolledBackAt).toLocaleString('zh-CN') : '',
      record.rolledBackBy ?? ''
    ])
  }
  return rows
}
