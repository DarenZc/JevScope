import { evidenceLocation } from './evidence.js';

const RELATION_LABELS = { explicit: '直接需求', necessary: '必要改动', extra: '疑似额外', uncertain: '需核对' };

export function importantFindings(report) {
  return report.findings.filter(item => item.level !== 'review');
}

export function renderNotice(report, detailCommand = 'jev-scope report') {
  if (report.stale) return '';
  const findings = importantFindings(report);
  const files = [...new Set(findings.map(item => item.file))];
  if (!files.length && report.semantic !== 'incomplete') return '';
  const short = (text, max = 160) => { const value = String(text).replace(/\s+/g, ' '); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
  const lines = [files.length ? `Jev Scope：${files.length} 个文件需关注。`
    : 'Jev Scope：范围检查未完成。'];
  for (const file of files.slice(0, 3)) {
    const entries = findings.filter(item => item.file === file);
    const details = entries.map(item => item.constraintId && !item.evidence
      ? `${item.constraintId}：${report.constraints.find(c => c.id === item.constraintId)?.text ?? item.reason}` : item.reason)
      .map(text => String(text).replace(/[。；;]+$/u, ''));
    const first = entries.find(item => item.constraintId && item.evidence) ?? entries[0];
    const constraint = entries.find(item => item.constraintId && item !== first);
    const scope = constraint
      ? `${first.scopeExplanation ?? first.reason}；${constraint.constraintId}「${report.constraints.find(c => c.id === constraint.constraintId)?.text ?? constraint.reason}」`
      : first.scopeExplanation ?? first.reason;
    const message = first.evidence ? `${short(first.changeSummary ?? first.evidence.summary, 100)}；${short(scope, 120)}` : short([...new Set(details)].join('；'));
    lines.push(`- ${short(evidenceLocation(file, first.evidence))}：${message}${first.evidence && entries.length > 1 ? `（另 ${entries.length - 1} 项见报告）` : ''}`);
  }
  if (files.length > 3) lines.push(`另有 ${files.length - 3} 个文件，详见报告。`);
  if (report.semantic === 'incomplete') lines.push(short(report.notice ?? '部分文件未完成检查，不能视为全部通过。'));
  lines.push(`详情：${detailCommand}`);
  return lines.join('\n');
}

export function renderReport(report) {
  const lines = [`任务：${report.goal}`, `本次变更：${report.files.length} 个文件`];
  if (report.coverage && report.files.length) lines.push(`检查覆盖：${report.coverage.completeFiles}/${report.coverage.totalFiles} 个文件 · ${report.coverage.reviewedParts}/${report.coverage.totalParts} 个片段`);
  if (report.stale) lines.push('此结果已过期：需求或文件已变化，请重新 check。');
  if (report.checkedAt) lines.push(`检查时间：${report.checkedAt} · 需求版本 ${report.revision}`);
  if (report.cached) lines.push('复用相同需求与改动的上次检查，没有再次调用 API。');
  if (!report.files.length) lines.push('与任务开始时相比，没有 Git 可见改动。');
  for (const item of report.judgments) {
    const source = report.requirements.find(req => req.id === item.requirementId);
    lines.push(`${RELATION_LABELS[item.relation]}  ${item.file}${source ? ` ← ${source.id}：${source.text}` : ''}`);
  }
  if (report.findings.length) {
    lines.push('', '需要关注：');
    for (const item of report.findings) {
      lines.push(`- ${evidenceLocation(item.file, item.evidence)}：${item.reason}`);
      if (item.evidence?.before) lines.push(`  改前：${item.evidence.before}`);
      if (item.evidence?.after) lines.push(`  改后：${item.evidence.after}`);
      if (item.constraintId) lines.push(`  ${item.constraintId}：${report.constraints.find(c => c.id === item.constraintId)?.text ?? ''}`);
    }
  } else if (report.semantic === 'complete' && !report.stale) lines.push('本次筛查未发现范围偏离。');
  if (report.notice) lines.push('', report.notice);
  for (const item of report.skipped) lines.push(`未送审  ${item.file}：${item.reason}`);
  if (report.redacted?.length) lines.push(`已隐藏 ${report.redacted.length} 个文件中的疑似凭据值；相关文件保留为需核对。`);
  if (report.semantic === 'incomplete') lines.push('语义检查未完整完成，不能据此认定全部改动都在范围内。');
  if (Number.isFinite(report.usage?.cost)) lines.push(`${report.cached ? '上次检查 API 费用' : '本次 API 费用'}：$${report.usage.cost}`);
  return `${lines.join('\n')}\n`;
}

export function reportExitCode(report) {
  if (report.stale) return 2;
  if (report.findings.length) return 1;
  return report.semantic === 'incomplete' ? 2 : 0;
}
