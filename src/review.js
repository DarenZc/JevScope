import path from 'node:path';
import { createHash } from 'node:crypto';
import { activeTask, readState, writeState } from './task.js';
import { snapshot, changesBetween, contentAt, withinBoundary } from './repo.js';
import { judge } from './jev.js';
import { withCheckLock } from './check-lock.js';
import { planReview, REVIEW_VERSION } from './review-plan.js';
import { groundedJudgment, explainEvidence } from './evidence.js';
export { reviewableChanges } from './review-plan.js';

export function boundaryFindings(task, changes) {
  return changes.flatMap(change => {
    const findings = [];
    if (task.mode === 'review') findings.push({ file: change.file, level: 'violation', kind: 'read-only', reason: '任务为只读审查，出现了文件修改。' });
    if (task.allowedPaths.length && !task.allowedPaths.some(boundary => withinBoundary(change.file, boundary))) {
      findings.push({ file: change.file, level: 'violation', kind: 'file-boundary', reason: '超出显式允许的文件范围。' });
    }
    return findings;
  });
}

export function dependencyAdditions(before, after) {
  const oldPackage = before ? JSON.parse(before) : {};
  const newPackage = after ? JSON.parse(after) : {};
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    .flatMap(section => Object.keys(newPackage[section] ?? {})
      .filter(name => !Object.hasOwn(oldPackage[section] ?? {}, name)).map(name => `${section}:${name}`));
}

export async function reviewChanges(task, changes, options = {}) {
  const report = {
    version: 1, reviewVersion: REVIEW_VERSION, taskId: task.id, revision: task.revision, goal: task.requirements[0].text,
    checkedAt: new Date().toISOString(), requirements: task.requirements, constraints: task.constraints,
    files: changes.map(({ id, file, operation, diff }) => ({ id, file, operation,
      contentHash: createHash('sha256').update(diff).digest('hex') })),
    findings: boundaryFindings(task, changes), judgments: [], skipped: [],
    semantic: changes.length ? 'incomplete' : 'not-needed',
  };
  const plan = planReview(task, changes);
  report.skipped = plan.skipped;
  report.redacted = plan.redacted;
  report.coverage = { totalFiles: changes.length, completeFiles: 0, totalParts: plan.units.length,
    reviewedParts: 0, batches: plan.batches.length, completedBatches: 0 };
  if (!changes.length) return report;
  if (options.offline) report.notice = '离线模式：只检查显式规则，未进行语义判断。';
  else if (plan.batches.length) {
    const deadline = options.deadlineAt ?? Date.now() + (options.budgetMs ?? 28000);
    const results = new Array(plan.batches.length);
    let next = 0, failure;
    // At most two in-flight requests; stop scheduling after a failure, with no automatic retry.
    async function worker() {
      while (next < plan.batches.length && !failure) {
        if (Date.now() >= deadline) { failure = '达到本次检查时间预算，剩余片段未送审。'; return; }
        const index = next++, batch = plan.batches[index];
        try {
          const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 12000, deadline - Date.now()));
          const result = await (options.judgeImpl ?? judge)(task, batch.changes, { ...options, context: batch.context, timeoutMs });
          if (result.judgments.length !== batch.changes.length || batch.changes.some(unit =>
            result.judgments.filter(j => j.id === unit.id && j.file === unit.file).length !== 1)) {
            throw new Error('Jev 返回的片段结果不完整。');
          }
          results[index] = result;
        } catch (error) { failure = error.message; }
      }
    }
    await Promise.all([worker(), worker()]);
    const judged = new Map();
    report.usage = {};
    for (const [index, result] of results.entries()) {
      if (!result) continue;
      report.coverage.completedBatches++;
      report.model = result.model;
      for (const name of ['input_tokens', 'output_tokens', 'cost']) {
        if (Number.isFinite(result.usage?.[name])) report.usage[name] = (report.usage[name] ?? 0) + result.usage[name];
      }
      for (const unit of plan.batches[index].changes) {
        judged.set(unit.id, { ...groundedJudgment(result.judgments.find(item => item.id === unit.id), unit), part: unit.part });
      }
    }
    report.coverage.reviewedParts = judged.size;
    if (failure) report.notice = failure;
    for (const change of changes) {
      const units = plan.units.filter(unit => unit.file === change.file);
      const parts = units.map(unit => judged.get(unit.id)).filter(Boolean);
      if (!units.length) continue;
      const complete = parts.length === units.length && !report.skipped.some(item => item.file === change.file);
      if (!complete && !report.skipped.some(item => item.file === change.file)) {
        report.skipped.push({ file: change.file, reason: `仅完成 ${parts.length}/${units.length} 个片段；其余检查未完成` });
      }
      if (!parts.length) continue;
      if (complete) report.coverage.completeFiles++;
      const redacted = plan.redacted.some(item => item.file === change.file);
      const extra = parts.find(item => item.relation === 'extra');
      const uncertain = parts.find(item => item.relation === 'uncertain');
      const basis = extra ?? uncertain ?? parts.find(item => item.relation === 'explicit') ?? parts[0];
      const conflictIds = [...new Set(parts.map(item => item.conflictId).filter(Boolean))];
      const item = { ...basis, id: change.id, file: change.file,
        relation: extra ? 'extra' : !complete || redacted || uncertain ? 'uncertain' : basis.relation,
        confidence: Math.min(...parts.map(item => item.confidence)), conflictId: conflictIds[0] ?? null, conflictIds,
        parts, complete, redacted };
      delete item.part;
      report.judgments.push(item);
      if (item.relation === 'extra') {
        for (const part of parts.filter(part => part.relation === 'extra' && part.scopeReason !== 'constraint')) {
          report.findings.push({ file: item.file, level: 'warning', kind: 'extra', evidence: part.evidence,
            requirementId: part.requirementId, ...explainEvidence(part, task) });
        }
      }
      if (item.relation === 'uncertain') report.findings.push({ file: item.file, level: 'review', kind: 'uncertain', reason:
        !complete ? '部分片段未完成审查，不能认定整个文件通过。' : redacted ? '疑似凭据值已隐藏，仅检查了周边代码。' : parts.some(part => part.unsupportedWarning || part.rawRelation === 'extra') ? '证据不足：未定位到具体的越界改动及其范围依据，保留待核对。' : '现有代码证据不足以确认需求关系，需核对。' });
      for (const part of parts.filter(part => part.conflictId)) report.findings.push({ file: item.file, level: 'warning', kind: 'constraint',
        constraintId: part.conflictId, evidence: part.evidence, ...explainEvidence(part, task) });
    }
    report.semantic = report.skipped.length ? 'incomplete' : 'complete';
  }
  return report;
}

