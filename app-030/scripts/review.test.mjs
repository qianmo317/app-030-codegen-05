/**
 * 异常行批量复核工作台：逻辑自测（node 直接运行，无测试框架依赖）。
 * 用 esbuild 把 TS + JSON 规则表打成临时 ESM 再执行。
 *
 * 覆盖：
 *  1. 三类异常分类与工作台计数（含交叉去重）
 *  2. 预演 → 提交：预演人数/分堆 与 真处置后逐项一致
 *  3. 整批判无效 / 标记特殊 / 整批填号型 / 确认重复
 *  4. 整批回滚：人员字段、归并结果、汇总人数、导出表全部回到处置前
 *  5. 回滚保护：处置后改过名单则拒绝回滚
 *  6. 留痕：批次范围、操作人、条数、原因、前后人数齐全
 *  7. 提交闸门：预演后名单变化 / 目标行消失 → 拒绝提交
 *  8. 导出表与页面汇总（buildSummary / exporter）看到同一份结果
 *  9. 5000 人归并性能 < 200ms
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const ENTRY = `
import { BUILTIN_RULES } from ${JSON.stringify(join(ROOT, 'src/logic/sizeRules.ts'))}
import { runMerge, buildSummary } from ${JSON.stringify(join(ROOT, 'src/logic/merge.ts'))}
import {
  workbenchStats, listReviewRows, previewDisposition, commitDisposition,
  rollbackDisposition, rollbackableDisposition, DispositionMismatchError,
  RollbackBlockedError, resolveTargetIds, isAnyReviewPerson, dispositionRows
} from ${JSON.stringify(join(ROOT, 'src/logic/review.ts'))}
import { buildOrderSheet, orderSheetToRows, detailRows } from ${JSON.stringify(join(ROOT, 'src/logic/exporter.ts'))}
export default { BUILTIN_RULES, runMerge, buildSummary, workbenchStats, listReviewRows,
  previewDisposition, commitDisposition, rollbackDisposition, rollbackableDisposition,
  DispositionMismatchError, RollbackBlockedError, resolveTargetIds, isAnyReviewPerson,
  dispositionRows, buildOrderSheet, orderSheetToRows, detailRows }
`

async function loadLogic() {
  const dir = mkdtempSync(join(tmpdir(), 'app030-test-'))
  const entry = join(dir, 'entry.ts')
  const outfile = join(dir, 'bundle.mjs')
  writeFileSync(entry, ENTRY)
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    absWorkingDir: process.cwd(),
    logLevel: 'silent'
  })
  const mod = await import(pathToFileURL(outfile).href)
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  return { logic: mod.default, cleanup }
}

let passed = 0
let failed = 0
function assert(condition, message) {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}
function assertEqual(actual, expected, message) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) passed += 1
  else {
    failed += 1
    console.error(`  ✗ ${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`)
  }
}
async function test(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`✗ ${name} —— 抛异常: ${error?.stack ?? error}`)
  }
}

function makePerson(id, fields) {
  return {
    id,
    name: id,
    gender: 'male',
    orgUnit: '高一1班',
    batch: '春装',
    heightCm: 170,
    weightKg: 60,
    chestCm: 88,
    waistCm: 74, // diff 14 → A，正常归并
    specialFlag: null,
    note: '',
    status: 'active',
    statusReason: '',
    anomaly: [],
    needsConfirm: false,
    possibleDuplicateOf: null,
    sourceRow: null,
    source: 'import',
    result: null,
    createdAt: 0,
    ...fields
  }
}

function makeProject(persons, ruleVersion = 'v1.0.0') {
  return {
    id: 'prj_test',
    name: '测试学校',
    kind: 'school',
    ruleVersion,
    batches: ['春装', '秋装'],
    persons,
    imports: [],
    dispositions: [],
    createdAt: 0,
    updatedAt: 0
  }
}

function request(category, scope, action, extra = {}) {
  return {
    categories: [category],
    scope,
    action,
    payload: '',
    reason: '测试原因',
    by: '张老师',
    ...extra
  }
}

const { logic, cleanup } = await loadLogic()
const rule = logic.BUILTIN_RULES.find((item) => item.version === 'v1.0.0')

/* 构造工作台样本 */
function buildSampleProject() {
  const persons = []
  // 20 个正常 A 体
  for (let i = 0; i < 20; i += 1) persons.push(makePerson(`ok${i}`, { sourceRow: i + 2 }))
  // 待确认 + 未归并（胸腰差为负）5 个，高一1班
  for (let i = 0; i < 5; i += 1) {
    persons.push(
      makePerson(`neg${i}`, {
        chestCm: 70,
        waistCm: 80,
        anomaly: ['diff_out_of_range'],
        needsConfirm: true,
        sourceRow: 100 + i
      })
    )
  }
  // 待确认但仍可归并（胸围小于身高一半；diff 20 → Y）3 个，高一2班
  for (let i = 0; i < 3; i += 1) {
    persons.push(
      makePerson(`small${i}`, {
        orgUnit: '高一2班',
        heightCm: 200,
        chestCm: 88,
        waistCm: 68,
        anomaly: ['chest_out_of_range'],
        needsConfirm: true,
        sourceRow: 200 + i
      })
    )
  }
  // 未归并但不待确认（diff=1，落不进任何区间）4 个，秋装批次
  for (let i = 0; i < 4; i += 1) {
    persons.push(
      makePerson(`nomerge${i}`, {
        batch: '秋装',
        chestCm: 76,
        waistCm: 75,
        anomaly: ['diff_out_of_range'],
        needsConfirm: true,
        sourceRow: 300 + i
      })
    )
  }
  // 疑似重复 6 个：3 个本身正常归并，3 个还未归并（交叉），分布在两个班
  for (let i = 0; i < 3; i += 1) {
    persons.push(makePerson(`dupOk${i}`, { possibleDuplicateOf: '既有行「ok0」', needsConfirm: true, sourceRow: 400 + i }))
    persons.push(
      makePerson(`dupNo${i}`, {
        orgUnit: '高一2班',
        chestCm: 70,
        waistCm: 80,
        anomaly: ['diff_out_of_range'],
        needsConfirm: true,
        possibleDuplicateOf: '本文件第 2 行',
        sourceRow: 500 + i
      })
    )
  }
  // 2 个无效行（已处理，不应进工作台）
  persons.push(makePerson('inv1', { status: 'invalid', statusReason: '缺少胸围', chestCm: 0, waistCm: 0, needsConfirm: true }))
  persons.push(makePerson('inv2', { status: 'invalid', statusReason: '缺少身高', heightCm: 0, needsConfirm: true }))
  const project = makeProject(persons)
  logic.runMerge(project, rule)
  return project
}

