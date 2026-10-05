/**
 * 导出：下单汇总表 / 量体明细 / 特殊体型清单 / 备货建议 / 批量复核留痕。
 * 页面预览、CSV、XLSX 与打印预览共用同一份数据，保证逐行一致。
 */
import type { Gender, Person, Project, SizeRule, SummaryRow } from './types'
import { specialFlagLabel } from './sizeRules'
import { conservationText, type Summary } from './merge'
import { disposalActionLabel } from './review'
import { chestWaistDiffCm, formatCm } from './precision'
import type { Sheet } from './xlsx'

export type BaseContext = {
  project: Project
  rule: SizeRule
}

export type ExportContext = BaseContext & {
  summary: Summary
  operator: string
  generatedAt: Date
}

export function genderLabel(gender: Gender): string {
  return gender === 'male' ? '男' : '女'
}

export function personStatusLabel(person: Person): string {
  if (person.status === 'invalid') return '无效行'
  if (person.status === 'duplicate') return '重复行（已排除）'
  return '有效'
}

export function summaryRowLabel(rule: SizeRule, row: SummaryRow): string {
  return row.isSpecial ? `${specialFlagLabel(rule, row.sizeCode)}（${row.sizeCode}）` : row.sizeCode
}

function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes()
  )}`
}

export function exportBaseName(ctx: ExportContext, suffix: string, ext: string): string {
  const safeName = ctx.project.name.replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 40)
  return `${safeName}-${suffix}-${stamp(ctx.generatedAt)}.${ext}`
}

/* ------------------------------- 下单汇总表 ------------------------------- */

export type OrderSheetItem = {
  index: number
  sizeLabel: string
  gender: string
  kind: '常规档' | '特殊单列'
  qty: number
}

export type OrderSheet = {
  meta: { label: string; value: string }[]
  items: OrderSheetItem[]
  totalQty: number
  totalPeople: number
  byOrgUnit: { orgUnit: string; rows: OrderSheetItem[]; total: number }[]
}

export function buildOrderSheet(ctx: ExportContext): OrderSheet {
  const { rule, summary, project } = ctx
  const items: OrderSheetItem[] = summary.allRows.map((row, index) => ({
    index: index + 1,
    sizeLabel: summaryRowLabel(rule, row),
    gender: genderLabel(row.gender),
    kind: row.isSpecial ? '特殊单列' : '常规档',
    qty: row.qty
  }))
  const byOrgUnit = summary.byOrgUnit.map((group) => ({
    orgUnit: group.orgUnit,
    rows: group.rows.map((row, index) => ({
      index: index + 1,
      sizeLabel: summaryRowLabel(rule, row),
      gender: genderLabel(row.gender),
      kind: row.isSpecial ? ('特殊单列' as const) : ('常规档' as const),
      qty: row.qty
    })),
    total: group.regularQty + group.specialQty
  }))
  return {
    meta: [
      { label: '项目名称', value: project.name },
      { label: '号型规则版本', value: `${rule.version}（${rule.label}）` },
      { label: '生成时间', value: ctx.generatedAt.toLocaleString('zh-CN') },
      { label: '录入/导出人', value: ctx.operator || '—' },
      { label: '守恒校验', value: `${conservationText(summary)} → ${summary.conserved ? '通过' : '不通过'}` },
      { label: '总录入 / 无效 / 重复 / 有效', value: `${summary.totals.totalRows} / ${summary.totals.invalidRows} / ${summary.totals.duplicateRows} / ${summary.totals.validRows}` }
    ],
    items,
    totalQty: summary.totals.accountedQty,
    totalPeople: summary.totals.validRows,
    byOrgUnit
  }
}

export function orderSheetToRows(order: OrderSheet): (string | number)[][] {
  const rows: (string | number)[][] = []
  for (const meta of order.meta) rows.push([meta.label, meta.value])
  rows.push([])
  rows.push(['序号', '号型', '性别', '类型', '数量'])
  for (const item of order.items) rows.push([item.index, item.sizeLabel, item.gender, item.kind, item.qty])
  rows.push(['', '合计', '', '', order.totalQty])
  rows.push(['', '有效人数', '', '', order.totalPeople])
  return rows
}

export function orgUnitSheetToRows(order: OrderSheet): (string | number)[][] {
  const rows: (string | number)[][] = [['班级/车间', '序号', '号型', '性别', '类型', '数量']]
  for (const group of order.byOrgUnit) {
    for (const item of group.rows) {
      rows.push([group.orgUnit, item.index, item.sizeLabel, item.gender, item.kind, item.qty])
    }
    rows.push([`${group.orgUnit} 小计`, '', '', '', '', group.total])
  }
  return rows
}

/* ------------------------------- 量体明细 ------------------------------- */

export const DETAIL_HEADER = [
  '导入行号',
  '姓名',
  '性别',
  '班级/车间',
  '批次',
  '身高(cm)',
  '体重(kg)',
  '胸围(cm)',
  '腰围(cm)',
  '胸腰差(cm)',
  '规则号型',
  '生效号型',
  '是否覆写',
  '覆写人',
  '覆写原因',
  '特殊体型',
  '状态',
  '备注'
]

export function detailRows(ctx: BaseContext): (string | number)[][] {
  const { rule, project } = ctx
  const rows: (string | number)[][] = [DETAIL_HEADER]
  for (const person of project.persons) {
    const hasMeasure = person.chestCm > 0 && person.waistCm > 0
    rows.push([
      person.sourceRow ?? '',
      person.name,
      genderLabel(person.gender),
      person.orgUnit,
      person.batch,
      person.heightCm > 0 ? formatCm(person.heightCm) : '',
      person.weightKg ? formatCm(person.weightKg) : '',
      person.chestCm > 0 ? formatCm(person.chestCm) : '',
      person.waistCm > 0 ? formatCm(person.waistCm) : '',
      hasMeasure ? formatCm(chestWaistDiffCm(person.chestCm, person.waistCm)) : '',
      person.result?.ruleSizeCode ?? '',
      person.result?.sizeCode ?? '',
      person.result?.manualOverride ? '是' : '否',
      person.result?.manualOverride?.by ?? '',
      person.result?.manualOverride?.reason ?? '',
      person.specialFlag ? specialFlagLabel(rule, person.specialFlag) : '',
      personStatusLabel(person),
      [person.note, person.statusReason].filter((part) => part).join('；')
    ])
  }
  return rows
}

/* ------------------------------- 特殊体型清单 ------------------------------- */

export const SPECIAL_HEADER = [
  '导入行号',
  '姓名',
  '性别',
  '班级/车间',
  '批次',
  '身高(cm)',
  '胸围(cm)',
  '腰围(cm)',
  '胸腰差(cm)',
  '特殊标记',
  '规则号型',
  '状态',
  '备注'
]

export function specialRows(ctx: BaseContext): (string | number)[][] {
  const { rule, project } = ctx
  const rows: (string | number)[][] = [SPECIAL_HEADER]
  for (const person of project.persons) {
    if (!person.specialFlag) continue
    rows.push([
      person.sourceRow ?? '',
      person.name,
      genderLabel(person.gender),
      person.orgUnit,
      person.batch,
      formatCm(person.heightCm),
      formatCm(person.chestCm),
      formatCm(person.waistCm),
      person.chestCm > 0 && person.waistCm > 0 ? formatCm(chestWaistDiffCm(person.chestCm, person.waistCm)) : '',
      specialFlagLabel(rule, person.specialFlag),
      person.result?.sizeCode ?? '规则未覆盖',
      personStatusLabel(person),
      [person.note, person.statusReason].filter((part) => part).join('；')
    ])
  }
  return rows
}

/* ------------------------------- 备货建议（仅数据） ------------------------------- */

export const STOCK_HEADER = ['排名', '号型', '性别', '实际数量', '占比', '建议备货比例', '建议备货数量', '类型']

export function stockAdviceRows(ctx: ExportContext): (string | number)[][] {
  const { rule, summary } = ctx
  const rows: (string | number)[][] = [STOCK_HEADER]
  summary.distribution.forEach((row, index) => {
    rows.push([
      index + 1,
      summaryRowLabel(rule, { sizeCode: row.sizeCode, gender: row.gender, qty: row.qty, isSpecial: row.isSpecial }),
      genderLabel(row.gender),
      row.qty,
      `${(row.ratio * 100).toFixed(1)}%`,
      `${Math.round((1 + row.marginRatio) * 100)}%`,
      row.suggestion,
      row.isSpecial ? '特殊单列' : '常规档'
    ])
  })
  rows.push([])
  rows.push(['说明', '建议备货 = 实际数量 × 建议备货比例（常规档 +5%，特殊单列 +10%），向上取整且不少于 1 套。'])
  return rows
}

/* ------------------------------- 导出包装 ------------------------------- */

export function orderWorkbookSheets(ctx: ExportContext): Sheet[] {
  const order = buildOrderSheet(ctx)
  return [
    { name: '下单汇总表', rows: orderSheetToRows(order) },
    { name: '按班级车间小计', rows: orgUnitSheetToRows(order) }
  ]
}

export function detailWorkbookSheets(ctx: BaseContext): Sheet[] {
  return [
    { name: '量体明细', rows: detailRows(ctx) },
    { name: '特殊体型清单', rows: specialRows(ctx) }
  ]
}

/* ------------------------------- 批量复核留痕 ------------------------------- */

export const BULK_DISPOSAL_HEADER = [
  '处置时间',
  '状态',
  '回滚时间',
  '回滚人',
  '处置批次（范围）',
  '班级/车间',
  '批次',
  '处置方式',
  '动作参数',
  '处置条数',
  '处置原因',
  '操作人',
  '处置后总录入',
  '处置后无效行',
  '处置后重复行',
  '处置后有效人数',
  '处置后常规档',
  '处置后特殊单列',
  '处置后未归并行',
  '处置后剩余待复核',
  '影响人员行号'
]

type BulkDisposalContext = BaseContext & {
  operator: string
  generatedAt: Date
}

function timeText(value: number | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : ''
}

/**
 * 整批异常复核处置留痕（页面与导出共用同一份数据）。
 * 每一批记录：是哪一批（范围）、谁做的、处置了多少条、处置后的人数结果、是否已回滚。
 */
export function bulkDisposalRows(ctx: BulkDisposalContext): (string | number)[][] {
  const { rule, project } = ctx
  const rows: (string | number)[][] = [BULK_DISPOSAL_HEADER]
  // 同毫秒内的多批处置按项目内追加顺序（即 id 生成顺序）稳定倒序展示
  const order = new Map((project.bulkDisposals ?? []).map((item, index) => [item.id, index]))
  const disposals = [...(project.bulkDisposals ?? [])].sort(
    (a, b) => b.at - a.at || (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0)
  )
  for (const disposal of disposals) {
    const byKey = new Map(project.persons.map((person) => [person.id, person]))
    const rowNumbers = disposal.affectedIds
      .map((id) => byKey.get(id)?.sourceRow)
      .filter((value): value is number => typeof value === 'number')
    rows.push([
      timeText(disposal.at),
      disposal.rolledBack ? '已回滚' : '生效中',
      timeText(disposal.rolledBackAt),
      disposal.rollbackBy ?? '',
      disposal.scopeSummary,
      disposal.orgUnit,
      disposal.batch,
      disposalActionLabel(disposal, rule),
      disposal.actionValue,
      disposal.affectedCount,
      disposal.reason,
      disposal.by,
      disposal.forecastTotals.totalRows ?? '',
      disposal.forecastTotals.invalidRows ?? '',
      disposal.forecastTotals.duplicateRows ?? '',
      disposal.forecastTotals.validRows ?? '',
      disposal.forecastTotals.regularQty ?? '',
      disposal.forecastTotals.specialQty ?? '',
      disposal.forecastUnmerged ?? '',
      disposal.forecastRemaining,
      rowNumbers.join('、')
    ])
  }
  return rows
}

export function bulkDisposalWorkbookSheets(ctx: BulkDisposalContext): Sheet[] {
  return [{ name: '批量复核留痕', rows: bulkDisposalRows(ctx) }]
}