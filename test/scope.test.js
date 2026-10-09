import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { git, repository, snapshot, changesBetween, patchChanges } from '../src/repo.js';
import { startTask, amendTask, activeTask, readState, writeState } from '../src/task.js';
import { checkRepository, reviewChanges, dependencyAdditions } from '../src/review.js';
import { judge, buildRequest } from '../src/jev.js';
import { runHook, hookConfiguration } from '../src/hooks.js';
import { renderNotice, renderReport, reportExitCode } from '../src/report.js';
import { splitDiff, planReview, REVIEW_VERSION } from '../src/review-plan.js';

const CLI = fileURLToPath(new URL('../bin/scope.js', import.meta.url));

async function fixture(t, files = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'jev-scope-test-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'core.autocrlf', 'false']);
  for (const [name, text] of Object.entries(files)) await put(dir, name, text);
  return repository(dir);
}

async function put(dir, file, text) {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), text);
}

async function commit(repo) {
  await git(repo.root, ['add', '-A']);
  await git(repo.root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture', '--no-gpg-sign']);
}

function mockJudge(relation = 'explicit') {
  return async (_task, changes) => ({
    model: 'fixture/mock', usage: {}, judgments: changes.map(item => ({
      id: item.id, file: item.file, relation, requirementId: relation === 'extra' ? null : 'R1',
      confidence: 0.9, conflictId: null,
      evidenceId: item.evidenceCandidates?.[0]?.id, scopeReason: 'independent',
    })),
  });
}

function change(file = 'src/login.js', diff = '-const timeout = 1;\n+const timeout = 10;') {
  return { id: 'F1', file, operation: 'M', diff };
}

function apiAnswers(request, overrides = {}) {
  return {
    model: 'typesafe/jev-1.13-test', usage: { input_tokens: 400, output_tokens: 20, cost: 0.00002 },
    answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
      const unit = id.replace(/_(relation|basis|conflict|extra_kind|evidence|scope_reason)$/, '');
      const flagged = overrides[`${unit}_relation`] === 'extra' || /^C\d+$/.test(overrides[`${unit}_conflict`] ?? '');
      const evidence = request.state.changes[unit]?.evidenceCandidates ?? [];
      const label = overrides[`${unit}_extra_kind`];
      const selected = overrides[id] ?? (id.endsWith('_relation') ? 'explicit' : id.endsWith('_basis') ? 'R1'
        : id.endsWith('_evidence') && flagged ? (evidence.find(item => item.kind === label) ?? evidence[0])?.id ?? 'none'
        : id.endsWith('_scope_reason') && flagged ? (overrides[`${unit}_conflict`] ? 'constraint' : 'independent') : 'none');
      const keys = Object.keys(q.criteria);
      return [id, { type: 'choice', choice: selected, confidence: 0.9,
        probabilities: Object.fromEntries(keys.map(key => [key, keys.length === 1 ? 1 : key === selected ? 0.9 : 0.1 / (keys.length - 1)])) }];
    })),
  };
}

