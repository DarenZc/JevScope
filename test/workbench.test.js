import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { get } from 'node:http';
import { git } from '../src/repo.js';
import { startTask, amendTask, activeTask } from '../src/task.js';
import { startWorkbench } from '../src/workbench.js';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'jev-workbench-'));
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(dir, 'app.js'), 'const value = 1;\n');
  await git(dir, ['add', 'app.js']);
  const app = await startWorkbench({ cwd: dir, port: 0, ...options });
  t.after(async () => {
    await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); });
    await rm(dir, { recursive: true, force: true });
  });
  app.get = async () => (await fetch(`${app.url}/api/state?refresh=1`)).json();
  app.post = (route, state, body, headers = {}) => fetch(`${app.url}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jev-Token': state.token, ...headers },
    body: JSON.stringify({ taskId: state.task?.id ?? null, revision: state.task?.revision ?? null, ...body }),
  });
  return app;
}

test('workbench serves an honest empty state and only allowlisted frontend assets', async t => {
  const app = await fixture(t);
  const state = await app.get();
  assert.equal(state.task, null);
  assert.equal(state.report, null);
  assert.deepEqual(state.files, []);
  assert.equal(app.server.address().address, '127.0.0.1');
  const page = await fetch(app.url);
  assert.match(await page.text(), /范围总览/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const url of ['/styles.css', '/layout.css', '/readability.css', '/app.js', '/views.js', '/icons.js', '/dialogs.js', '/favicon.svg']) {
    assert.equal((await fetch(app.url + url)).status, 200, url);
  }
  for (const url of ['/.env', '/package.json', '/.git/config', '/src/workbench.js', '/%2e%2e/.env']) {
    assert.equal((await fetch(app.url + url)).status, 404, url);
  }
});

test('state shows baseline changes without altering staged files or exposing sensitive patches', async t => {
  const app = await fixture(t);
  const before = await git(app.repo.root, ['diff', '--cached']);
  await startTask(app.repo, '修改数值');
  await writeFile(path.join(app.repo.root, 'app.js'), 'const value = 2;\n');
  await writeFile(path.join(app.repo.root, '.env.local'), 'PRIVATE=not-for-the-browser');
  await writeFile(path.join(app.repo.root, 'sensitive.js'), 'const api_key = "fixture-secret-value-long-enough";\n');
  const state = await app.get();
  assert.deepEqual(state.files.map(f => f.file), ['app.js', 'sensitive.js']);
  const f = state.files[0];
  assert.equal(f.additions, 1);
  assert.equal(f.deletions, 1);
  assert.equal(f.relation, 'pending');
  assert.match(f.diff, /\+const value = 2/);
  assert.equal(state.files[1].diff, null);
  assert.equal(state.files[1].relation, 'pending');
  assert.doesNotMatch(JSON.stringify(state), /fixture-secret-value-long-enough|not-for-the-browser/);
  assert.equal(await git(app.repo.root, ['diff', '--cached']), before);
});

test('fresh report classifications become pending when file contents or requirements change', async t => {
  const app = await fixture(t, { checkOptions: { judgeImpl: async (_task, changes) => ({
    model: 'local-fixture', usage: {}, judgments: changes.map(f => ({
      id: f.id, file: f.file, relation: 'explicit', requirementId: 'R1', confidence: 1, conflictId: null,
    })),
  }) } });
  await startTask(app.repo, '修改数值');
  await writeFile(path.join(app.repo.root, 'app.js'), 'const value = 2;\n');
  let state = await app.get();
  let response = await app.post('/api/check', state, { offline: false, confirmed: true });
  assert.equal(response.status, 200);
  state = await response.json();
  assert.equal(state.report.stale, false);
  assert.equal(state.files[0].relation, 'explicit');
  await writeFile(path.join(app.repo.root, 'app.js'), 'const value = 3;\n');
  state = await app.get();
  assert.equal(state.report.stale, true);
  assert.equal(state.files[0].relation, 'pending');
  assert.equal(state.files[0].requirementId, null);
  response = await app.post('/api/check', state, { offline: false, confirmed: true });
  assert.equal(response.status, 200);
  await amendTask(app.repo, '同时保留注释');
  state = await app.get();
  assert.equal(state.report.stale, true);
  assert.equal(state.files[0].relation, 'pending');
});

test('browser mutations require local origin, a session token and the current task revision', async t => {
  const app = await fixture(t);
  let state = await app.get();
  const response = await app.post('/api/task', state, { text: '增加界面' });
  assert.equal(response.status, 200);
  state = await response.json();
  const baseline = state.task.baseline;
  assert.equal((await app.post('/api/task', state, { text: '恶意补充' }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await app.post('/api/task', state, { text: '缺少令牌' }, { 'X-Jev-Token': '' })).status, 403);
  assert.equal((await fetch(app.url + '/api/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  // Node fetch normalizes Host; use an actual raw HTTP header for this boundary check.
  const hostStatus = await new Promise((resolve, reject) => {
    get(app.url + '/api/state', { headers: { Host: 'other.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await app.post('/api/task', state, { text: '支持搜索' })).status, 200);
  assert.equal((await app.post('/api/task', state, { text: '旧版本提交' })).status, 409);
  state = await app.get();
  assert.equal(state.task.requirements.length, 2);
  const paused = await app.post('/api/review-mode', state, { reviewMode: 'manual' });
  assert.equal(paused.status, 200);
  const task = await activeTask(app.repo);
  assert.equal(task.reviewMode, 'manual');
  assert.equal(task.baseline, baseline);
  assert.equal(task.revision, 3);
});

test('offline checks never invoke the model and incomplete results do not imply approval', async t => {
  let calls = 0;
  const app = await fixture(t, { checkOptions: { judgeImpl: async () => { calls += 1; throw new Error('Should not be called'); } } });
  await startTask(app.repo, '增加界面');
  await writeFile(path.join(app.repo.root, 'app.js'), 'const value = 2;\n');
  const state = await app.get();
  assert.equal((await app.post('/api/check', state, { offline: false })).status, 400);
  const response = await app.post('/api/check', state, { offline: true });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(calls, 0);
  assert.equal(result.report.semantic, 'incomplete');
  assert.equal(result.files[0].relation, 'pending');
  assert.match(result.report.notice, /离线模式/);
  assert.equal(await readFile(path.join(app.repo.root, 'app.js'), 'utf8'), 'const value = 2;\n');
});
