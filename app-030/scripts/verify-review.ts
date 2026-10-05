/**
 * 核心逻辑自检（不在浏览器里，纯 Node 跑）：
 * 1) 三类桶归集正确
 * 2) 预演数字 == 真处置后数字（apply 内部已强制核对，这里再断言一次）
 * 3) 各档增减、有效人数、剩余条数与演算一致
 * 4) 整批回滚后归并结果、人数、剩余条数完全回到处置前
 * 5) LIFO：非最近批次不能回滚
 * 6) 判无效 / 统一号型 / 特殊标记 / 清重复四种动作
 * 7) 5000 人性能
 */
import { BUILTIN_RULES } from '../src/logic/sizeRules'
import { runMerge, buildSummary } from '../src/logic/merge'
import {
  applyBulkDisposal,
  bucketsOf,
  canRollback,
  countByBucket,
  forecastDisposal,
  reviewablePersons,
  rollbackBulkDisposal,
  type ReviewBucketKey
} from '../src/logic/review'
import type { Person, Project } from '../src/logic/types'

const rule = BUILTIN_RULES[0]
let failures = 0

function assert(cond: boolean, message: string): void {
  if (!cond) {
    failures += 1
    console.error(`  ✗ ${message}`)
  } else {
    console.log(`  ✓ ${message}`)
  }
}

function makePerson(partial: Partial<Person> & { id: string; name: string }): Person {
  return {
    gender: 'male',
    orgUnit: '高一(1)班',
    batch: '春装',
    heightCm: 170,
    weightKg: 60,
    chestCm: 88,
    waistCm: 72,
    specialFlag: null,
    note: '',
    status: 'active',
    statusReason: '',
    anomaly: [],
    needsConfirm: false,
    possibleDuplicateOf: null,
    sourceRow: null,
    source: 'manual',
    result: null,
    createdAt: 0,
    ...partial
  }
}

function makeProject(persons: Person[]): Project {
  return {
    id: 'prj_test',
    name: '测试项目',
    kind: 'school',
    ruleVersion: rule.version,
    batches: ['春装'],
    persons,
    imports: [],
    bulkDisposals: [],
    createdAt: 0,
    updatedAt: 0
  }
}

function totals(project: Project) {
  runMerge(project, rule)
  const s = buildSummary(project, rule)
  return { s, review: reviewablePersons(project).length }
}

/* ------------------------------- 场景 ------------------------------- */

console.log('\n[1] 三类桶归集')
{
  const p1 = makePerson({ id: 'a', name: '张三' }) // 正常，可归并 → 无桶
  const p2 = makePerson({ id: 'b', name: '李四', chestCm: 80, waistCm: 84, needsConfirm: true, anomaly: ['diff_out_of_range'] }) // 胸腰差为负 → pending + unmerged
  const p3 = makePerson({ id: 'c', name: '王五', possibleDuplicateOf: '既有行「张三」', needsConfirm: true, anomaly: ['diff_out_of_range'], chestCm: 90, waistCm: 90 }) // pending+unmerged+duplicate
  const p4 = makePerson({ id: 'd', name: '赵六', status: 'invalid', statusReason: '缺胸围', needsConfirm: true })
  const project = makeProject([p1, p2, p3, p4])
  runMerge(project, rule)
  assert(bucketsOf(p1).length === 0, '正常可归并行不进工作台')
  const b2 = bucketsOf(project.persons[1])
  assert(b2.includes('pending') && b2.includes('unmerged') && !b2.includes('duplicate'), '胸腰差落不进档 → 待确认+没能归并')
  const b3 = bucketsOf(project.persons[2])
  assert(b3.length === 3, '疑似重复且落不进档 → 同时命中三类')
  assert(bucketsOf(p4).length === 0, '已判无效行不在工作台')
  const counts = countByBucket(reviewablePersons(project))
  assert(counts.pending === 2 && counts.unmerged === 2 && counts.duplicate === 1, `桶计数正确（${JSON.stringify(counts)}）`)
  assert(reviewablePersons(project).length === 2, '工作台去重后 2 行')
}