async function localAPI(t, handler) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    await handler(req, res, body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/api/v1/systemone`;
}

function cli(cwd, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd, env: { ...process.env, OPENROUTER_API_KEY: '' }, windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('baseline preserves pre-existing staged, unstaged and untracked work; captures later edits', async t => {
  const repo = await fixture(t, { 'login.js': 'old\n', 'notes.txt': 'initial\n' });
  await commit(repo);
  await put(repo.root, 'login.js', 'staged\n');
  await git(repo.root, ['add', 'login.js']);
  await put(repo.root, 'login.js', 'user unstaged\n');
  await put(repo.root, 'user draft.txt', 'user draft\n');
  const indexBefore = await git(repo.root, ['diff', '--cached']);
  const task = await startTask(repo, '修复登录超时');
  let report = await checkRepository(repo, { offline: true });
  assert.equal(report.files.length, 0);
  assert.equal(reportExitCode(report), 0);
  await put(repo.root, 'login.js', 'user unstaged\nagent fix\n');
  report = await checkRepository(repo, { judgeImpl: mockJudge() });
  assert.deepEqual(report.files.map(f => f.file), ['login.js']);
  const changes = await changesBetween(repo, task.baseline, await snapshot(repo));
  assert.match(changes[0].diff, /\+agent fix/);
  assert.doesNotMatch(changes[0].diff, /\+user unstaged/);
  assert.equal(await git(repo.root, ['diff', '--cached']), indexBefore);
  assert.equal(await readFile(path.join(repo.root, 'user draft.txt'), 'utf8'), 'user draft\n');
});

test('snapshot detects same-size edits made within a Git index timestamp tick', async t => {
  const repo = await fixture(t, { 'app.js': 'const value = 1;\n' });
  await git(repo.root, ['config', 'core.trustctime', 'false']);
  await git(repo.root, ['config', 'core.checkstat', 'minimal']);
  const file = path.join(repo.root, 'app.js');
  const tick = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
  await utimes(file, tick, tick);
  await git(repo.root, ['add', 'app.js']);
  const index = path.resolve(repo.root, (await git(repo.root, ['rev-parse', '--git-path', 'index'])).trim());
  await utimes(index, tick, tick);
  const indexBefore = await readFile(index);
  const timestampBefore = (await stat(index)).mtimeMs;
  const before = await snapshot(repo);
  await writeFile(file, 'const value = 2;\n');
  await utimes(file, tick, tick);
  const changes = await changesBetween(repo, before, await snapshot(repo));
  assert.equal(changes.length, 1);
  assert.match(changes[0].diff, /\+const value = 2/);
  assert.deepEqual(await readFile(index), indexBefore);
  assert.equal((await stat(index)).mtimeMs, timestampBefore);
});

test('empty unborn repo can establish a task and detect a newly staged file', async t => {
  const repo = await fixture(t);
  await startTask(repo, '增加一个模块');
  await put(repo.root, 'new.js', 'export const x = 1;\n');
  await git(repo.root, ['add', 'new.js']);
  const report = await checkRepository(repo, { offline: true });
  assert.deepEqual(report.files.map(f => f.file), ['new.js']);
  assert.equal(reportExitCode(report), 2);
});

test('new, deleted and renamed paths with spaces and Chinese are all represented', async t => {
  const repo = await fixture(t, { 'old file.js': 'old\n', 'delete.js': 'delete\n' });
  await startTask(repo, '修改模块');
  await rename(path.join(repo.root, 'old file.js'), path.join(repo.root, '新的文件.js'));
  await rm(path.join(repo.root, 'delete.js'));
  await put(repo.root, 'new file.js', 'new\n');
  const report = await checkRepository(repo, { offline: true });
  assert.deepEqual(new Set(report.files.map(f => f.file)), new Set(['old file.js', 'delete.js', '新的文件.js', 'new file.js']));
});

test('amend preserves baseline and records actual user source; an active task cannot be replaced', async t => {
  const repo = await fixture(t, { 'app.js': 'original\n' });
  const task = await startTask(repo, '增加 CSV 导出', { constraints: ['不增加后台服务'] });
  await put(repo.root, 'app.js', 'changed\n');
  await assert.rejects(startTask(repo, '覆盖任务'), /已有活动任务/);
  const amended = await amendTask(repo, '同时需要最近十次导出历史');
  assert.equal(amended.baseline, task.baseline);
  assert.equal(amended.revision, 2);
  assert.equal(amended.requirements[1].id, 'R2');
  assert.equal((await checkRepository(repo, { offline: true })).files.length, 1);
});

test('explicit boundaries flag violations without treating adjacent directories as allowed', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修复登录', { allowedPaths: ['src/auth/'] });
  await put(repo.root, 'src/auth/login.js', 'fix\n');
  await put(repo.root, 'src/auth-extra/new.js', 'extra\n');
  const report = await checkRepository(repo, { offline: true });
  assert.deepEqual(report.findings.map(f => f.file), ['src/auth-extra/new.js']);
  assert.equal(reportExitCode(report), 1);
  await assert.rejects(amendTask(repo, '', { allowedPaths: ['../outside'] }), /仓库相对路径/);
});

test('read-only task reports real edits, with no attribution of pre-existing files', async t => {
  const repo = await fixture(t, { 'file.js': 'user change\n' });
  await startTask(repo, '审查代码', { mode: 'review' });
  assert.equal((await checkRepository(repo, { offline: true })).findings.length, 0);
  await put(repo.root, 'file.js', 'unauthorized\n');
  assert.equal((await checkRepository(repo, { offline: true })).findings[0].kind, 'read-only');
});

test('dependency rule detects actual new npm entries, including new manifests; version updates are not additions', async t => {
  const repo = await fixture(t, { 'package.json': '{"dependencies":{"old":"1"}}' });
  await startTask(repo, '修复问题', { noDependencies: true });
  await put(repo.root, 'package.json', '{"dependencies":{"old":"2","extra":"1"}}');
  let report = await checkRepository(repo, { offline: true });
  assert.match(report.findings.find(f => f.kind === 'dependencies').reason, /dependencies:extra/);
  assert.deepEqual(dependencyAdditions('{"dependencies":{"old":"1"}}', '{"dependencies":{"old":"2"}}'), []);
  await amendTask(repo, '', { noDependencies: false });
  report = await checkRepository(repo, { offline: true });
  assert.equal(report.findings.length, 0);
});

test('malformed package.json is marked incomplete rather than silently passing dependency checks', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修复问题', { noDependencies: true });
  await put(repo.root, 'package.json', 'not json');
  const report = await checkRepository(repo, { judgeImpl: mockJudge() });
  assert.equal(report.semantic, 'incomplete');
  assert.match(report.skipped[0].reason, /无法解析/);
});

test('missing API key yields an incomplete report, never a clean semantic verdict', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修复问题');
  await put(repo.root, 'app.js', 'change\n');
  const report = await checkRepository(repo, { apiKey: '' });
  assert.equal(report.semantic, 'incomplete');
  assert.equal(reportExitCode(report), 2);
  assert.match(renderReport(report), /OPENROUTER_API_KEY/);
  assert.doesNotMatch(renderReport(report), /未发现范围偏离/);
});

test('OpenRouter wire format and evidence IDs work through a real local HTTP roundtrip', async t => {
  const repo = await fixture(t);
  const task = await startTask(repo, '修复登录超时', { constraints: ['保留登录方式'] });
  let seen;
  const endpoint = await localAPI(t, (req, res, body) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    seen = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(apiAnswers(seen)));
  });
  const result = await judge(task, [change()], { apiKey: 'fixture-token', endpoint });
  assert.equal(seen.model, 'jev-1.13');
  assert.equal(seen.state.requirements[0].text, '修复登录超时');
  assert.equal(seen.questions.F1_relation.type, 'choice');
  assert.equal(result.judgments[0].requirementId, 'R1');
  assert.equal(result.judgments[0].relation, 'explicit');
  assert.equal(result.usage.cost, 0.00002);
  assert.doesNotMatch(JSON.stringify(result), /fixture-token/);
});

test('invalid or forged evidence choices reject the entire semantic response', async t => {
  const repo = await fixture(t);
  const task = await startTask(repo, '修复问题');
  const endpoint = await localAPI(t, (_req, res, body) => {
    const answer = apiAnswers(JSON.parse(body));
    answer.answers.F1_basis.choice = 'invented-R99';
    res.end(JSON.stringify(answer));
  });
  await assert.rejects(judge(task, [change()], { apiKey: 'fixture', endpoint }), /无效的分类/);
});

test('ambiguous probabilities and absent supporting evidence remain uncertain', async t => {
  const repo = await fixture(t);
  const task = await startTask(repo, '修复问题');
  let scenario;
  const endpoint = await localAPI(t, (_req, res, body) => {
    const answer = apiAnswers(JSON.parse(body), { F1_relation: 'necessary', F1_basis: scenario === 'missing-basis' ? 'none' : 'R1' });
    if (scenario === 'low-relation') answer.answers.F1_relation.probabilities = { explicit: 0.1, necessary: 0.4, extra: 0.2, uncertain: 0.3 };
    if (scenario === 'low-basis') answer.answers.F1_basis.probabilities = { R1: 0.4, none: 0.6 };
    res.end(JSON.stringify(answer));
  });
  for (scenario of ['missing-basis', 'low-relation', 'low-basis']) {
    const result = (await judge(task, [change()], { apiKey: 'fixture', endpoint })).judgments[0];
    assert.equal(result.relation, 'uncertain');
    if (scenario === 'low-basis') assert.equal(result.requirementId, null);
  }
});

test('API HTTP failure is reported once per check with no retries or provider body disclosure', async t => {
  const repo = await fixture(t);
  const task = await startTask(repo, '修复问题');
  let calls = 0;
  const endpoint = await localAPI(t, (_req, res) => { calls++; res.writeHead(429); res.end('secret-provider-debug'); });
  const report = await reviewChanges(task, [change()], { apiKey: 'fixture', endpoint });
  assert.equal(calls, 1);
  assert.match(report.notice, /HTTP 429/);
  assert.doesNotMatch(JSON.stringify(report), /secret-provider-debug/);
  assert.equal(reportExitCode(report), 2);
});

test('API timeout and malformed JSON remain incomplete', async t => {
  const repo = await fixture(t);
  const task = await startTask(repo, '修复问题');
  const hanging = await localAPI(t, () => {});
  const timed = await reviewChanges(task, [change()], { apiKey: 'fixture', endpoint: hanging, timeoutMs: 30 });
  assert.match(timed.notice, /超时/);
  const broken = await localAPI(t, (_req, res) => res.end('{'));
  const invalid = await reviewChanges(task, [change()], { apiKey: 'fixture', endpoint: broken });
  assert.match(invalid.notice, /无效 JSON/);
});

test('binary and private key changes are skipped without a network request', async t => {
  const repo = await fixture(t);
  const task = await startTask(repo, '修改文件');
  let calls = 0;
  const report = await reviewChanges(task, [
    change('asset.png', 'Binary files a/asset.png and b/asset.png differ'),
    change('config.js', '+-----BEGIN RSA PRIVATE KEY-----'),
  ], { judgeImpl: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(report.skipped.length, 2);
  assert.equal(reportExitCode(report), 2);
});

test('more than twelve files are checked in bounded batches without dropping files', async t => {
  const repo = await fixture(t);
  const task = await startTask(repo, '修改模块');
  let calls = 0;
  const report = await reviewChanges(task, Array.from({ length: 15 }, (_, i) => ({ ...change(`${i}.js`), id: `F${i + 1}` })), {
    judgeImpl: async (...args) => { calls++; assert.ok(args[1].length <= 4); return mockJudge()(...args); },
  });
  assert.equal(calls, 4);
  assert.equal(report.judgments.length, 15);
  assert.equal(report.skipped.length, 0);
  assert.equal(report.semantic, 'complete');
});

test('binary marker strings inside source and test data do not exclude text files', async t => {
  const repo = await fixture(t);
  const task = await startTask(repo, '测试二进制检查');
  const changes = [
    change('src/check.js', '+const marker = /Binary files .* differ|GIT binary patch/;\n'),
    { ...change('test/check.js', '+const data = "GIT binary patch";\n'), id: 'F2' },
    { ...change('asset.png', 'Binary files a/asset.png and b/asset.png differ\n'), id: 'F3' },
    { ...change('asset.bin', 'GIT binary patch\nliteral 4\n'), id: 'F4' },
  ];
  const report = await reviewChanges(task, changes, { judgeImpl: mockJudge() });
  assert.deepEqual(report.judgments.map(item => item.file), ['src/check.js', 'test/check.js']);
  assert.deepEqual(report.skipped.map(item => item.file), ['asset.png', 'asset.bin']);
});

test('multipart records retain a bounded redacted file header in every batch', async t => {
  const repo = await fixture(t);
  const task = await startTask(repo, '保存测试报告');
  const record = '+{"methodology":"Recorded test results","api_key":"abcdefghijklmnop"}\n'
    + '+{"case":"hypothetical palette change"}\n'.repeat(1300);
  const plan = planReview(task, [change('evaluation/results.json', record)]);
  assert.ok(plan.batches.length > 1);
  for (const batch of plan.batches) {
    assert.equal(batch.context.fileHeaders.length, 1);
    const header = batch.context.fileHeaders[0];
    assert.match(header.excerpt, /Recorded test results/);
    assert.match(header.excerpt, /REDACTED_CREDENTIAL/);
    assert.doesNotMatch(header.excerpt, /abcdefghijklmnop/);
    assert.ok(header.excerpt.length <= 1000);
    assert.ok(Buffer.byteLength(JSON.stringify(buildRequest(task, batch.changes, 'jev-1.13', batch.context))) <= 48000);
  }
});

test('a split between direct and necessary is not confused with low scope support', async t => {
  const task = await startTask(await fixture(t), '制作应用画面');
  const endpoint = await localAPI(t, (_req, res, body) => {
    const answer = apiAnswers(JSON.parse(body));
    Object.assign(answer.answers.F1_relation, { confidence: 0.28,
      probabilities: { explicit: 0.48, necessary: 0.43, extra: 0.02, uncertain: 0.07 } });
    res.end(JSON.stringify(answer));
  });
  const result = (await judge(task, [change()], { apiKey: 'fixture', endpoint })).judgments[0];
  assert.equal(result.relation, 'explicit');
  assert.equal(result.confidence, 0.28);
  assert.ok(Math.abs(result.allowedProbability - 0.91) < 1e-9);
});

test('large minified and Unicode diffs are lossless, with extra behavior in the final part retained', async t => {
  const task = await startTask(await fixture(t), '调整样式');
  const diff = '+.item{content:"中文😀";color:red;}'.repeat(900) + '\n+sendAnalytics();';
  const parts = splitDiff(diff);
  assert.equal(parts.join(''), diff);
  assert.ok(parts.every(p => Buffer.byteLength(p) <= 8000));
  const report = await reviewChanges(task, [change('web/large.css', diff)], {
    judgeImpl: async (_task, units) => ({ usage: { cost: 0.01 }, judgments: units.map(unit => ({
      id: unit.id, file: unit.file, relation: unit.diff.includes('sendAnalytics') ? 'extra' : 'explicit',
      requirementId: 'R1', confidence: 0.9, conflictId: null,
      evidenceId: unit.evidenceCandidates.find(item => item.summary.includes('sendAnalytics'))?.id, scopeReason: 'independent',
    })) }),
  });
  assert.equal(report.semantic, 'complete');
  assert.equal(report.judgments[0].relation, 'extra');
  assert.equal(report.coverage.reviewedParts, parts.length);
  assert.equal(report.usage.cost, report.coverage.batches * 0.01);
});

test('a failed batch preserves completed parts and cannot pass a partly checked file', async t => {
  const task = await startTask(await fixture(t), '修改模块');
  let calls = 0;
  const report = await reviewChanges(task, [change('huge.js', '+let x=1;'.repeat(6500))], {
    judgeImpl: async (...args) => { if (++calls === 2) throw new Error('fixture failure'); return mockJudge()(...args); },
  });
  assert.equal(calls, 2);
  assert.equal(report.semantic, 'incomplete');
  assert.equal(report.judgments[0].relation, 'uncertain');
  assert.ok(report.coverage.reviewedParts < report.coverage.totalParts);
  assert.match(report.skipped[0].reason, /片段/);
});

test('credentials are redacted before chunking, linking and sending, including repeated values', async t => {
  const task = await startTask(await fixture(t), '修改模块');
  const secret = 'sk-or-v1-' + 'fixture1234567890'.repeat(3);
  let sent = '';
  const report = await reviewChanges(task, [change('test/module.test.js', `+const api_key = "${secret}";\n+assert.equal(value, "${secret}");`)], {
    judgeImpl: async (...args) => { sent += JSON.stringify({ changes: args[1], context: args[2].context }); return mockJudge()(...args); },
  });
  assert.doesNotMatch(sent, new RegExp(secret));
  assert.match(sent, /REDACTED_CREDENTIAL/);
  assert.equal(report.skipped.length, 0);
  assert.equal(report.redacted.length, 1);
  assert.equal(report.judgments[0].relation, 'uncertain');
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
});

test('batch context carries literal cross-file wiring and respects the request budget', async t => {
  const task = await startTask(await fixture(t), '制作应用画面');
  const changes = [change('bin/ui.js', "+import {startWorkbench} from '../src/workbench.js';\n+startWorkbench();"),
    { ...change('src/workbench.js', '+export function startWorkbench() {}'), id: 'F2' }];
  const plan = planReview(task, changes);
  assert.deepEqual(plan.batches[0].context.links.map(({from,to}) => ({from,to})), [{ from: 'bin/ui.js', to: 'src/workbench.js' }]);
  assert.ok(plan.batches.every(b => Buffer.byteLength(JSON.stringify(buildRequest(task, b.changes, 'jev-1.13', b.context))) <= 48000));
});

test('old classifier results cannot be reused after upgrading the review policy', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修改模块');
  await put(repo.root, 'app.js', 'new\n');
  const previous = await checkRepository(repo, { judgeImpl: mockJudge() });
  delete previous.reviewVersion;
  await writeState(repo, 'latest.json', previous);
  let calls = 0;
  const report = await checkRepository(repo, { judgeImpl: async (...args) => { calls++; return mockJudge()(...args); } });
  assert.equal(calls, 1);
  assert.equal(report.reviewVersion, REVIEW_VERSION);
});

test('an exhausted budget makes no requests and lists the unchecked portions', async t => {
  const task = await startTask(await fixture(t), '修改模块');
  let calls = 0;
  const report = await reviewChanges(task, [change()], { deadlineAt: Date.now() - 1,
    judgeImpl: async (...args) => { calls++; return mockJudge()(...args); } });
  assert.equal(calls, 0);
  assert.equal(report.semantic, 'incomplete');
  assert.equal(report.coverage.reviewedParts, 0);
  assert.equal(report.skipped.length, 1);
});

test('the total size cap stays explicit after removing the old per-file cap', async t => {
  const task = await startTask(await fixture(t), '修改模块');
  const report = await reviewChanges(task, [change('huge.js', 'x'.repeat(512001))], { judgeImpl: mockJudge() });
  assert.equal(report.semantic, 'incomplete');
  assert.equal(report.judgments.length, 0);
  assert.match(report.skipped[0].reason, /512 KB/);
});

test('sensitive paths are absent from snapshots and semantic requests', async t => {
  const repo = await fixture(t, { 'app.js': 'old\n', '.env': 'secret=value', 'sub/private.pem': 'private', 'private.PEM': 'private' });
  await commit(repo);
  const indexBefore = await git(repo.root, ['ls-files', '--stage']);
  const task = await startTask(repo, '修改模块');
  await put(repo.root, '.env', 'secret=changed');
  await put(repo.root, 'app.js', 'new\n');
  const report = await checkRepository(repo, { judgeImpl: mockJudge() });
  assert.deepEqual(report.files.map(f => f.file), ['app.js']);
  assert.doesNotMatch(await git(repo.root, ['ls-tree', '-r', task.baseline]), /\.env|private\.pem/i);
  assert.equal(await git(repo.root, ['ls-files', '--stage']), indexBefore);
  let calls = 0;
  const proposal = await reviewChanges(task, [change('.env', '+TOKEN=value')], { judgeImpl: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.match(proposal.skipped[0].reason, /敏感文件路径/);
});

test('tracked files remain reviewable after becoming ignored; untracked ignored files stay excluded', async t => {
  const repo = await fixture(t, { 'tracked.txt': 'old\n', '.gitignore': 'tracked.txt\nignored.txt\n' });
  await git(repo.root, ['add', '-f', 'tracked.txt']);
  await commit(repo);
  const task = await startTask(repo, '修改已有文件');
  await put(repo.root, 'tracked.txt', 'new\n');
  await put(repo.root, 'ignored.txt', 'ignored\n');
  const changes = await changesBetween(repo, task.baseline, await snapshot(repo));
  assert.deepEqual(changes.map(item => item.file), ['tracked.txt']);
  assert.match(changes[0].diff, /\+new/);
});

test('successful checks cache by task revision and actual content; amendments invalidate cache', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修改模块');
  await put(repo.root, 'file.js', 'new\n');
  let calls = 0;
  const judgeImpl = async (...args) => { calls++; return mockJudge()(...args); };
  await checkRepository(repo, { judgeImpl });
  assert.equal((await checkRepository(repo, { judgeImpl })).cached, true);
  assert.equal(calls, 1);
  await amendTask(repo, '也调整错误提示');
  await checkRepository(repo, { judgeImpl });
  assert.equal(calls, 2);
  await checkRepository(repo, { judgeImpl, refresh: true });
  assert.equal(calls, 3);
});

test('read-only hook denies supported edits, including unparseable input', async t => {
  const repo = await fixture(t);
  await startTask(repo, '只读审查', { mode: 'review' });
  const result = await runHook({ cwd: repo.root, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: {} });
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(result.hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('patch parser handles CRLF, absolute paths and moves; destination boundary is enforced', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修改登录', { allowedPaths: ['src/auth/'] });
  const patch = `*** Begin Patch\r\n*** Update File: ${path.join(repo.root, 'src/auth/login.js')}\r\n*** Move to: src/elsewhere.js\r\n@@\r\n-old\r\n+new\r\n*** End Patch\r\n`;
  assert.equal(patchChanges(patch, repo).length, 2);
  const output = await runHook({ cwd: repo.root, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch } }, { offline: true });
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /elsewhere/);
});

test('semantic pre-edit findings only add context, and repeated identical proposals reuse results', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修复登录', { reviewMode: 'live' });
  const payload = { cwd: repo.root, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: {
    command: '*** Begin Patch\n*** Add File: history.js\n+const history = [];\n*** End Patch\n',
  } };
  let calls = 0;
  const options = { apiKey: 'fixture', judgeImpl: async (...args) => { calls++; return mockJudge('extra')(...args); } };
  const output = await runHook(payload, options);
  assert.match(output.hookSpecificOutput.additionalContext, /新增代码：const history/);
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  await runHook(payload, options);
  assert.equal(calls, 1);
});

test('prompt hook supplies boundaries but does not treat a model plan or new prompt as authorization', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修复登录');
  const output = await runHook({ cwd: repo.root, hook_event_name: 'UserPromptSubmit', prompt: '我计划增加一个框架' });
  assert.match(output.hookSpecificOutput.additionalContext, /R1：修复登录/);
  assert.match(output.hookSpecificOutput.additionalContext, /check --for-chat/);
  assert.match(output.hookSpecificOutput.additionalContext, /原样附在最终答复/);
  assert.equal((await activeTask(repo)).requirements.length, 1);
});

test('Stop reports concerns but never creates continuation or automatic repair prompts', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修复登录');
  await put(repo.root, 'extra.js', 'extra\n');
  const output = await runHook({ cwd: repo.root, hook_event_name: 'Stop', stop_hook_active: true }, { judgeImpl: mockJudge('extra') });
  assert.match(output.systemMessage, /需关注/);
  assert.equal(output.decision, undefined);
  assert.equal(output.continue, undefined);
});

test('CLI lifecycle and hook stdin/stdout are usable from another project directory', async t => {
  const repo = await fixture(t, { 'file.js': 'old\n' });
  assert.equal((await cli(repo.root, ['start', '只审查', '--mode', 'review'])).code, 0);
  const status = await cli(repo.root, ['status', '--json']);
  assert.equal(JSON.parse(status.stdout).mode, 'review');
  const hook = await cli(repo.root, ['hook', '--offline'], JSON.stringify({
    cwd: repo.root, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: 'bad patch' },
  }));
  assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(hook.stderr, '');
  await put(repo.root, 'file.js', 'new\n');
  const check = await cli(repo.root, ['check', '--offline', '--json']);
  assert.equal(check.code, 1);
  assert.equal(JSON.parse(check.stdout).files.length, 1);
  assert.equal((await cli(repo.root, ['finish'])).code, 0);
  assert.equal((await cli(repo.root, ['check', '--offline'])).code, 2);
  assert.equal(await readFile(path.join(repo.root, 'file.js'), 'utf8'), 'new\n');
});

test('hook configuration uses official events and portable absolute executable paths', () => {
  const config = hookConfiguration();
  assert.deepEqual(Object.keys(config.hooks), ['UserPromptSubmit', 'PreToolUse', 'Stop']);
  assert.equal(config.hooks.PreToolUse[0].matcher, '^apply_patch$');
  assert.match(config.hooks.Stop[0].hooks[0].command, /scope\.js' 'hook'/);
  assert.ok(config.hooks.Stop[0].hooks[0].command.startsWith(`'${process.execPath.replaceAll("'", "'\"'\"'")}'`));
  assert.equal(config.hooks.Stop[0].hooks[0].async, false);
  assert.equal(config.hooks.Stop[0].hooks[0].additionalContextLimit, undefined);
  assert.equal(config.hooks.PreToolUse[0].hooks[0].async, undefined);
});

