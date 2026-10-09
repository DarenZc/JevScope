import { icon, escapeHtml as e } from './icons.js';

export const relationLabels = { explicit: '直接需求', necessary: '必要改动', extra: '疑似额外', uncertain: '需核对', attention: '需关注', pending: '待检查', skipped: '未送审' };
export const isAttention = f => ['extra', 'attention', 'uncertain', 'skipped'].includes(f.relation);
export const isCovered = f => ['explicit', 'necessary'].includes(f.relation);
export const modeLabels = { end: '结束时检查', live: '修改前检查', manual: '仅手动检查' };
export const date = (value, timeOnly = false) => value ? new Intl.DateTimeFormat('zh-CN', timeOnly
  ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
  : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '尚未检查';

function badge(relation) {
  const color = isCovered({ relation }) ? 'green' : isAttention({ relation }) ? 'amber' : 'neutral';
  return `<span class="badge ${color}">${icon(isCovered({ relation }) ? 'check' : isAttention({ relation }) ? 'alert' : 'clock')}${relationLabels[relation] ?? '等待检查'}</span>`;
}
function empty(title, detail, symbol = 'folder', action = '') {
  return `<div class="empty-state">${icon(symbol)}<strong>${title}</strong>${detail ? `<p>${detail}</p>` : ''}${action}</div>`;
}
function findingLocation(finding) {
  const location = finding.evidence?.location;
  return location?.line ? `${finding.file}:${location.line}${location.side === 'old' ? '（原文件）' : ''}`
    : location ? `${finding.file}（补丁片段 ${location.hunk}）` : finding.file;
}
export function sidebarTask(task) {
  if (!task) return `<div class="sidebar-empty"><span>暂无任务</span><button class="text-button" data-action="task">新建</button></div>`;
  return `<button class="task-summary" data-view="requirements" aria-label="查看当前任务需求"><span class="task-state"><span class="small-dot ${task.active ? '' : 'inactive'}"></span>${task.active ? '进行中' : '已结束'}<span class="mono">v${task.revision}</span></span><span class="task-name">${e(task.requirements[0]?.text ?? '暂无需求')}</span><span class="task-summary-meta">${task.requirements.length} 需求 · ${task.constraints.length} 约束${icon('arrow')}</span></button>
    ${task.requirements.length > 1 ? `<div class="sidebar-heading">补充需求</div>${task.requirements.slice(1, 4).map(r => `<button class="sidebar-boundary" data-view="requirements"><span class="id-tag">${e(r.id)}</span><span>${e(r.text)}</span></button>`).join('')}${task.requirements.length > 4 ? `<button class="text-button sidebar-more" data-view="requirements">全部 ${task.requirements.length} 项</button>` : ''}` : ''}
    ${task.constraints.length ? `<div class="sidebar-heading">约束</div>${task.constraints.slice(0, 3).map(r => `<button class="sidebar-boundary" data-view="requirements"><span class="id-tag constraint">${e(r.id)}</span><span>${e(r.text)}</span></button>`).join('')}${task.constraints.length > 3 ? `<button class="text-button sidebar-more" data-view="requirements">全部 ${task.constraints.length} 项</button>` : ''}` : ''}`;
}

export function fileRows(files, selected) {
  return files.map(f => {
    const parts = f.file.split('/'), name = parts.pop(), dir = parts.join('/');
    const ext = name.split('.').pop();
    return `<tr class="${f.file === selected ? 'selected' : ''}"><td class="file-cell"><button class="file-open" data-file="${e(f.file)}" aria-label="查看 ${e(f.file)}"><span class="file-glyph ${['js', 'css', 'html', 'md'].includes(ext) ? ext : ''}">${icon(ext === 'js' || ext === 'css' ? 'code' : 'file')}</span><span class="file-name" title="${e(f.file)}">${e(name)}<span class="file-dir">${e(dir || '/')}</span></span></button></td>
      <td><div class="diff-count"><span class="added">+${f.additions}</span><span class="removed">−${f.deletions}</span></div></td><td>${badge(f.relation)}</td><td class="basis-column">${f.requirementId ? `<span class="id-tag">${e(f.requirementId)}</span>` : '<span class="muted">—</span>'}</td><td class="row-arrow">${icon('chevron')}</td></tr>`;
  }).join('');
}

function table(files, selected, emptyText = '没有匹配的文件') {
  return `<div class="file-table-wrap"><table class="file-table" aria-label="文件改动"><thead><tr><th>文件</th><th class="diff-column">变动</th><th class="status-column">状态</th><th class="basis-column">依据</th><th class="arrow-column" aria-label="详情"></th></tr></thead><tbody id="file-rows">${files.length ? fileRows(files, selected) : `<tr><td colspan="5">${empty(emptyText, '', 'folder')}</td></tr>`}</tbody></table></div>`;
}

export function overview(data, ui) {
  const files = data.files, covered = files.filter(isCovered).length, attention = files.filter(isAttention).length;
  return `<section class="changes-view" aria-label="文件改动">
    <div class="table-tools"><div class="segmented" aria-label="筛选文件"><button data-filter="all" class="${ui.filter === 'all' ? 'active' : ''}" aria-pressed="${ui.filter === 'all'}">全部 <span>${files.length}</span></button><button data-filter="attention" class="${ui.filter === 'attention' ? 'active' : ''}" aria-pressed="${ui.filter === 'attention'}">需关注 <span>${attention}</span></button></div><label class="search-box">${icon('search')}<input type="search" id="file-search" placeholder="搜索文件" aria-label="搜索文件" value="${e(ui.query)}" autocomplete="off"></label></div>
    ${table(filteredFiles(data, ui), ui.selected, files.length ? '没有匹配的文件' : '暂无改动')}
    <div class="table-foot"><span>范围内 ${covered}<span class="summary-separator">·</span>待检查 ${files.length - covered - attention}</span><span id="filtered-count" ${ui.query || ui.filter !== 'all' ? '' : 'hidden'}>${filteredFiles(data, ui).length} / ${files.length}</span></div></section>`;
}
export function filteredFiles(data, ui) {
  return data.files.filter(f => (ui.filter !== 'attention' || isAttention(f)) && f.file.toLowerCase().includes(ui.query.toLowerCase()));
}
export function filterTable(data, ui) {
  const files = filteredFiles(data, ui);
  document.querySelector('#file-rows').innerHTML = files.length ? fileRows(files, ui.selected) : `<tr><td colspan="5">${empty('没有匹配的文件', '', 'search')}</td></tr>`;
  document.querySelector('#filtered-count').textContent = `${files.length} / ${data.files.length}`;
  document.querySelector('#filtered-count').hidden = !ui.query && ui.filter === 'all';
  document.querySelectorAll('[data-filter]').forEach(b => { b.classList.toggle('active', b.dataset.filter === ui.filter); b.setAttribute('aria-pressed', String(b.dataset.filter === ui.filter)); });
}

export function requirements(data) {
  const task = data.task;
  if (!task) return empty('暂无任务', '', 'scope', '<button class="button" data-action="task">新建任务</button>');
  const rows = (items, constraint = false) => items.map(item => `<div class="requirement-row"><span class="id-tag ${constraint ? 'constraint' : ''}">${e(item.id)}</span><div><h3>${e(item.text)}</h3></div></div>`).join('');
  return `<div class="requirements-intro"><span>v${task.revision}${task.active ? '' : ' · 已结束'}</span><button class="button" data-action="task">${icon('plus')}${task.active ? '补充需求' : '新建任务'}</button></div>
    <h2 class="subheading">需求 <span class="muted">${task.requirements.length}</span></h2><div class="requirement-block">${rows(task.requirements)}</div>
    <h2 class="subheading">约束 <span class="muted">${task.constraints.length}</span></h2>${task.constraints.length ? `<div class="requirement-block">${rows(task.constraints, true)}</div>` : ''}
    ${(task.allowedPaths.length || task.noDependencies) ? `<h2 class="subheading">显式边界</h2><div class="requirement-block"><div class="requirement-row"><div>${task.allowedPaths.map(p => `<p class="mono">${e(p)}</p>`).join('')}${task.noDependencies ? '<p>禁止新增 npm 依赖</p>' : ''}</div></div></div>` : ''}
    ${task.retired?.length ? `<details class="history-details"><summary>已撤销的要求 · ${task.retired.length}</summary>${task.retired.map(r => `<div class="requirement-row retired"><span class="id-tag">${e(r.id)}</span><div><h3>${e(r.text)}</h3><p>版本 ${r.retiredRevision} 撤销</p></div></div>`).join('')}</details>` : ''}`;
}

export function reportView(data, ui) {
  const r = data.report;
  if (!r) return `<section class="report-summary">${icon('report')}<div><h2>${data.running ? '检查中' : '暂无报告'}</h2></div></section>`;
  const warning = r.stale || r.semantic === 'incomplete' || r.findings.length;
  const title = r.stale ? '报告已过期' : r.semantic === 'incomplete' ? '检查未完成' : r.findings.length ? `${new Set(r.findings.map(f => f.file)).size} 个文件需关注` : r.semantic === 'not-needed' ? '暂无改动' : '未发现范围偏离';
  const description = r.stale ? '需求或文件已更新' : r.notice || '';
  return `<section class="report-summary ${warning ? 'amber' : ''}">${icon(warning ? 'info' : 'shield')}<div><h2>${title}</h2>${description ? `<p>${e(description)}</p>` : ''}<details class="report-metadata"><summary>${date(r.checkedAt)}</summary><div class="report-meta"><span>v${r.revision}</span><span>${r.files.length} 文件</span>${r.model ? `<span>${e(r.model)}</span>` : ''}${Number.isFinite(r.usage?.cost) ? `<span>$${r.usage.cost.toFixed(6)}</span>` : ''}</div></details></div></section>
    ${r.findings.length ? `<h2 class="subheading">需要关注</h2><ul class="report-findings">${r.findings.map(f => `<li><strong>${e(findingLocation(f))}</strong>${e(f.reason)}</li>`).join('')}</ul>` : ''}
    ${r.skipped.length ? `<details class="history-details"><summary>未送审 · ${r.skipped.length} 个文件</summary><ul class="report-findings">${r.skipped.map(f => `<li><strong>${e(f.file)}</strong>${e(f.reason)}</li>`).join('')}</ul></details>` : ''}
    <div class="section-heading"><h2>文件状态</h2></div>${table(data.files, ui.selected, '暂无改动')}`;
}

export function details(data, ui) {
  const task = data.task, file = data.files.find(f => f.file === ui.selected);
  const heading = `<div class="detail-heading"><span>${file ? '文件详情' : '任务详情'}</span><button class="icon-button" data-action="close-details" aria-label="关闭详情面板">${icon('close')}</button></div>`;
  if (file) {
    const requirement = task?.requirements.find(r => r.id === file.requirementId);
    return `${heading}<h3>${e(file.file.split('/').pop())}</h3><div class="detail-file-path">${e(file.file)}</div><div class="file-detail-status">${badge(file.relation)}<span class="tag">${({ A: '新增', M: '修改', D: '删除', T: '类型变化' })[file.operation] ?? e(file.operation)}</span></div><hr class="detail-divider"><h4 class="detail-section-title">需求依据</h4>${requirement ? `<div class="boundary-item"><span class="id-tag">${e(requirement.id)}</span><span>${e(requirement.text)}</span></div>` : '<p class="detail-description">—</p>'}
      ${file.findings.length ? `<ul class="detail-findings">${file.findings.map(f => `<li>${f.evidence ? `<span class="detail-file-path">${e(findingLocation(f))}</span><br>` : ''}${e(f.reason)}</li>`).join('')}</ul>` : ''}
      <hr class="detail-divider"><dl class="detail-list"><dt>新增行</dt><dd class="added">+${file.additions}</dd><dt>删除行</dt><dd class="removed">−${file.deletions}</dd></dl>
      ${file.diff ? `<details class="patch-details" ${ui.patchOpen ? 'open' : ''}><summary>查看代码改动</summary><pre class="patch">${file.diff.split('\n').map(line => `<span class="patch-line ${line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : line.startsWith('@@') ? 'hunk' : ''}">${e(line)}</span>`).join('')}</pre></details>` : ''}
      ${file.diffNotice ? `<div class="detail-note">${icon('info')}<span>${e(file.diffNotice)}</span></div>` : ''}<button class="text-button panel-link" data-action="clear-selection">${icon('scope')}返回任务详情</button>`;
  }
  if (!task) return `${heading}<p class="detail-description">暂无任务</p>`;
  const boundaries = [...task.requirements, ...task.constraints];
  const mode = task.reviewMode ?? 'end';
  return `${heading}<h4 class="detail-section-title">边界 <span>${boundaries.length}</span></h4>${boundaries.slice(0, 4).map(r => `<div class="boundary-item"><span class="id-tag ${r.id.startsWith('C') ? 'constraint' : ''}">${e(r.id)}</span><span>${e(r.text)}</span></div>`).join('')}${boundaries.length > 4 ? `<button class="text-button" data-view="requirements">全部 ${boundaries.length} 项</button>` : ''}<hr class="detail-divider"><dl class="detail-list"><dt>检查方式</dt><dd>${modeLabels[mode]}</dd><dt>任务模式</dt><dd>${task.mode === 'review' ? '只读' : '允许修改'}</dd><dt>上次检查</dt><dd>${date(data.report?.checkedAt)}</dd><dt>版本</dt><dd class="mono">v${task.revision}</dd></dl>`;
}