console.log('\n[2] 整批判无效：预演 == 真处置，人数下降、剩余条数正确')
{
  const persons = [
    makePerson({ id: 'a', name: '张三' }),
    makePerson({ id: 'b', name: '李四', orgUnit: '高一(2)班' }),
    makePerson({ id: 'c', name: '王五', chestCm: 80, waistCm: 84, needsConfirm: true, anomaly: ['diff_out_of_range'] }),
    makePerson({ id: 'd', name: '赵六', chestCm: 82, waistCm: 86, needsConfirm: true, anomaly: ['diff_out_of_range'] })
  ]
  const project = makeProject(persons)
  runMerge(project, rule)
  const before = buildSummary(project, rule)
  assert(before.totals.validRows === 4 && before.conserved === false, `处置前 4 有效、不守恒（未归并 ${before.unmerged.length}）`)

  const ids = ['c', 'd']
  const forecast = forecastDisposal(project, rule, ids, {
    action: 'invalid',
    targetStatus: 'invalid',
    reason: '现场联系不上',
    by: '王老师'
  })
  assert(forecast.afterTotals.validRows === 2, `预演有效人数 4→2（得 ${forecast.afterTotals.validRows}）`)
  assert(forecast.afterUnmergedIds.length === 0, '预演未归并清零')
  assert(forecast.afterRemaining === 0, '预演剩余待复核 0')

  const result = applyBulkDisposal(project, rule, {
    selectedIds: ids,
    params: { action: 'invalid', targetStatus: 'invalid', reason: '现场联系不上', by: '王老师' },
    buckets: ['pending', 'unmerged'],
    scope: { kind: 'custom' }
  })
  assert(result.ok, `真处置提交成功（${result.ok ? '' : result.error}）`)
  const after = buildSummary(project, rule)
  assert(after.totals.validRows === 2, `真处置有效人数 = 2（得 ${after.totals.validRows}）`)
  assert(after.totals.invalidRows === 2, '无效行 = 2')
  assert(after.conserved === true, '处置后守恒通过')
  assert(reviewablePersons(project).length === 0, '工作台清零')
  assert(project.bulkDisposals!.length === 1 && project.bulkDisposals![0].affectedCount === 2, '留痕 1 批 2 条')
}

console.log('\n[3] 整批统一填号型：目标档人数增加、原档减少（覆写留痕）')
{
  // 两个胸腰差落不进档的人 + 两个正常 170/88A 的人
  const persons = [
    makePerson({ id: 'a', name: '张三' }), // 170/88, diff 16 → A
    makePerson({ id: 'b', name: '李四' }),
    makePerson({ id: 'c', name: '王五', chestCm: 90, waistCm: 60, needsConfirm: true, anomaly: ['diff_out_of_range'] }), // diff 30 落不进
    makePerson({ id: 'd', name: '赵六', chestCm: 92, waistCm: 62, needsConfirm: true, anomaly: ['diff_out_of_range'] })
  ]
  const project = makeProject(persons)
  runMerge(project, rule)
  const before = buildSummary(project, rule)
  const rowBefore = new Map(before.allRows.map((r) => [`${r.sizeCode}|${r.gender}`, r.qty]))

  const forecast = forecastDisposal(project, rule, ['c', 'd'], {
    action: 'assign_size',
    sizeCode: '170/92B',
    reason: '厂家确认统一',
    by: '王老师'
  })
  const deltaByCode = new Map(forecast.sizeDeltas.map((d) => [`${d.sizeCode}|${d.gender}`, d.delta]))
  assert(forecast.beforeUnmergedIds.length === 2, '处置前 2 行未归并')
  assert((deltaByCode.get('170/92B|male') ?? 0) === 2, '预演 170/92B 男 +2')
  assert(forecast.afterTotals.validRows === 4 && forecast.afterTotals.regularQty === 4, '预演有效 4、常规 4')
  assert(forecast.afterRemaining === 0 && forecast.afterUnmergedIds.length === 0, '预演未归并清零')

  const result = applyBulkDisposal(project, rule, {
    selectedIds: ['c', 'd'],
    params: { action: 'assign_size', sizeCode: '170/92B', reason: '厂家确认统一', by: '王老师' },
    buckets: ['pending', 'unmerged'],
    scope: { kind: 'group', groupKind: 'orgUnit', groupLabel: '高一(1)班' }
  })
  assert(result.ok, `统一填号型提交成功（${result.ok ? '' : result.error}）`)
  const after = buildSummary(project, rule)
  const rowAfter = new Map(after.allRows.map((r) => [`${r.sizeCode}|${r.gender}`, r.qty]))
  assert(rowAfter.get('170/92B|male') === 2, `真处置后 170/92B 男 = 2（得 ${rowAfter.get('170/92B|male')}）`)
  assert((rowBefore.get('170/88A|male') ?? 0) === 2 && (rowAfter.get('170/88A|male') ?? 0) === 2, '原有 170/88A 不受影响')
  assert(after.totals.overrideCount === 2, '两条都记为人工覆写')
  const c = project.persons.find((p) => p.id === 'c')!
  assert(c.result?.manualOverride?.reason === '厂家确认统一' && c.result.manualOverride.by === '王老师', '逐人覆写留痕（原因+操作人）')
  assert(c.result.ruleSizeCode === '', '规则未覆盖时规则号型为空串')
  assert(after.conserved === true, '守恒通过')
}