test('Windows hook command launches through PowerShell with JSON stdin', { skip: process.platform !== 'win32' }, async () => {
  const command = hookConfiguration().hooks.UserPromptSubmit[0].hooks[0].commandWindows;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
  child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
  child.stdin.end(JSON.stringify({ hook_event_name: 'UnsupportedFixtureEvent' }));
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), {});
});

test('requirements and model questions never request free-form explanations or fabricated evidence', async t => {
  const repo = await fixture(t);
  const task = await startTask(repo, '修复问题', { constraints: ['不增加设置'] });
  const body = buildRequest(task, [change()]);
  assert.deepEqual(Object.keys(body.questions.F1_basis.criteria), ['R1', 'none']);
  assert.deepEqual(Object.keys(body.questions.F1_conflict.criteria), ['C1', 'none']);
  assert.ok(Object.values(body.questions).every(q => q.type === 'choice'));
});

test('retracting requirements and constraints preserves history, stable IDs and baseline', async t => {
  const repo = await fixture(t);
  const initial = await startTask(repo, '增加 CSV 导出', { constraints: ['禁止历史记录', '保留离线能力'] });
  const updated = await amendTask(repo, '允许保留最近十次导出记录', { drop: ['c1'], constraints: ['最多十条'] });
  assert.equal(updated.baseline, initial.baseline);
  assert.deepEqual(updated.constraints.map(item => item.id), ['C2', 'C3']);
  assert.equal(updated.retired[0].id, 'C1');
  assert.equal(updated.retired[0].retiredRevision, 2);
  const request = buildRequest(updated, [change()]);
  assert.doesNotMatch(JSON.stringify(request), /禁止历史记录/);
  assert.deepEqual(Object.keys(request.questions.F1_conflict.criteria), ['C2', 'C3', 'none']);
  const prompt = await runHook({ cwd: repo.root, hook_event_name: 'UserPromptSubmit' });
  assert.doesNotMatch(prompt.hookSpecificOutput.additionalContext, /禁止历史记录/);
  await amendTask(repo, '导出仅需当前筛选结果', { drop: ['R1'] });
  const next = await amendTask(repo, '增加文件名日期');
  assert.deepEqual(next.requirements.map(item => item.id), ['R2', 'R3', 'R4']);
});

