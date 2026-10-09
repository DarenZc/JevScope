import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { configPaths, scopeScript } from '../src/config.js';
import { install, uninstall, doctor } from '../src/install.js';
import { hookConfiguration, runHook, takeNotice } from '../src/hooks.js';
import { supportedHosts, resolveHost } from '../src/hosts.js';
import { toolChanges } from '../src/tool-changes.js';
import { repository, git } from '../src/repo.js';
import { startTask, amendTask, activeTask, readState } from '../src/task.js';
import { extractEvidence } from '../src/evidence.js';
import { checkRepository } from '../src/review.js';

const hosts = ['claude-code', 'workbuddy', 'codebuddy'];
const put = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const json = async file => JSON.parse(await readFile(file, 'utf8'));

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jev-host-test-'));
  t.after(async () => {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(tmpdir()));
    assert.ok(path.basename(target).startsWith('jev-host-test-'));
    await rm(target, { recursive: true, force: true });
  });
  return directory;
}

async function fixture(t) {
  const directory = await temporary(t), root = path.join(directory, 'project');
  await put(path.join(root, 'src', 'style.css'), '.button {\n  color: #222;\n}\n');
  await git(root, ['init', '-q']);
  return repository(root);
}

function execute(executable, args, { cwd, input = '', env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, timeout: 20000,
      env: { ...process.env, OPENROUTER_API_KEY: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('host selection uses independent homes; invalid or mixed overrides fail before writing', async t => {
  const directory = await temporary(t);
  assert.equal(resolveHost('claude').id, 'claude-code');
  assert.throws(() => configPaths({ host: 'missing' }), /不支持/);
  assert.throws(() => configPaths({ host: 'workbuddy', codexHome: directory }), /仅用于 Codex/);
  assert.throws(() => configPaths({ hostHome: directory, codexHome: path.join(directory, 'other') }), /不同目录/);
  assert.throws(() => configPaths({ host: 'claude-code', hostHome: '' }), /不能为空/);
  for (const host of supportedHosts()) {
    const expected = path.join(directory, host.id);
    const result = await execute(process.execPath, ['--input-type=module', '-e',
      `import { configPaths } from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)}; console.log(JSON.stringify(configPaths({host:${JSON.stringify(host.id)}})))`],
    { env: { [host.env]: expected, ...(host.id === 'codex' ? {} : { CODEX_HOME: path.join(directory, 'unrelated-codex') }) } });
    assert.equal(result.code, 0, result.stderr);
    const paths = JSON.parse(result.stdout);
    assert.equal(paths.home, expected);
    assert.equal(paths.hooks, path.join(expected, host.config));
  }
});

for (const host of hosts) test(`${host}: install/upgrade/uninstall preserves settings, foreign hooks and keys`, async t => {
  const hostHome = await temporary(t), options = { host, hostHome }, paths = configPaths(options);
  const original = { model: 'keep-model', permissions: { deny: ['Bash(rm:*)'] }, disableAllHooks: true,
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo foreign', timeout: 9 }] }] } };
  await put(paths.hooks, original);
  await put(paths.env, 'OPENROUTER_API_KEY=fixture-secret\n');
  const first = await install({ ...options, script: path.join(hostHome, 'old install', 'scope.js') });
  assert.deepEqual(await json(first.backup), original);
  const updated = await install(options);
  assert.equal(updated.changed, true);
  assert.equal((await install(options)).changed, false);
  const current = await json(paths.hooks);
  assert.equal(current.hooks.Stop.length, 2);
  assert.equal(current.model, original.model);
  assert.deepEqual(current.permissions, original.permissions);
  assert.equal(current.disableAllHooks, true);
  assert.ok((await doctor(options)).checks.some(check => check.name === 'Hooks 开关' && !check.ok));
  const handler = current.hooks.PreToolUse[0].hooks[0];
  assert.equal(handler.commandWindows, undefined);
  assert.equal(handler.additionalContextLimit, undefined);
  assert.equal((await json(paths.manifest)).host, host);
  await assert.rejects(install({ host: host === 'workbuddy' ? 'claude-code' : 'workbuddy', hostHome }), /其他宿主/);
  assert.deepEqual(await json(paths.hooks), current);
  await uninstall(options);
  assert.deepEqual(await json(paths.hooks), original);
  assert.equal(await readFile(paths.env, 'utf8'), 'OPENROUTER_API_KEY=fixture-secret\n');
  await put(paths.hooks, '{broken settings');
  await assert.rejects(install(options), /settings.json.*原文件未作修改/);
  assert.equal(await readFile(paths.hooks, 'utf8'), '{broken settings');
});

test('installed host launchers round-trip JSON in native shells with spaces, quotes and Unicode paths', async t => {
  const directory = await temporary(t), repo = await fixture(t);
  const copy = path.join(directory, "tool space ' $ ` 中文");
  await cp(new URL('../src/', import.meta.url), path.join(copy, 'src'), { recursive: true });
  await cp(new URL('../bin/', import.meta.url), path.join(copy, 'bin'), { recursive: true });
  await put(path.join(copy, 'package.json'), { type: 'module' });
  const script = path.join(copy, 'bin', 'scope.js');
  for (const host of hosts) {
    const hostHome = path.join(directory, `${host} ' $ \\ config`.replaceAll('\\', ''));
    await install({ host, hostHome, script });
    const handler = (await json(configPaths({ host, hostHome }).hooks)).hooks.UserPromptSubmit[0].hooks[0];
    const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: repo.root, prompt: '只改字体' });
    const shells = process.platform === 'win32'
      ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', handler.command]]]
      : [['/bin/sh', ['-c', handler.command]]];
    if (process.platform === 'win32') {
      const gitLocation = await execute('where.exe', ['git']);
      const gitPath = gitLocation.stdout.trim().split(/\r?\n/)[0];
      const bash = path.resolve(path.dirname(gitPath), '..', 'bin', 'bash.exe');
      shells.push([bash, ['--noprofile', '--norc', '-c', handler.command]]);
    }
    for (const [executable, args] of shells) {
      const result = await execute(executable, args, { cwd: repo.root, input });
      assert.equal(result.code, 0, result.stderr);
      const output = JSON.parse(result.stdout).hookSpecificOutput;
      assert.equal(output.hookEventName, 'UserPromptSubmit');
      assert.match(output.additionalContext, /check --for-chat/);
      assert.ok(output.additionalContext.includes(host));
      assert.equal(await activeTask(repo), null);
    }
  }
});

test('each host enforces paths/read-only for native edit tools without running semantic review in end mode', async t => {
  const repo = await fixture(t);
  await startTask(repo, '只改样式', { allowedPaths: ['src/'] });
  const variants = [
    ['Write', { file_path: 'src/style.css', content: 'new' }],
    ['Edit', { file_path: 'src/style.css', old_string: '#222', new_string: '#f00' }],
    ['MultiEdit', { file_path: 'src/style.css', edits: [{ old_string: '#222', new_string: '#f00' }] }],
    ['NotebookEdit', { notebook_path: 'src/example.ipynb', new_source: 'print(1)' }],
  ];
  for (const host of hosts) {
    const options = { host, apiKey: 'fixture', judgeImpl: () => assert.fail('end mode must not run pre-edit inference') };
    for (const [tool_name, tool_input] of variants) {
      assert.ok(new RegExp(hookConfiguration({ host }).hooks.PreToolUse[0].matcher).test(tool_name));
      const payload = { cwd: repo.root, hook_event_name: 'PreToolUse', tool_name, tool_input };
      assert.deepEqual(await runHook(payload, options), {});
      const key = tool_name === 'NotebookEdit' ? 'notebook_path' : 'file_path';
      for (const file of ['outside.css', '../escape.css', '..']) {
        const result = await runHook({ ...payload, tool_input: { ...tool_input, [key]: file } }, options);
        assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
      }
    }
    assert.deepEqual(await runHook({ cwd: repo.root, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }, options), {});
  }
  await amendTask(repo, '只读检查', { mode: 'review' });
  for (const host of hosts) {
    const result = await runHook({ cwd: repo.root, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} }, { host });
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /只读/);
  }
});

