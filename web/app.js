import { icon, escapeHtml as e } from './icons.js';
import { overview, requirements, reportView, details, sidebarTask, filterTable, date, isAttention, modeLabels } from './views.js';
import { openDialog } from './dialogs.js';

const $ = selector => document.querySelector(selector);
const pages = {
  overview: '范围总览',
  report: '检查报告',
  requirements: '需求与约束',
};
let stored = {};
try { stored = JSON.parse(localStorage.getItem('jev-layout') ?? '{}'); } catch { /* Layout is optional. */ }
const ui = {
  view: Object.hasOwn(pages, location.hash.slice(1)) ? location.hash.slice(1) : 'overview',
  sidebar: innerWidth > 800 && (stored.sidebar ?? true), details: false,
  bottom: stored.bottom ?? false, query: '', filter: 'all', selected: null, patchOpen: false,
};
let data, signature, pending = false, requestId = 0;
const log = [];

document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
function logEvent(message) {
  log.unshift({ at: new Date().toISOString(), message });
  if (log.length > 30) log.pop();
  $('#activity-log').innerHTML = log.map(item => `<div class="log-row"><time>${date(item.at, true)}</time><span>${e(item.message)}</span></div>`).join('');
}
function notify(message) {
  logEvent(message);
}
function applyLayout() {
  $('#app').classList.toggle('sidebar-hidden', !ui.sidebar);
  $('#app').classList.toggle('details-hidden', !ui.details);
  $('#sidebar').classList.toggle('manually-open', ui.sidebar);
  $('#details-panel').classList.toggle('manually-open', ui.details);
  $('#bottom-panel').hidden = !ui.bottom;
  for (const name of ['sidebar', 'details', 'bottom']) $(`#toggle-${name}`).setAttribute('aria-expanded', String(ui[name]));
}
function setLayout(name, value) {
  ui[name] = value;
  stored[name] = value;
  applyLayout();
  try { localStorage.setItem('jev-layout', JSON.stringify(stored)); } catch { /* Private mode may disable storage. */ }
}
function selectView(view, updateHash = true) {
  if (!Object.hasOwn(pages, view)) return;
  ui.view = view;
  if (updateHash && location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  document.querySelectorAll('[data-view]').forEach(button => {
    const selected = button.dataset.view === view;
    button.classList.toggle('active', selected);
    if (button.getAttribute('role') === 'tab') { button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; }
    else if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  $('#page-title').textContent = pages[view];
  $('#view-content').setAttribute('aria-labelledby', `tab-${view}`);
  if (data) renderView();
  $('.page-body').scrollTop = 0;
}
function renderView() {
  $('#view-content').dataset.page = ui.view;
  $('#sidebar-content').innerHTML = sidebarTask(data.task);
  $('#view-content').innerHTML = (ui.view === 'overview' ? overview : ui.view === 'report' ? reportView : requirements)(data, ui);
  renderDetails();
}
function renderDetails() {
  $('#details-panel').innerHTML = details(data, ui);
  $('.patch-details')?.addEventListener('toggle', event => { ui.patchOpen = event.target.open; });
}
function setBusy() {
  const busy = pending || data?.running;
  $('#run-check').disabled = !data?.task?.active || busy;
  $('#run-check').classList.toggle('loading', Boolean(busy));
  $('#run-check').innerHTML = `${icon(busy ? 'refresh' : 'play')}<span>${busy ? '检查中…' : '运行检查'}</span>`;
  $('#refresh').disabled = pending;
}
function acceptData(next) {
  data = next;
  const nextSignature = JSON.stringify([data.task, data.report, data.files, data.running]);
  $('#project-name').textContent = data.workspace.name;
  $('#breadcrumb-project').textContent = data.workspace.name;
  $('#report-count').textContent = String(data.files.filter(isAttention).length);
  $('#report-count').hidden = !data.files.some(isAttention);
  $('#status-branch').innerHTML = `${icon('branch')}${e(data.workspace.branch)}`;
  $('#last-sync').textContent = `${date(data.updatedAt, true)} 已同步`;
  const mode = data.task?.reviewMode ?? 'end';
  $('#review-mode-label').textContent = mode === 'end' ? '结束时检查' : modeLabels[mode];
  $('#connection').title = '已连接';
  $('#connection').setAttribute('aria-label', '已连接');
  $('#connection').classList.remove('offline');
  $('#error-banner').hidden = true;
  if (ui.selected && !data.files.some(f => f.file === ui.selected)) ui.selected = null;
  if (nextSignature !== signature) { signature = nextSignature; renderView(); }
  setBusy();
}
function showError(error) {
  $('#error-banner').textContent = error.message;
  $('#error-banner').hidden = false;
  $('#connection').title = '连接异常';
  $('#connection').setAttribute('aria-label', '连接异常');
  $('#connection').classList.add('offline');
  if (!data) $('#view-content').innerHTML = '';
}
async function readResponse(response) {
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '工作台请求失败。');
  return result;
}
async function refresh(force = false) {
  if (pending) return;
  const id = ++requestId;
  if (force) $('#refresh').classList.add('loading');
  try {
    const next = await readResponse(await fetch(`/api/state${force ? '?refresh=1' : ''}`, { signal: AbortSignal.timeout(30000) }));
    if (id !== requestId) return;
    const first = !data;
    acceptData(next);
    if (first) logEvent(`已连接工作区 ${next.workspace.name}。`);
  } catch (error) {
    if (id === requestId) showError(error.name === 'TypeError' ? new Error('本地服务未连接。') : error);
  } finally { $('#refresh').classList.remove('loading'); }
}
async function post(url, body, expected) {
  pending = true;
  const id = ++requestId;
  setBusy();
  if (url === '/api/check') logEvent(body.offline ? '开始检查本地边界规则。' : '开始完整范围检查。');
  try {
    const next = await readResponse(await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jev-Token': expected.token },
      body: JSON.stringify({ ...body, taskId: expected.task?.id ?? null, revision: expected.task?.revision ?? null }),
    }));
    if (id === requestId) acceptData(next);
    if (url === '/api/check') selectView('report');
    return next;
  } finally { pending = false; setBusy(); }
}
function dialog(kind) {
  if (!data) { notify('请先连接本地工作区。'); return; }
  if (pending) return;
  openDialog(kind, { data, ui, post, notify, setLayout });
}