test('invalid retractions are atomic and cannot leave a task with no requirements', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修复登录', { constraints: ['保持 API'] });
  const before = await activeTask(repo);
  await assert.rejects(amendTask(repo, '未授权的附带修改', { drop: ['C99'] }), /没有有效/);
  await assert.rejects(amendTask(repo, '', { drop: ['R1'] }), /至少需要/);
  await assert.rejects(amendTask(repo, '更新', { drop: ['C1'], reviewMode: 'invalid' }), /review 只能/);
  assert.deepEqual(await activeTask(repo), before);
});

test('default pre-edit checks never call Jev; manual mode preserves local boundaries', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修复登录', { allowedPaths: ['src/'] });
  const payload = { cwd: repo.root, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: {
    command: '*** Begin Patch\n*** Add File: src/login.js\n+fix\n*** End Patch\n',
  } };
  let calls = 0;
  const options = { apiKey: 'fixture', judgeImpl: async (...args) => { calls++; return mockJudge()(...args); } };
  assert.deepEqual(await runHook(payload, options), {});
  await amendTask(repo, '', { reviewMode: 'manual' });
  await put(repo.root, 'extra.js', 'extra\n');
  assert.deepEqual(await runHook({ cwd: repo.root, hook_event_name: 'Stop' }, options), {});
  payload.tool_input.command = '*** Begin Patch\n*** Add File: extra.js\n+extra\n*** End Patch\n';
  assert.equal((await runHook(payload, options)).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(calls, 0);
});