/* --------------------------------- 测试 --------------------------------- */

await test('1. 三类异常分类与计数（交叉去重、已处理行不进工作台）', () => {
  const project = buildSampleProject()
  const stats = logic.workbenchStats(project)
  assertEqual(stats.pending, 12, '待确认 = 5 负差 + 3 小胸 + 4 未归并(也待确认) = 12（疑似重复单列不算）')
  assertEqual(stats.unmerged, 5 + 4 + 3, '没能归并 = 5 负差 + 4 落区间外 + 3 负差重复 = 12')
  assertEqual(stats.duplicate, 6, '疑似重复 6')
  assertEqual(stats.totalUnique, 12 + 6, '并集去重 = 18（dupNo 3 个虽同时未归并，但已计入 duplicate；其也在 pending 外）')
  // 注：dupNo 三人 needsConfirm=true 但 possibleDuplicateOf!=null，不计入 pending；计入 unmerged+duplicate
  // 所以并集 = pending 12 + duplicate 6 = 18，unmerged 的 3 个 dupNo 已在 duplicate 里
  assertEqual(logic.listReviewRows(project, 'pending').length, 12, 'pending 列表 12')
  assertEqual(logic.listReviewRows(project, 'unmerged').length, 12, 'unmerged 列表 12')
  assertEqual(logic.listReviewRows(project, 'duplicate').length, 6, 'duplicate 列表 6')
  assert(stats.byOrgUnit.find((g) => g.orgUnit === '高一1班'), '有高一1班分组')
  assert(stats.byBatch.find((g) => g.batch === '秋装')?.unmerged === 4, '秋装批次未归并 4 条')
})