document.addEventListener('click', event => {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) { selectView(viewButton.dataset.view); if (innerWidth <= 800) setLayout('sidebar', false); return; }
  const fileButton = event.target.closest('[data-file]');
  if (fileButton) {
    ui.selected = fileButton.dataset.file;
    ui.patchOpen = false;
    setLayout('details', true);
    document.querySelectorAll('.file-table tr').forEach(row => row.classList.toggle('selected', row.querySelector('[data-file]')?.dataset.file === ui.selected));
    renderDetails();
    return;
  }
  const filter = event.target.closest('[data-filter]');
  if (filter) { ui.filter = filter.dataset.filter; filterTable(data, ui); return; }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'task') dialog('task');
  if (action === 'close-details') setLayout('details', false);
  if (action === 'clear-selection') { ui.selected = null; renderDetails(); document.querySelectorAll('.file-table tr.selected').forEach(row => row.classList.remove('selected')); }
});
document.addEventListener('input', event => { if (event.target.id === 'file-search') { ui.query = event.target.value; filterTable(data, ui); } });
for (const name of ['sidebar', 'details', 'bottom']) $(`#toggle-${name}`).addEventListener('click', () => setLayout(name, !ui[name]));
$('#close-bottom').addEventListener('click', () => setLayout('bottom', false));
$('#refresh').addEventListener('click', () => refresh(true));
$('#run-check').addEventListener('click', () => dialog('check'));
for (const selector of ['#settings-button', '#review-settings']) $(selector).addEventListener('click', () => dialog('settings'));
document.querySelector('.editor-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const views = Object.keys(pages), index = views.indexOf(ui.view);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
  event.preventDefault();
  selectView(views[next]);
  $(`#tab-${views[next]}`).focus();
});
document.addEventListener('keydown', event => {
  if ($('#dialog').open || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  if ((event.ctrlKey || event.metaKey) && ['b', 'j'].includes(event.key.toLowerCase())) {
    event.preventDefault();
    const name = event.key.toLowerCase() === 'b' ? 'sidebar' : 'bottom';
    setLayout(name, !ui[name]);
  }
  if (event.key === 'Escape' && innerWidth <= 1120) { setLayout('details', false); if (innerWidth <= 800) setLayout('sidebar', false); }
});
addEventListener('hashchange', () => selectView(location.hash.slice(1), false));
for (const [name, width] of [['sidebar', 800], ['details', 1120]]) {
  matchMedia(`(max-width: ${width}px)`).addEventListener('change', event => {
    ui[name] = !event.matches && (stored[name] ?? name === 'sidebar');
    applyLayout();
  });
}
applyLayout();
selectView(ui.view, false);
setBusy();
await refresh();
setInterval(() => { if (!document.hidden && !$('#dialog').open && !pending) refresh(); }, 10000);