test('uncertain-only results stay available in the report without a user-facing hook warning', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修复导出');
  await put(repo.root, 'escape.js', 'escape\n');
  assert.deepEqual(await runHook({ cwd: repo.root, hook_event_name: 'Stop' }, { judgeImpl: mockJudge('uncertain') }), {});
  const report = await readState(repo, 'latest.json');
  assert.equal(report.findings[0].kind, 'uncertain');
  assert.match(renderReport(report), /需核对/);
  assert.equal(reportExitCode(report), 1);
});

test('Stop gives concrete color and automation notices without continuation or model context', async t => {
  const repo = await fixture(t, { 'styles.css': 'body { font-family: serif; color: black; }\n' });
  await startTask(repo, '字体换成微软雅黑。');
  await put(repo.root, 'styles.css', 'body { font-family: "Microsoft YaHei"; color: purple; }\n');
  await put(repo.root, 'auto.js', 'setInterval(() => runCheck(), 10000);\n');
  const endpoint = await localAPI(t, (_req, res, body) => {
    const request = JSON.parse(body);
    const overrides = {};
    for (const [id, change] of Object.entries(request.state.changes)) {
      overrides[`${id}_relation`] = 'extra';
      overrides[`${id}_basis`] = 'none';
      overrides[`${id}_extra_kind`] = change.file === 'styles.css' ? 'color' : 'automation';
    }
    res.end(JSON.stringify(apiAnswers(request, overrides)));
  });
  const payload = { cwd: repo.root, hook_event_name: 'Stop' };
  const options = { apiKey: 'fixture', endpoint };
  const output = await runHook(payload, options);
  assert.deepEqual(Object.keys(output), ['systemMessage']);
  assert.match(output.systemMessage, /styles\.css:1：修改配色：.*color：black → purple/);
  assert.match(output.systemMessage, /auto\.js:1：增加自动执行：.*setInterval/);
  assert.match(output.systemMessage, /说“查看范围检查报告”/);
  assert.ok(output.systemMessage.length < 450);
  assert.deepEqual(await runHook(payload, options), {});
});