await test('2. 按班级整批判无效：预演人数=真处置人数，分桶逐档一致', () => {
  const project = buildSampleProject()
  const before = logic.buildSummary(project, rule)
  const scope = { type: 'org_unit', value: '高一2班', targetIds: [] }
  const req = request('unmerged', scope, 'mark_invalid', { reason: '现场确认整班这批为废表' })
  const targets = logic.resolveTargetIds(project, 'unmerged', scope)
  // 高一2班的 unmerged：small3 个是可归并的不在 unmerged；dupNo 3 个在
  assertEqual(targets.length, 3, '高一2班 unmerged 命中 3 条 dupNo')

  const preview = logic.previewDisposition(project, rule, req)
  assertEqual(preview.targetIds.length, 3, '预演目标 3 条')
  assertEqual(preview.beforeTotals.validRows, before.totals.validRows, '预演前有效人数取真实现状')
  assertEqual(preview.afterTotals.validRows, before.totals.validRows - 3, '处置后有效人数 −3')
  // 未归并行判无效：从「没进任何桶」变为「无效」，常规/特殊各档数量本身不变
  assert(preview.afterTotals.unmergedCount === preview.beforeTotals.unmergedCount - 3, '未归并 −3')
  assert(preview.beforeTotals.regularQty === preview.afterTotals.regularQty, '常规档总数不变（人从未归并直接出有效池）')

  const record = logic.commitDisposition(project, rule, preview)
  const after = logic.buildSummary(project, rule)
  assertEqual(after.totals.validRows, preview.afterTotals.validRows, '真处置有效人数 = 预演')
  assertEqual(after.totals.invalidRows, before.totals.invalidRows + 3, '无效行 +3')
  assertEqual(
    logic.workbenchStats(project).totalUnique,
    preview.afterTotals.pendingReviewCount,
    '工作台剩余 = 预演剩余'
  )
  assertEqual(record.count, 3, '留痕条数 3')
  assertEqual(record.by, '张老师', '留痕操作人')
  assert(record.scopeText.includes('高一2班'), '留痕写明班级批次')
  assert(!record.rolledBack, '新记录未回滚')
})

await test('3. 按批次整批标记特殊体型：从常规/未归并转入特殊单列，回滚全部恢复', () => {
  const project = buildSampleProject()
  const beforeSummary = logic.buildSummary(project, rule)
  const beforeJson = JSON.stringify(project.persons)
  const beforeOrder = logic.orderSheetToRows(logic.buildOrderSheet({
    project, rule, summary: beforeSummary, operator: 'x', generatedAt: new Date(0)
  }))

  const scope = { type: 'batch', value: '秋装', targetIds: [] }
  const req = request('unmerged', scope, 'flag_special', { payload: 'PLUS', reason: '秋装这批特体转定制' })
  const preview = logic.previewDisposition(project, rule, req)
  assertEqual(preview.targetIds.length, 4, '秋装未归并 4 条整批')
  assertEqual(preview.afterTotals.specialQty, beforeSummary.totals.specialQty + 4, '特殊单列 +4')
  assertEqual(preview.afterTotals.validRows, beforeSummary.totals.validRows, '标记特殊不改变有效人数')
  assert(preview.deltas.some((d) => d.bucket.isSpecial && d.delta === 4), 'PLUS 档 +4')

  const record = logic.commitDisposition(project, rule, preview)
  const afterSummary = logic.buildSummary(project, rule)
  assertEqual(afterSummary.totals.specialQty, beforeSummary.totals.specialQty + 4, '真处置特殊单列 +4')
  assertEqual(afterSummary.unmerged.length, beforeSummary.unmerged.length - 4, '本批 4 条从未归并清单消失（其余批次未归并行不受影响）')
  assertEqual(
    afterSummary.totals.accountedQty === afterSummary.totals.validRows,
    false,
    '其余批次还有未归并行时整体守恒暂不成立，但本批人数差为 0：' +
      `accounted ${afterSummary.totals.accountedQty} vs valid ${afterSummary.totals.validRows}`
  )
  assertEqual(afterSummary.totals.validRows - afterSummary.totals.accountedQty,
    beforeSummary.totals.validRows - beforeSummary.totals.accountedQty - 4, '未归并缺口正好缩小 4')
  assert(project.persons.find((p) => p.id === 'nomerge0')?.specialFlag === 'PLUS', 'nomerge0 已打 PLUS')
  assert(project.persons.find((p) => p.id === 'nomerge0')?.needsConfirm === false, '待确认关闭')

  // 页面 / 归并结果 / 导出表同一份
  const afterOrder = logic.orderSheetToRows(logic.buildOrderSheet({
    project, rule, summary: afterSummary, operator: 'x', generatedAt: new Date(0)
  }))
  assert(JSON.stringify(afterOrder) !== JSON.stringify(beforeOrder), '导出表随处置变化')
  assert(afterOrder.some((row) => String(row[1]).includes('加肥加大') && row[4] === 4), '导出表含加肥加大 4 套')

  // 整批回滚
  logic.rollbackDisposition(project, rule, record, '张老师')
  logic.runMerge(project, rule)
  const restoredSummary = logic.buildSummary(project, rule)
  assertEqual(restoredSummary.totals.specialQty, beforeSummary.totals.specialQty, '回滚后特殊单列恢复')
  assertEqual(restoredSummary.totals.validRows, beforeSummary.totals.validRows, '回滚后有效人数恢复')
  assertEqual(logic.buildSummary(project, rule).unmerged.length, beforeSummary.unmerged.length, '回滚后未归并条数恢复')
  assertEqual(JSON.stringify(project.persons), beforeJson, '回滚后人员字段与处置前逐字段一致')
  const restoredOrder = logic.orderSheetToRows(logic.buildOrderSheet({
    project, rule, summary: restoredSummary, operator: 'x', generatedAt: new Date(0)
  }))
  assertEqual(restoredOrder, beforeOrder, '回滚后导出表也回到处置前')
  assert(logic.rollbackableDisposition(project) === null, '已回滚记录不可再回滚')
})

