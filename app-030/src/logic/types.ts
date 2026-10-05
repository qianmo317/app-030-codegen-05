/** 领域模型：量体数据、号型规则、归并结果与汇总 */

export type Gender = 'male' | 'female'
export type PatternFit = 'Y' | 'A' | 'B' | 'C'
/** 边界规则：round_up = 边界归上（167.5 → 170）；nearest = 就近归下（167.5 → 165） */
export type BoundaryRule = 'round_up' | 'nearest'
export type ProjectKind = 'school' | 'factory' | 'other'

export type FitRange = { fit: PatternFit; minCm: number; maxCm: number }
export type GenderFitRule = { gender: Gender; ranges: FitRange[] }
export type SpecialFlag = { code: string; label: string }

/** 身高体重 → 建议初始号型的估算参数（仅作录入参考） */
export type SizeEstimateConfig = {
  standardWeightBaseCm: number
  maleWeightFactor: number
  femaleWeightFactor: number
  maleChestRatio: number
  femaleChestRatio: number
  maleBmiRef: number
  femaleBmiRef: number
  bmiChestFactor: number
  maleDefaultDiffCm: number
  femaleDefaultDiffCm: number
}

/** 号型规则（版本化，项目锁定版本后不随规则改版而变） */
export type SizeRule = {
  version: string
  label: string
  builtin: boolean
  heightStepCm: number
  heightAnchor: number
  chestStepCm: number
  chestAnchor: number
  boundaryRule: BoundaryRule
  fitByChestWaistDiff: GenderFitRule[]
  specialFlags: SpecialFlag[]
  heightRangeCm: { minCm: number; maxCm: number }
  chestRangeCm: { minCm: number; maxCm: number }
  estimate: SizeEstimateConfig
  effectiveFrom: string
  note: string
}

/** 数值异常标记 */
export type AnomalyCode =
  | 'height_out_of_range'
  | 'chest_out_of_range'
  | 'missing_chest'
  | 'missing_height'
  | 'missing_waist'
  | 'diff_out_of_range'

/** active = 计入有效人数；invalid = 无效行；duplicate = 被确认为重复并排除 */
export type PersonStatus = 'active' | 'invalid' | 'duplicate'

export type ManualOverride = { sizeCode: string; by: string; reason: string; at: number }

export type PersonResult = {
  /** 生效号型（人工覆写后为覆写值） */
  sizeCode: string
  /** 按规则归并出的号型，便于对比「按规则归并 / 人工覆写」 */
  ruleSizeCode: string
  fit: PatternFit | null
  ruleVersion: string
  manualOverride?: ManualOverride
}

export type Person = {
  id: string
  name: string
  gender: Gender
  /** 班级 / 车间 */
  orgUnit: string
  batch: string
  heightCm: number
  weightKg: number | null
  chestCm: number
  waistCm: number
  specialFlag: string | null
  note: string
  status: PersonStatus
  /** 无效 / 排除的原因说明 */
  statusReason: string
  anomaly: AnomalyCode[]
  needsConfirm: boolean
  possibleDuplicateOf: string | null
  /** 导入来源行号（用于差异定位） */
  sourceRow: number | null
  source: 'manual' | 'import'
  result: PersonResult | null
  createdAt: number
}

export type ImportRecord = {
  fingerprint: string
  fileName: string
  at: number
  rows: number
  added: number
  updated: number
  invalid: number
  skipped: number
}

/* ------------------------ 异常行批量复核（工作台上整批处置） ------------------------ */

/** 三类异常行：待确认 / 未能归并 / 疑似重复 */
export type ReviewCategory = 'pending' | 'unmerged' | 'duplicate'

/** 整批处置动作：同一种特殊体型标记 / 判为无效 / 填同一个号型（含确认重复并排除） */
export type DispositionAction = 'flag_special' | 'mark_invalid' | 'mark_duplicate' | 'assign_size'

/** 整批选中范围：勾选的人，或按班级 / 批次整批 */
export type DispositionScopeType = 'selected' | 'org_unit' | 'batch'

export type DispositionScope = {
  type: DispositionScopeType
  /** type = org_unit 时为班级/车间名；batch 时为批次名；selected 时留空 */
  value: string
  /** 提交时锁定的目标人员 id（范围与勾选的快照），用于检测名单变化 */
  targetIds: string[]
}

/** 与「分堆」相关的人员字段快照：回滚逐字段恢复，归并结果随之回到处置前 */
export type PersonSnapshot = {
  status: PersonStatus
  statusReason: string
  specialFlag: string | null
  needsConfirm: boolean
  possibleDuplicateOf: string | null
  anomaly: AnomalyCode[]
  result: PersonResult | null
}

/** 归并汇总人数快照：预演与真处置按同一口径比对，对不上不许提交 */
export type TotalsSnapshot = {
  totalRows: number
  invalidRows: number
  duplicateRows: number
  validRows: number
  regularQty: number
  specialQty: number
  accountedQty: number
  overrideCount: number
  unmergedCount: number
  /** 工作台三类异常的并集（去重）剩余条数 */
  pendingReviewCount: number
}

/** 一次整批处置的留痕：哪一批、谁做的、处置了多少条；回滚后保留记录 */
export type BatchDisposition = {
  id: string
  categories: ReviewCategory[]
  scope: DispositionScope
  /** 批次/范围的文字描述，便于审计时直接看出「哪一批」 */
  scopeText: string
  action: DispositionAction
  /** flag_special 的标记码 / assign_size 的号型 */
  payload: string
  reason: string
  by: string
  at: number
  count: number
  targetIds: string[]
  /** 处置前每个受影响人员的字段快照（结构化克隆，可落 IndexedDB） */
  before: Record<string, PersonSnapshot>
  /** 处置后快照，供回滚前校验期间是否发生过其它改动 */
  after: Record<string, PersonSnapshot>
  beforeTotals: TotalsSnapshot
  afterTotals: TotalsSnapshot
  /** 处置前全体人员的指纹；回滚时必须一致，否则说明期间被改过，拒绝回滚 */
  fingerprintBefore: string
  fingerprintAfter: string
  rolledBack: boolean
  rolledBackAt: number | null
  rolledBackBy: string | null
}

export type Project = {
  id: string
  name: string
  kind: ProjectKind
  /** 项目锁定的规则版本：规则改版后旧项目仍按旧版本解释 */
  ruleVersion: string
  batches: string[]
  persons: Person[]
  imports: ImportRecord[]
  /** 异常行整批处置留痕（旧项目无此字段，读取时按空数组处理） */
  dispositions?: BatchDisposition[]
  perf?: { mergeMs?: number; mergeCount?: number; importParseMs?: number; importRows?: number }
  createdAt: number
  updatedAt: number
}

export type SummaryRow = { sizeCode: string; gender: Gender; qty: number; isSpecial: boolean }