test('notice labels cannot turn allowed or uncertain changes into warnings', async t => {
  const repo = await fixture(t);
  const task = await startTask(repo, '调整颜色');
  let relation;
  const endpoint = await localAPI(t, (_req, res, body) => {
    res.end(JSON.stringify(apiAnswers(JSON.parse(body), { F1_relation: relation, F1_extra_kind: 'color' })));
  });
  for (relation of ['explicit', 'necessary', 'uncertain']) {
    const report = await reviewChanges(task, [change()], { apiKey: 'fixture', endpoint });
    assert.equal(report.judgments[0].relation, relation);
    assert.equal(report.judgments[0].extraKind, null);
    assert.equal(renderNotice(report), '');
  }
});

test('coarse extra labels without concrete evidence remain uncertain and quiet', async t => {
  const repo = await fixture(t);
  const task = await startTask(repo, '修复登录');
  let scenario;
  const endpoint = await localAPI(t, (_req, res, body) => {
    const answer = apiAnswers(JSON.parse(body), { F1_relation: 'extra', F1_basis: 'none', F1_extra_kind: 'color', F1_evidence: 'none', F1_scope_reason: 'none' });
    const label = answer.answers.F1_extra_kind;
    if (scenario === 'missing') delete answer.answers.F1_extra_kind;
    if (scenario === 'forged') label.choice = 'untrusted-free-form-text';
    if (scenario === 'low') label.probabilities = Object.fromEntries(Object.keys(label.probabilities)
      .map(key => [key, key === 'color' ? 0.3 : 0.1]));
    const response = scenario === 'none'
      ? apiAnswers(JSON.parse(body), { F1_relation: 'extra', F1_basis: 'none', F1_extra_kind: 'none', F1_evidence: 'none', F1_scope_reason: 'none' }) : answer;
    res.end(JSON.stringify(response));
  });
  for (scenario of ['missing', 'forged', 'low', 'none']) {
    const report = await reviewChanges(task, [change()], { apiKey: 'fixture', endpoint });
    assert.equal(report.semantic, 'complete');
    assert.equal(report.judgments[0].relation, 'uncertain');
    assert.equal(report.judgments[0].rawRelation, 'extra');
    assert.equal(report.judgments[0].extraKind, null);
    assert.equal(renderNotice(report), '');
    assert.match(renderReport(report), /证据不足/);
    assert.doesNotMatch(renderNotice(report), /修改配色|untrusted-free-form-text/);
  }
});