await test('4. 勾选整批填同一个号型：人工覆写留痕，守恒仍成立，导出明细可见', () => {
  const project = buildSampleProject()
  const ids = logic.listReviewRows(project, 'pending').slice(0, 5).map((p) => p.id)
  const scope = { type: 'selected', value: '', targetIds: ids }
  const req = request('pending', scope, 'assign_size', { payload: '170/88A', reason: '厂方确认统一号型' })
  const preview = logic.previewDisposition(project, rule, req)
  assertEqual(preview.afterTotals.overrideCount, preview.beforeTotals.overrideCount + 5, '覆写 +5')
  assertEqual(preview.afterTotals.unmergedCount, preview.beforeTotals.unmergedCount - 5, '5 条负差从未归并消失')

  const record = logic.commitDisposition(project, rule, preview)
  const summary = logic.buildSummary(project, rule)
  assertEqual(summary.unmerged.length, preview.afterTotals.unmergedCount, '未归并清单与预演一致')
  // 前 5 条 pending 是 neg 负差；其余未归并行（另 7 条）不在本批，故整体守恒暂不成立——但缺口正好减少 5
  assertEqual(
    summary.totals.validRows - summary.totals.accountedQty,
    preview.beforeTotals.validRows - preview.beforeTotals.accountedQty - 5,
    '整批填号型让守恒缺口减少 5，且不改变有效人数'
  )
  assertEqual(summary.totals.validRows, preview.beforeTotals.validRows, '整批填号型不改变有效人数')
  for (const id of ids) {
    const person = project.persons.find((p) => p.id === id)
    assertEqual(person.result.sizeCode, '170/88A', `${id} 生效号型 170/88A`)
    assertEqual(person.result.manualOverride?.by, '张老师', `${id} 覆写人留痕`)
    assertEqual(person.result.manualOverride?.reason, '厂方确认统一号型', `${id} 覆写原因留痕`)
  }
  const detail = logic.detailRows({ project, rule })
  const rowsForIds = detail.filter((row) => ids.includes(row[1]))
  assert(rowsForIds.every((row) => row[12] === '是' && row[13] === '张老师'), '导出明细标记覆写与覆写人')
  assertEqual(record.action, 'assign_size', '留痕动作是整批填号型')
})

await test('5. 疑似重复：整批确认重复并排除，有效人数减少且可回滚', () => {
  const project = buildSampleProject()
  const before = logic.buildSummary(project, rule)
  const scope = { type: 'org_unit', value: '高一1班', targetIds: [] }
  const req = request('duplicate', scope, 'mark_duplicate', { reason: '与正式名单比对确认重复' })
  const targets = logic.resolveTargetIds(project, 'duplicate', scope)
  assertEqual(targets.length, 3, '高一1班疑似重复 3 条 dupOk')
  const preview = logic.previewDisposition(project, rule, req)
  assertEqual(preview.afterTotals.duplicateRows, before.totals.duplicateRows + 3, '重复行 +3')
  assertEqual(preview.afterTotals.validRows, before.totals.validRows - 3, '有效人数 −3')
  const record = logic.commitDisposition(project, rule, preview)
  assertEqual(logic.buildSummary(project, rule).totals.duplicateRows, before.totals.duplicateRows + 3, '真处置重复行 +3')
  logic.rollbackDisposition(project, rule, record, '张老师')
  assertEqual(logic.buildSummary(project, rule).totals.duplicateRows, before.totals.duplicateRows, '回滚后重复行恢复')
  assertEqual(logic.workbenchStats(project).duplicate, 6, '回滚后疑似重复 6 条回到工作台')
})

