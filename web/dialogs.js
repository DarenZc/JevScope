import { icon, escapeHtml as e } from './icons.js';

export function openDialog(kind, { data, ui, post, notify, setLayout }) {
  const dialog = document.querySelector('#dialog'), content = document.querySelector('#dialog-content');
  const active = data.task?.active;
  const header = title => `<div class="dialog-header"><h2>${title}</h2><button type="button" class="icon-button" data-dismiss aria-label="关闭对话框">${icon('close')}</button></div>`;
  const actions = label => `<p class="dialog-error" id="dialog-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="button" data-dismiss>取消</button><button type="submit" class="button primary">${label}</button></div>`;
  if (kind === 'task') {
    content.innerHTML = `<form id="dialog-form">${header(active ? '补充需求' : '新建任务')}<label class="dialog-field sr-only" for="requirement-text">需求原话</label><textarea id="requirement-text" name="text" required maxlength="4000" placeholder="需求内容" autofocus></textarea>${actions(active ? '保存需求' : '开始任务')}</form>`;
  } else if (kind === 'check') {
    content.innerHTML = `<form id="dialog-form">${header('运行检查')}<label class="check-choice"><input type="radio" name="check-mode" value="online" ${data.apiConfigured ? 'checked' : 'disabled'}><span><strong>完整检查</strong><p>${data.apiConfigured ? '发送需求与差异至 OpenRouter，使用 API 余额。' : '未配置 API 密钥。'}</p></span></label><label class="check-choice"><input type="radio" name="check-mode" value="offline" ${data.apiConfigured ? '' : 'checked'}><span><strong>本地规则</strong><p>离线，不含语义检查。</p></span></label>${actions('开始检查')}</form>`;
  } else {
    content.innerHTML = `<form id="dialog-form">${header('设置')}<label class="settings-row"><strong>侧边栏</strong><input type="checkbox" id="setting-sidebar" ${ui.sidebar ? 'checked' : ''}></label><label class="settings-row"><strong>详情</strong><input type="checkbox" id="setting-details" ${ui.details ? 'checked' : ''}></label><label class="settings-row"><strong>活动</strong><input type="checkbox" id="setting-bottom" ${ui.bottom ? 'checked' : ''}></label><label class="settings-row"><strong>检查方式</strong><select id="setting-mode" ${active ? '' : 'disabled'}><option value="end" ${(data.task?.reviewMode ?? 'end') === 'end' ? 'selected' : ''}>结束时检查</option><option value="manual" ${data.task?.reviewMode === 'manual' ? 'selected' : ''}>仅手动检查</option>${data.task?.reviewMode === 'live' ? '<option value="live" selected>修改前检查</option>' : ''}</select></label><details class="history-details"><summary>项目路径</summary><p class="settings-footnote">${e(data.workspace.root)}</p></details>${actions('完成')}</form>`;
  }
  content.querySelectorAll('[data-dismiss]').forEach(button => button.addEventListener('click', () => dialog.close()));
  for (const name of ['sidebar', 'details', 'bottom']) content.querySelector(`#setting-${name}`)?.addEventListener('change', event => setLayout(name, event.target.checked));
  const form = content.querySelector('form');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('[type=submit]'), error = content.querySelector('#dialog-error');
    error.hidden = true;
    submit.disabled = true;
    const original = submit.textContent;
    submit.textContent = kind === 'check' ? '正在检查…' : '正在保存…';
    try {
      if (kind === 'task') {
        await post('/api/task', { text: form.elements.text.value.trim() }, data);
        notify(active ? '需求已补充，任务基线已保留。' : '新任务已建立。');
      } else if (kind === 'check') {
        const result = await post('/api/check', { offline: form.elements['check-mode'].value === 'offline', confirmed: true }, data);
        notify(result.report?.stale ? '文件或需求已变化，请重新检查。' : result.report?.semantic === 'incomplete' ? '检查已结束，查看报告了解未完成项。' : '检查完成，报告已更新。');
      } else {
        const mode = content.querySelector('#setting-mode').value;
        if (active && mode !== (data.task.reviewMode ?? 'end')) await post('/api/review-mode', { reviewMode: mode }, data);
        notify('工作台设置已保存。');
      }
      dialog.close();
    } catch (cause) {
      error.textContent = cause.message;
      error.hidden = false;
    } finally { submit.disabled = false; submit.textContent = original; }
  });
  dialog.showModal();
}