test('notifications survive manual checks and deduplicate unrelated edits, but changed flagged content is reported again', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修复登录');
  await put(repo.root, 'extra.js', 'extra\n');
  const judgeImpl = async (_task, changes) => ({ model: 'mock', usage: {}, judgments: changes.map(item => ({
    ...item, relation: item.file === 'extra.js' ? 'extra' : 'explicit', requirementId: null, conflictId: null,
    evidenceId: item.evidenceCandidates[0]?.id, scopeReason: 'independent',
  })) });
  await checkRepository(repo, { judgeImpl });
  const stop = () => runHook({ cwd: repo.root, hook_event_name: 'Stop' }, { judgeImpl });
  assert.match((await stop()).systemMessage, /需关注/);
  assert.deepEqual(await stop(), {});
  await put(repo.root, 'fix.js', 'legitimate\n');
  assert.deepEqual(await stop(), {});
  await put(repo.root, 'extra.js', 'extra updated\n');
  assert.match((await stop()).systemMessage, /需关注/);
});

test('chat notice is visible after a native Hook notice and stays quiet on repeats and unrelated edits', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修复登录');
  await put(repo.root, 'extra.js', 'extra\n');
  const judgeImpl = async (_task, changes) => ({ model: 'mock', usage: {}, judgments: changes.map(item => ({
    ...item, relation: item.file === 'extra.js' ? 'extra' : 'explicit', requirementId: null, conflictId: null,
    evidenceId: item.evidenceCandidates[0]?.id, scopeReason: 'independent',
  })) });
  assert.match((await runHook({ cwd: repo.root, hook_event_name: 'Stop' }, { judgeImpl })).systemMessage, /需关注/);
  const first = await cli(repo.root, ['check', '--for-chat']);
  assert.equal(first.code, 0);
  assert.match(first.stdout, /extra\.js/);
  assert.equal(first.stderr, '');
  assert.equal((await cli(repo.root, ['check', '--for-chat'])).stdout, '');
  await put(repo.root, 'allowed.js', 'fix\n');
  await checkRepository(repo, { judgeImpl });
  assert.equal((await cli(repo.root, ['check', '--for-chat'])).stdout, '');
  await put(repo.root, 'extra.js', 'more extra\n');
  await checkRepository(repo, { judgeImpl });
  assert.match((await cli(repo.root, ['check', '--for-chat'])).stdout, /extra\.js/);
});