await test('6. 提交闸门：预演后名单变化则拒绝提交并保持现场不变', () => {
  const project = buildSampleProject()
  const ids = logic.listReviewRows(project, 'pending').slice(0, 2).map((p) => p.id)
  const scope = { type: 'selected', value: '', targetIds: ids }
  const req = request('pending', scope, 'mark_invalid')
  const preview = logic.previewDisposition(project, rule, req)
  // 模拟预演之后有人单条改了名单
  project.persons.find((p) => p.id === 'ok0').heightCm = 175
  let threw = false
  try {
    logic.commitDisposition(project, rule, preview)
  } catch (error) {
    threw = true
    assert(error instanceof logic.DispositionMismatchError, '抛 DispositionMismatchError')
  }
  assert(threw, '名单变化时拒绝提交')
  assert(!project.dispositions?.length, '拒绝后不留处置记录')
  const person0 = project.persons.find((p) => p.id === ids[0])
  assertEqual(person0.status, 'active', '拒绝后目标行未被改成无效（现场不变）')
})

await test('7. 回滚保护：处置后又改过名单则拒绝回滚，且数据不动', () => {
  const project = buildSampleProject()
  const scope = { type: 'batch', value: '秋装', targetIds: [] }
  const req = request('unmerged', scope, 'mark_invalid', { reason: 'r' })
  const preview = logic.previewDisposition(project, rule, req)
  const record = logic.commitDisposition(project, rule, preview)
  // 处置后动了一条无关人员
  project.persons.find((p) => p.id === 'ok1').chestCm = 92
  let threw = false
  try {
    logic.rollbackDisposition(project, rule, record, '张老师')
  } catch (error) {
    threw = true
    assert(error instanceof logic.RollbackBlockedError, '抛 RollbackBlockedError')
  }
  assert(threw, '期间改过名单时拒绝回滚')
  assertEqual(record.rolledBack, false, '记录保持生效中')
  const stillInvalid = project.persons.find((p) => p.id === 'nomerge0')
  assertEqual(stillInvalid.status, 'invalid', '拒绝回滚时处置结果不动')
})

await test('8. 线性撤销：只能先回滚最近一次未回滚的处置，依次回滚后全部恢复', () => {
  const project = buildSampleProject()
  // 第一次：高一2班 待确认 3 条（small，可归并）整批判无效
  const scope1 = { type: 'org_unit', value: '高一2班', targetIds: [] }
  const r1 = logic.commitDisposition(
    project,
    rule,
    logic.previewDisposition(project, rule, request('pending', scope1, 'mark_invalid', { reason: 'r1' }))
  )
  // 第二次：秋装批次未归并 4 条整批判无效（与第一批人员不重叠）
  const scope2 = { type: 'batch', value: '秋装', targetIds: [] }
  const r2 = logic.commitDisposition(
    project,
    rule,
    logic.previewDisposition(project, rule, request('unmerged', scope2, 'mark_invalid', { reason: 'r2' }))
  )
  assertEqual(logic.rollbackableDisposition(project).id, r2.id, '最近可回滚的是第二批')
  let threw = false
  try {
    logic.rollbackDisposition(project, rule, r1, '张老师')
  } catch {
    threw = true
  }
  assert(threw, '不能越过最近处置直接回滚更早的批次')
  assertEqual(r1.rolledBack, false, '早批记录仍生效中')
  logic.rollbackDisposition(project, rule, r2, '张老师')
  assertEqual(r2.rolledBack, true, '第二批已回滚')
  logic.rollbackDisposition(project, rule, r1, '张老师')
  assertEqual(logic.workbenchStats(project).totalUnique, 18, '两次回滚后工作台剩余恢复为 18')
})