console.log('\n[4] 整批特殊体型标记：常规档减少、特殊单列增加')
{
  const persons = [
    makePerson({ id: 'a', name: '张三' }),
    makePerson({ id: 'b', name: '李四' }),
    makePerson({ id: 'c', name: '王五', needsConfirm: true, anomaly: ['chest_out_of_range'], chestCm: 120, waistCm: 112 }) // diff 8 → B 可归并但数值可疑
  ]
  const project = makeProject(persons)
  runMerge(project, rule)
  const forecast = forecastDisposal(project, rule, ['c'], {
    action: 'special',
    specialFlagCode: 'PLUS',
    reason: '加肥加大',
    by: '王老师'
  })
  const delta = new Map(forecast.sizeDeltas.map((d) => [`${d.ispecial ? 'S' : 'R'}|${d.sizeCode}`, d]))
  void delta
  const specialDelta = forecast.sizeDeltas.find((d) => d.isSpecial && d.sizeCode === 'PLUS')
  assert(specialDelta?.delta === 1, '预演特殊单列 PLUS +1')
  assert(forecast.afterTotals.specialQty === 1 && forecast.afterTotals.regularQty === 2, '预演特殊 1、常规 2')
  assert(forecast.afterRemaining === 0, '该人退出待确认，剩余 0')

  const result = applyBulkDisposal(project, rule, {
    selectedIds: ['c'],
    params: { action: 'special', specialFlagCode: 'PLUS', reason: '加肥加大', by: '王老师' },
    buckets: ['pending'],
    scope: { kind: 'custom' }
  })
  assert(result.ok, `特殊标记提交成功（${result.ok ? '' : result.error}）`)
  const after = buildSummary(project, rule)
  assert(after.totals.specialQty === 1 && after.totals.regularQty === 2 && after.totals.validRows === 3, '真处置 特殊1/常规2/有效3')
  assert(after.conserved === true, '守恒通过')
}

console.log('\n[5] 整批回滚：归并结果、人数、剩余条数全部回到处置前')
{
  const persons = [
    makePerson({ id: 'a', name: '张三' }),
    makePerson({ id: 'b', name: '李四' }),
    makePerson({ id: 'c', name: '王五', chestCm: 80, waistCm: 84, needsConfirm: true, anomaly: ['diff_out_of_range'] }),
    makePerson({ id: 'd', name: '赵六', chestCm: 82, waistCm: 86, needsConfirm: true, anomaly: ['diff_out_of_range'] })
  ]
  const project = makeProject(persons)
  runMerge(project, rule)
  const before = buildSummary(project, rule)
  const beforeRows = JSON.stringify([...before.allRows.map((r) => `${r.sizeCode}|${r.gender}=${r.qty}`)].sort())
  const beforeRemaining = reviewablePersons(project).length

  applyBulkDisposal(project, rule, {
    selectedIds: ['c', 'd'],
    params: { action: 'assign_size', sizeCode: '175/96C', reason: '测试', by: '王老师' },
    buckets: ['pending', 'unmerged'],
    scope: { kind: 'custom' }
  })
  assert(reviewablePersons(project).length === 0, '处置后工作台清零')
  const disposalId = project.bulkDisposals![0].id

  const rb = rollbackBulkDisposal(project, rule, disposalId, '王老师')
  assert(rb.ok, `回滚成功（${rb.ok ? '' : rb.error}）`)
  runMerge(project, rule)
  const after = buildSummary(project, rule)
  const afterRows = JSON.stringify([...after.allRows.map((r) => `${r.sizeCode}|${r.gender}=${r.qty}`)].sort())
  assert(afterRows === beforeRows, '回滚后号型档分布与处置前逐档一致')
  assert(after.totals.validRows === before.totals.validRows, `回滚后有效人数恢复 ${before.totals.validRows}`)
  assert(after.totals.regularQty === before.totals.regularQty, '回滚后常规档合计恢复')
  assert(after.unmerged.length === before.unmerged.length, '未归并行恢复')
  assert(reviewablePersons(project).length === beforeRemaining, `剩余待复核恢复为 ${beforeRemaining}`)
  assert(project.bulkDisposals![0].rolledBack && project.bulkDisposals![0].rollbackBy === '王老师', '留痕标记为已回滚并记录回滚人')
  const c = project.persons.find((p) => p.id === 'c')!
  assert(c.result === null && c.needsConfirm === true, '该人号型与待确认状态一起回来')
}