test('a final-answer notice consumes the following Stop notice without continuation', async t => {
  const repo = await fixture(t);
  await startTask(repo, '改字体');
  await put(repo.root, 'extra.js', 'extra\n');
  await checkRepository(repo, { judgeImpl: mockJudge('extra') });
  assert.match((await cli(repo.root, ['check', '--for-chat'])).stdout, /需关注/);
  assert.deepEqual(await runHook({ cwd: repo.root, hook_event_name: 'Stop' }, { apiKey: '' }), {});
});

test('final-answer checking is silent for allowed work, manual mode and no active task', async t => {
  const repo = await fixture(t);
  assert.equal((await cli(repo.root, ['check', '--for-chat'])).stdout, '');
  await startTask(repo, '修复登录');
  await put(repo.root, 'allowed.js', 'fix\n');
  await checkRepository(repo, { judgeImpl: mockJudge() });
  assert.equal((await cli(repo.root, ['check', '--for-chat'])).stdout, '');
  await amendTask(repo, '', { reviewMode: 'manual' });
  await put(repo.root, 'unchecked.js', 'new\n');
  const before = await readState(repo, 'latest.json');
  const result = await cli(repo.root, ['check', '--for-chat']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.deepEqual(await readState(repo, 'latest.json'), before);
});

test('repeated automatic API failures are quiet and use a short cooldown; explicit refresh still retries', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修复登录');
  await put(repo.root, 'file.js', 'fix\n');
  let calls = 0;
  const judgeImpl = async () => { calls++; throw new Error('Jev 服务暂不可用'); };
  const payload = { cwd: repo.root, hook_event_name: 'Stop' };
  assert.match((await runHook(payload, { judgeImpl })).systemMessage, /未完成/);
  assert.deepEqual(await runHook(payload, { judgeImpl }), {});
  assert.equal(calls, 1);
  await checkRepository(repo, { judgeImpl, refresh: true });
  assert.equal(calls, 2);
});

test('overlapping background checks share a successful result and publish one notification', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修复登录');
  await put(repo.root, 'file.js', 'extra\n');
  let calls = 0;
  const judgeImpl = async (...args) => { calls++; return mockJudge('extra')(...args); };
  const payload = { cwd: repo.root, hook_event_name: 'Stop' };
  const outputs = await Promise.all([runHook(payload, { judgeImpl }), runHook(payload, { judgeImpl })]);
  assert.equal(calls, 1);
  assert.equal(outputs.filter(item => item.systemMessage).length, 1);
});

test('background results are discarded if the user updates the task or code during a request', async t => {
  const repo = await fixture(t);
  await startTask(repo, '修复登录');
  await put(repo.root, 'file.js', 'fix\n');
  for (const update of [() => amendTask(repo, '补充授权'), () => put(repo.root, 'file.js', 'newer fix\n')]) {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const pending = runHook({ cwd: repo.root, hook_event_name: 'Stop' }, { judgeImpl: async (...args) => {
      entered(); await gate; return mockJudge('extra')(...args);
    } });
    await started;
    await update();
    release();
    assert.deepEqual(await pending, {});
    assert.equal(await readState(repo, 'latest.json'), null);
  }
});

test('compact notices show at most three files and retain concrete constraints', async t => {
  const task = { id: 'notice', revision: 1, requirements: [{ id: 'R1', text: '修复' }], constraints: [{ id: 'C1', text: '禁止上传数据' }], mode: 'change', allowedPaths: [] };
  const report = await reviewChanges(task, Array.from({ length: 5 }, (_, i) => ({ ...change(`${i}.js`), id: `F${i}` })), { judgeImpl: mockJudge('extra') });
  report.findings.push({ file: '0.js', level: 'warning', kind: 'constraint', constraintId: 'C1' });
  const notice = renderNotice(report);
  assert.equal(notice.split('\n').filter(line => line.startsWith('- ')).length, 3);
  assert.match(notice, /另有 2 个文件/);
  assert.match(notice, /禁止上传数据/);
  assert.equal(renderNotice({ ...report, stale: true }), '');
});

test('CLI supports explicit retraction, history, cadence and reading stale saved reports without an API key', async t => {
  const repo = await fixture(t);
  assert.equal((await cli(repo.root, ['start', '导出 CSV', '--constraint', '禁止历史记录', '--review', 'manual'])).code, 0);
  await put(repo.root, 'file.js', 'export\n');
  await cli(repo.root, ['check', '--offline']);
  const updated = await cli(repo.root, ['amend', '允许历史记录', '--drop', 'C1', '--review', 'end']);
  assert.equal(updated.code, 0);
  const status = await cli(repo.root, ['status', '--history']);
  assert.match(status.stdout, /已撤销 C1/);
  assert.match(status.stdout, /结束时检查/);
  const report = await cli(repo.root, ['report', '--json']);
  assert.equal(report.code, 2);
  assert.equal(JSON.parse(report.stdout).stale, true);
  assert.equal((await cli(repo.root, ['report'])).stdout.includes('未重新扫描当前文件'), true);
});

test('pre-edit boundaries resolve subdirectory working paths and Windows directory aliases', async t => {
  const repo = await fixture(t, { 'src/auth/login.js': 'old\n' });
  await startTask(repo, '修改登录', { allowedPaths: ['src/auth/'] });
  const cwd = path.join(repo.root, 'src/auth');
  const command = '*** Begin Patch\n*** Add File: new.js\n+new\n*** End Patch\n';
  const payload = { cwd, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command } };
  assert.deepEqual(await runHook(payload, { offline: true }), {});
  const alias = path.join(repo.root, 'alias');
  await symlink(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
  payload.tool_input.command = `*** Begin Patch\n*** Add File: ${path.join(alias, 'new.js')}\n+new\n*** End Patch\n`;
  assert.deepEqual(await runHook(payload, { offline: true }), {});
});