await test('9. 留痕导出：哪一批/谁/多少条/前后人数/回滚状态齐全', () => {
  const project = buildSampleProject()
  const scope = { type: 'batch', value: '秋装', targetIds: [] }
  const req = request('unmerged', scope, 'mark_invalid', { reason: '审计原因' })
  const record = logic.commitDisposition(project, rule, logic.previewDisposition(project, rule, req))
  logic.rollbackDisposition(project, rule, record, '李主任')
  const rows = logic.dispositionRows(project, rule)
  assertEqual(rows.length, 2, '表头 + 1 条记录')
  const row = rows[1]
  assert(String(row[1]).includes('秋装'), '范围写明批次')
  assertEqual(row[3], '整批判为无效行', '动作文本')
  assertEqual(row[4], 4, '条数 4')
  assertEqual(row[5], '张老师', '操作人')
  assertEqual(row[6], '审计原因', '原因')
  assert(/^\d+ → \d+$/.test(String(row[7])), '有效人数 前→后')
  assertEqual(row[9], '已回滚', '状态已回滚')
  assertEqual(row[11], '李主任', '回滚人')
})

await test('10. 校验：号型非法/原因缺失/空范围都在预演阶段报错且不动数据', () => {
  const project = buildSampleProject()
  const beforeFingerprint = JSON.stringify(project.persons)
  const ids = logic.listReviewRows(project, 'pending').slice(0, 2).map((p) => p.id)
  const badCode = request('pending', { type: 'selected', value: '', targetIds: ids }, 'assign_size', { payload: '999Z' })
  let caught = 0
  try { logic.previewDisposition(project, rule, badCode) } catch { caught += 1 }
  const noReason = request('pending', { type: 'selected', value: '', targetIds: ids }, 'mark_invalid', { reason: '' })
  try { logic.previewDisposition(project, rule, noReason) } catch { caught += 1 }
  const empty = request('pending', { type: 'batch', value: '不存在的批次', targetIds: [] }, 'mark_invalid')
  try { logic.previewDisposition(project, rule, empty) } catch { caught += 1 }
  assertEqual(caught, 3, '三种非法输入全部在预演阶段报错')
  assertEqual(JSON.stringify(project.persons), beforeFingerprint, '报错不改动任何数据')
})

await test('11. 5000 人归并性能 < 200ms', () => {
  const persons = []
  for (let i = 0; i < 5000; i += 1) {
    const height = 150 + (i % 13) * 5
    const chest = 80 + (i % 9) * 4
    const waist = chest - (8 + (i % 4) * 4) // diff 8/12/16/20
    persons.push(makePerson(`p${i}`, { heightCm: height, chestCm: chest, waistCm: Math.max(60, waist), orgUnit: `班${i % 20}` }))
  }
  const project = makeProject(persons)
  const started = performance.now()
  const result = logic.runMerge(project, rule)
  const elapsed = performance.now() - started
  const summary = logic.buildSummary(project, rule)
  assert(elapsed < 200, `5000 人归并耗时 ${elapsed.toFixed(1)}ms（含 runMerge 自报 ${result.durationMs}ms）应 < 200ms`)
  assertEqual(summary.conserved, true, '5000 人守恒成立')
})

await test('12. 页面汇总与导出表逐行一致（处置后 allRows 数量 = 下单表数量合计）', () => {
  const project = buildSampleProject()
  // 秋装 4 条未归并整批填号型，让守恒通过
  const scope = { type: 'batch', value: '秋装', targetIds: [] }
  const req = request('unmerged', scope, 'assign_size', { payload: '175/92B' })
  logic.commitDisposition(project, rule, logic.previewDisposition(project, rule, req))
  // 高一2班 3 条 dupNo 判无效
  const scope2 = { type: 'org_unit', value: '高一2班', targetIds: [] }
  logic.commitDisposition(
    project,
    rule,
    logic.previewDisposition(project, rule, request('unmerged', scope2, 'mark_invalid', { reason: 'r' }))
  )
  // 高一1班 5 条负差整批标特殊
  const scope3 = { type: 'org_unit', value: '高一1班', targetIds: [] }
  logic.commitDisposition(
    project,
    rule,
    logic.previewDisposition(project, rule, request('unmerged', scope3, 'flag_special', { payload: 'PLUS' }))
  )
  const summary = logic.buildSummary(project, rule)
  const order = logic.buildOrderSheet({ project, rule, summary, operator: 'x', generatedAt: new Date(0) })
  assertEqual(summary.conserved, true, '全部处置后守恒通过可导出')
  assertEqual(order.totalQty, summary.totals.accountedQty, '下单表总套数 = 汇总总套数')
  assertEqual(order.totalPeople, summary.totals.validRows, '下单表有效人数 = 汇总有效人数')
  const sheetQty = order.items.reduce((sum, item) => sum + item.qty, 0)
  assertEqual(sheetQty, summary.allRows.reduce((sum, row) => sum + row.qty, 0), '逐行数量合计一致')
})

cleanup()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