console.log('\n[6] LIFO：有更新批次时旧批次不能回滚')
{
  const persons = [
    makePerson({ id: 'a', name: '张三' }),
    makePerson({ id: 'c', name: '王五', chestCm: 80, waistCm: 84, needsConfirm: true, anomaly: ['diff_out_of_range'] }),
    makePerson({ id: 'd', name: '赵六', chestCm: 82, waistCm: 86, needsConfirm: true, anomaly: ['diff_out_of_range'] })
  ]
  const project = makeProject(persons)
  runMerge(project, rule)
  const r1 = applyBulkDisposal(project, rule, {
    selectedIds: ['c'],
    params: { action: 'invalid', targetStatus: 'invalid', reason: '第一批', by: '王老师' },
    buckets: ['pending', 'unmerged'],
    scope: { kind: 'custom' }
  })
  // d 在 c 被判无效后仍在台上
  const r2 = applyBulkDisposal(project, rule, {
    selectedIds: ['d'],
    params: { action: 'assign_size', sizeCode: '170/88A', reason: '第二批', by: '王老师' },
    buckets: ['pending', 'unmerged'],
    scope: { kind: 'custom' }
  })
  assert(r1.ok && r2.ok, '两批处置成功')
  assert(canRollback(project, r1.disposal.id) === false, '旧批次（其后有未回滚批次）不可回滚')
  assert(canRollback(project, r2.disposal.id) === true, '最近一批可以回滚')
  const fail = rollbackBulkDisposal(project, rule, r1.disposal.id, '王老师')
  assert(!fail.ok, '强行回滚旧批次被拒绝')
  const ok2 = rollbackBulkDisposal(project, rule, r2.disposal.id, '王老师')
  assert(ok2.ok, '先回滚最近一批成功')
  assert(canRollback(project, r1.disposal.id) === true, '回滚后旧批次成为最近批次，可回滚')
}

console.log('\n[7] 疑似重复：整批判重复排除 + 整批清除标记')
{
  const persons = [
    makePerson({ id: 'a', name: '张三' }),
    makePerson({ id: 'b', name: '张三', possibleDuplicateOf: '既有行「张三」', needsConfirm: true })
  ]
  const project = makeProject(persons)
  runMerge(project, rule)
  const counts = countByBucket(reviewablePersons(project))
  assert(counts.duplicate === 1, '1 条疑似重复')

  const r = applyBulkDisposal(project, rule, {
    selectedIds: ['b'],
    params: { action: 'invalid', targetStatus: 'duplicate', reason: '确认为重复登记', by: '王老师' },
    buckets: ['duplicate'],
    scope: { kind: 'custom' }
  })
  assert(r.ok, '判重复并排除成功')
  const after = buildSummary(project, rule)
  assert(after.totals.duplicateRows === 1 && after.totals.validRows === 1, '重复行 1、有效 1')
  assert(reviewablePersons(project).length === 0, '工作台清零')

  // 回滚后再整批清除
  rollbackBulkDisposal(project, rule, r.disposal.id, '王老师')
  assert(countByBucket(reviewablePersons(project)).duplicate === 1, '回滚后疑似重复回来')
  const r2 = applyBulkDisposal(project, rule, {
    selectedIds: ['b'],
    params: { action: 'clear_duplicate', reason: '已核对同名不同人', by: '王老师' },
    buckets: ['duplicate'],
    scope: { kind: 'custom' }
  })
  assert(r2.ok, '整批清除疑似重复成功')
  const b = project.persons.find((p) => p.id === 'b')!
  assert(b.possibleDuplicateOf === null && b.status === 'active', '疑似重复标记清除，仍计入有效人数')
  assert(countByBucket(reviewablePersons(project)).duplicate === 0, '疑似重复桶清零')
  assert(buildSummary(project, rule).conserved === true, '守恒通过')
}