test('native edits resolve symlinks and subdirectories before boundary checks', async t => {
  const repo = await fixture(t), outside = path.join(path.dirname(repo.root), 'outside');
  await startTask(repo, '改 src', { allowedPaths: ['src/'] });
  await mkdir(outside);
  await symlink(outside, path.join(repo.root, 'src', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await runHook({ cwd: path.join(repo.root, 'src'), hook_event_name: 'PreToolUse',
    tool_name: 'Write', tool_input: { file_path: 'escape/secret.js', content: 'x' } }, { host: 'workbuddy' });
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /工作区之外/);
});

test('Write/Edit/MultiEdit build applicable diffs with real evidence and never write the proposal', async t => {
  const repo = await fixture(t), filename = path.join(repo.root, 'src', 'style.css');
  const before = await readFile(filename, 'utf8');
  for (const [tool_name, input] of [
    ['Write', { content: before.replace('#222', '#f00') }],
    ['Edit', { old_string: '#222', new_string: '#f00' }],
    ['MultiEdit', { edits: [{ old_string: '#222', new_string: 'red' }, { old_string: 'red', new_string: '#f00' }] }],
  ]) {
    const [change] = await toolChanges({ tool_name, tool_input: { file_path: filename, ...input } }, repo, { includeDiff: true });
    const patch = path.join(path.dirname(repo.root), 'proposal.patch');
    await writeFile(patch, change.diff);
    await git(repo.root, ['apply', '--check', patch]);
    const evidence = extractEvidence(change.diff, change.file)[0];
    assert.equal(evidence.before, '#222');
    assert.equal(evidence.after, '#f00');
    assert.equal(evidence.location.line, 2);
    assert.equal(await readFile(filename, 'utf8'), before);
  }
  await assert.rejects(toolChanges({ tool_name: 'Edit', tool_input: { file_path: filename, old_string: 'missing', new_string: 'x' } }, repo, { includeDiff: true }), /未推测/);
  const privateChange = await toolChanges({ tool_name: 'Write', tool_input: { file_path: '.env', content: 'fake-private-value' } }, repo, { includeDiff: true });
  assert.equal(privateChange[0].diff, '');
});

test('native proposal handles file creation, deletion content, repeated edits and trailing newline changes', async t => {
  const repo = await fixture(t), file = path.join(repo.root, 'edge.txt');
  const [addition] = await toolChanges({ tool_name: 'Write', tool_input: { file_path: 'added.txt', content: 'new\n' } }, repo, { includeDiff: true });
  assert.equal(addition.operation, 'Add');
  const addPatch = path.join(path.dirname(repo.root), 'addition.patch');
  await writeFile(addPatch, addition.diff);
  await git(repo.root, ['apply', '--check', addPatch]);
  const [empty] = await toolChanges({ tool_name: 'Write', tool_input: { file_path: "empty ' 中文.txt", content: '' } }, repo, { includeDiff: true });
  await writeFile(addPatch, empty.diff);
  await git(repo.root, ['apply', '--check', addPatch]);
  for (const [before, after] of [['', 'new\n'], ['old\n', ''], ['a\nb\n', 'a\nb'], ['a\nb', 'a\nb\n'], ['a\nx\nx\nz\n', 'a\ny\ny\nz\n']]) {
    await writeFile(file, before);
    const [change] = await toolChanges({ tool_name: 'Write', tool_input: { file_path: file, content: after } }, repo, { includeDiff: true });
    const patch = path.join(path.dirname(repo.root), 'edge.patch');
    await writeFile(patch, change.diff);
    await git(repo.root, ['apply', '--check', patch]);
  }
  await writeFile(file, 'repeat repeat');
  await assert.rejects(toolChanges({ tool_name: 'Edit', tool_input: { file_path: file, old_string: 'repeat', new_string: 'new' } }, repo, { includeDiff: true }), /不唯一/);
  assert.match((await toolChanges({ tool_name: 'Edit', tool_input: { file_path: file, old_string: 'repeat', new_string: 'new', replace_all: true } }, repo, { includeDiff: true }))[0].diff, /\+new new/);
});

test('distant edits do not turn unchanged behavior into extra-change evidence', async t => {
  const repo = await fixture(t), file = path.join(repo.root, "separate ' 中文.js");
  const before = ['const first = 1;', ...Array.from({ length: 12 }, (_, i) => `const middle${i} = ${i};`),
    'setInterval(existingPolling, 1000);', ...Array.from({ length: 12 }, (_, i) => `const tail${i} = ${i};`), 'const last = 1;', ''].join('\n');
  await writeFile(file, before);
  const [change] = await toolChanges({ tool_name: 'MultiEdit', tool_input: { file_path: file,
    edits: [{ old_string: 'first = 1', new_string: 'first = 2' }, { old_string: 'last = 1', new_string: 'last = 2' }] } }, repo, { includeDiff: true });
  assert.equal((change.diff.match(/^@@ /gm) ?? []).length, 2);
  assert.doesNotMatch(change.diff, /existingPolling/);
  const patch = path.join(path.dirname(repo.root), 'distant.patch');
  await writeFile(patch, change.diff);
  await git(repo.root, ['apply', '--check', patch]);
});

test('live native edits surface grounded color evidence, reuse proposals and do not modify files', async t => {
  const repo = await fixture(t);
  await startTask(repo, '只改字体', { reviewMode: 'live' });
  const file = path.join(repo.root, 'src', 'style.css'), original = await readFile(file, 'utf8');
  let calls = 0;
  const options = { host: 'claude-code', apiKey: 'fixture', judgeImpl: async (_task, changes) => {
    calls++;
    return { model: 'fixture', usage: {}, judgments: changes.map(change => ({
      id: change.id, file: change.file, relation: 'extra', requirementId: 'R1', confidence: 0.95,
      conflictId: null, extraKind: 'color', evidenceId: change.evidenceCandidates[0].id, scopeReason: 'independent',
    })) };
  } };
  const payload = { cwd: repo.root, hook_event_name: 'PreToolUse', tool_name: 'Edit',
    tool_input: { file_path: file, old_string: '#222', new_string: '#f00' } };
  const first = await runHook(payload, options);
  assert.equal(first.hookSpecificOutput.permissionDecision, undefined);
  assert.match(first.hookSpecificOutput.additionalContext, /src\/style.css:2/);
  assert.match(first.hookSpecificOutput.additionalContext, /#222 → #f00/);
  assert.deepEqual(await runHook(payload, { ...options, host: 'workbuddy' }), first);
  assert.equal(calls, 1, 'the same proposed diff should reuse the review across hosts');
  assert.equal(await readFile(file, 'utf8'), original);
  const notebook = await runHook({ cwd: repo.root, hook_event_name: 'PreToolUse', tool_name: 'NotebookEdit',
    tool_input: { notebook_path: 'book.ipynb' } }, options);
  assert.match(notebook.systemMessage, /结束时检查/);
  assert.equal(calls, 1);
});

test('hosts share task/report data but notifications do not suppress another client', async t => {
  const repo = await fixture(t);
  await startTask(repo, '只读检查', { mode: 'review' });
  await writeFile(path.join(repo.root, 'src', 'style.css'), '.button { color: red; }\n');
  const report = await checkRepository(repo, { offline: true });
  for (const host of ['codex', ...hosts]) {
    const payload = { cwd: repo.root, hook_event_name: 'Stop', stop_hook_active: true };
    const result = await runHook(payload, { host, offline: true });
    assert.match(result.systemMessage, /src\/style.css/);
    assert.equal(result.decision, undefined);
    assert.equal(result.continue, undefined);
    assert.equal(result.hookSpecificOutput, undefined);
    assert.deepEqual(await runHook(payload, { host, offline: true }), {});
    assert.match(await takeNotice(repo, report, 'chat', host), /Jev Scope/);
    assert.equal(await takeNotice(repo, report, 'chat', host), '');
  }
  await amendTask(repo, '', { reviewMode: 'manual' });
  for (const host of hosts) assert.deepEqual(await runHook({ cwd: repo.root, hook_event_name: 'Stop' }, { host }), {});
  assert.equal((await activeTask(repo)).active, true);
  assert.equal((await readState(repo, 'latest.json')).taskId, report.taskId);
});

test('CLI loads only the selected host key and preserves host in prompt bootstrap', async t => {
  const directory = await temporary(t), repo = await fixture(t);
  for (const host of hosts) {
    const home = path.join(directory, host), paths = configPaths({ host, hostHome: home });
    await install({ host, hostHome: home });
    await put(paths.env, 'OPENROUTER_API_KEY=selected-host-fixture\n');
    const result = await execute(process.execPath, [scopeScript, 'doctor', '--host', host, '--host-home', home, '--json'],
      { env: { OPENROUTER_API_KEY: undefined, CODEX_HOME: path.join(directory, 'no-key-codex') } });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /selected-host-fixture/);
    assert.equal(JSON.parse(result.stdout).host, host);
    const prompt = await runHook({ cwd: repo.root, hook_event_name: 'UserPromptSubmit' }, { host, hostHome: home });
    assert.ok(prompt.hookSpecificOutput.additionalContext.includes(host));
    assert.match(prompt.hookSpecificOutput.additionalContext, /只记录用户原话/);
    assert.equal(await activeTask(repo), null);
  }
});