export async function checkRepository(repo, options = {}) {
  const deadlineAt = Date.now() + (options.budgetMs ?? 28000);
  return withCheckLock(repo, options.automatic, () => checkUnlocked(repo, { ...options, deadlineAt }));
}

async function checkUnlocked(repo, options) {
  const task = await activeTask(repo);
  if (!task?.active) throw new Error('请先用 start 建立任务。');
  const current = await snapshot(repo);
  const cacheKey = `${task.id}:${task.revision}:${current}`;
  const previous = await readState(repo, 'latest.json');
  const reusable = previous?.semantic === 'complete' || previous?.semantic === 'not-needed'
    || (options.automatic && Date.now() - Date.parse(previous?.checkedAt) < 30000);
  if (!options.offline && !options.refresh && previous?.reviewVersion === REVIEW_VERSION && previous?.cacheKey === cacheKey && reusable) {
    return { ...previous, cached: true };
  }
  const changes = await changesBetween(repo, task.baseline, current);
  const report = await reviewChanges(task, changes, options);
  if (task.noDependencies) {
    for (const change of changes.filter(item => path.posix.basename(item.file) === 'package.json')) {
      try {
        const additions = dependencyAdditions(await contentAt(repo, task.baseline, change.file), await contentAt(repo, current, change.file));
        if (additions.length) report.findings.push({ file: change.file, level: 'violation', kind: 'dependencies', reason: `任务禁止新增依赖：${additions.join('、')}` });
      } catch { report.skipped.push({ file: change.file, reason: '无法解析 package.json，依赖规则未完成检查' }); }
    }
  }
  if (report.skipped.length && report.semantic === 'complete') report.semantic = 'incomplete';
  report.cacheKey = cacheKey;
  const active = await activeTask(repo);
  if (!active?.active || active.id !== task.id || active.revision !== task.revision || await snapshot(repo) !== current) {
    return { ...report, stale: true };
  }
  await writeState(repo, 'latest.json', report);
  return report;
}