console.log('\n[8] 按班级整批选中 + 留痕范围描述')
{
  const persons = [
    makePerson({ id: 'a', name: 'A', orgUnit: '高一(1)班' }),
    makePerson({ id: 'b', name: 'B', orgUnit: '高一(1)班', chestCm: 80, waistCm: 84, needsConfirm: true, anomaly: ['diff_out_of_range'] }),
    makePerson({ id: 'c', name: 'C', orgUnit: '高一(1)班', chestCm: 82, waistCm: 86, needsConfirm: true, anomaly: ['diff_out_of_range'] }),
    makePerson({ id: 'd', name: 'D', orgUnit: '高一(2)班', chestCm: 84, waistCm: 88, needsConfirm: true, anomaly: ['diff_out_of_range'] })
  ]
  const project = makeProject(persons)
  runMerge(project, rule)
  const r = applyBulkDisposal(project, rule, {
    selectedIds: ['b', 'c'],
    params: { action: 'invalid', targetStatus: 'invalid', reason: '整班复核无效', by: '王老师' },
    buckets: ['pending', 'unmerged'],
    scope: { kind: 'group', groupKind: 'orgUnit', groupLabel: '高一(1)班' }
  })
  assert(r.ok, '按班级整批处置成功')
  assert(r.disposal.scopeSummary.includes('高一(1)班') && r.disposal.orgUnit === '高一(1)班', `留痕含班级与范围：${r.disposal.scopeSummary}`)
  assert(r.disposal.affectedCount === 2 && project.bulkDisposals![0].by === '王老师', '记录处置条数与操作人')
  // 另一班不受影响
  assert(reviewablePersons(project).length === 1, '高一(2)班那行仍在台上')
}

console.log('\n[9] 已特殊单列的行不适用统一号型（跳过并提示）')
{
  const persons = [
    makePerson({ id: 'a', name: 'A', specialFlag: 'PLUS', needsConfirm: false }),
    makePerson({ id: 'b', name: 'B', chestCm: 80, waistCm: 84, needsConfirm: true, anomaly: ['diff_out_of_range'] })
  ]
  // a 已特殊单列：不在台上（无桶），即便被误传 id 也应跳过
  const project = makeProject(persons)
  runMerge(project, rule)
  const forecast = forecastDisposal(project, rule, ['a', 'b'], {
    action: 'assign_size',
    sizeCode: '170/88A',
    reason: 'x',
    by: '王老师'
  })
  assert(forecast.skippedCount === 1 && forecast.affectedCount === 1, '特殊行跳过、实际处置 1 行')
}

console.log('\n[10] 性能：5000 人预演 + 真处置')
{
  const persons: Person[] = []
  for (let i = 0; i < 5000; i += 1) {
    const bad = i % 10 === 0
    persons.push(
      makePerson({
        id: `p${i}`,
        name: `同学${i}`,
        sourceRow: i + 2,
        ...(bad
          ? { chestCm: 80, waistCm: 84, needsConfirm: true, anomaly: ['diff_out_of_range' as const] }
          : {})
      })
    )
  }
  const project = makeProject(persons)
  const t0 = performance.now()
  runMerge(project, rule)
  buildSummary(project, rule)
  const ids = persons.filter((p) => p.needsConfirm).map((p) => p.id)
  const t1 = performance.now()
  const forecast = forecastDisposal(project, rule, ids, {
    action: 'invalid',
    targetStatus: 'invalid',
    reason: '批量',
    by: '王老师'
  })
  const t2 = performance.now()
  const result = applyBulkDisposal(project, rule, {
    selectedIds: ids,
    params: { action: 'invalid', targetStatus: 'invalid', reason: '批量', by: '王老师' },
    buckets: ['pending', 'unmerged'] as ReviewBucketKey[],
    scope: { kind: 'custom' }
  })
  const t3 = performance.now()
  assert(result.ok, `5000 人整批处置 ${ids.length} 条提交成功`)
  assert(forecast.afterTotals.validRows === 5000 - ids.length, '预演有效人数正确')
  assert(buildSummary(project, rule).conserved, '处置后守恒')
  console.log(`     归并+汇总 ${(t1 - t0).toFixed(1)}ms ｜ 预演 ${(t2 - t1).toFixed(1)}ms ｜ 真处置+核对 ${(t3 - t2).toFixed(1)}ms`)
}

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
if (failures > 0) process.exit(1)
