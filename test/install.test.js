import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { install, uninstall } from '../src/install.js';
import { configPaths, scopeScript, cliCommand } from '../src/config.js';
import { runHook, takeNotice } from '../src/hooks.js';
import { repository, git } from '../src/repo.js';
import { activeTask, startTask, readState } from '../src/task.js';
import { checkRepository } from '../src/review.js';

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'jev-global-test-'));
  t.after(async () => {
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(tmpdir()));
    assert.ok(path.basename(target).startsWith('jev-global-test-'));
    await rm(target, { recursive: true, force: true });
  });
  return directory;
}

async function put(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
}

const json = async file => JSON.parse(await readFile(file, 'utf8'));
const handlers = config => Object.values(config.hooks ?? {}).flatMap(groups => groups.flatMap(group => group.hooks));

function execute(args, { cwd, env = {}, input = '', executable = process.execPath } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true,
      env: { ...process.env, OPENROUTER_API_KEY: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('global install is idempotent; uninstall restores foreign hooks and retains credentials', async t => {
  const home = await temporary(t);
  const paths = configPaths(home);
  const foreign = { description: 'User configuration', hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'echo existing', timeout: 8 }] }],
    SessionStart: [],
  } };
  const original = JSON.stringify(foreign, null, 4);
  await put(paths.hooks, original);
  await put(paths.env, 'OPENROUTER_API_KEY=fixture-private-value\n');
  const first = await install({ codexHome: home });
  assert.equal(first.changed, true);
  assert.equal(await readFile(first.backup, 'utf8'), original);
  const installed = await json(paths.hooks);
  assert.equal(handlers(installed).length, 4);
  assert.deepEqual(installed.hooks.Stop[0], foreign.hooks.Stop[0]);
  const second = await install({ codexHome: home });
  assert.equal(second.changed, false);
  assert.equal(second.backup, null);
  assert.deepEqual(await json(paths.hooks), installed);
  assert.equal((await uninstall({ codexHome: home })).preserved, 0);
  assert.deepEqual(await json(paths.hooks), foreign);
  assert.equal(await readFile(paths.env, 'utf8'), 'OPENROUTER_API_KEY=fixture-private-value\n');
  assert.equal((await uninstall({ codexHome: home })).changed, false);
});

test('later foreign handlers and new metadata survive repeat install and uninstall', async t => {
  const home = await temporary(t);
  const paths = configPaths(home);
  await install({ codexHome: home });
  const current = await json(paths.hooks);
  current.description = 'Added after installation';
  const foreign = { type: 'command', command: 'echo another' };
  current.hooks.Stop[0].hooks.push(foreign);
  current.hooks.Stop.push({ hooks: [foreign] });
  await put(paths.hooks, current);
  assert.equal((await install({ codexHome: home })).changed, false);
  await uninstall({ codexHome: home });
  assert.deepEqual(await json(paths.hooks), { description: current.description,
    hooks: { Stop: [{ hooks: [foreign] }, { hooks: [foreign] }] } });
});

test('fresh install cleans up its hook file; malformed config and manifest fail without rewriting it', async t => {
  const home = await temporary(t);
  const paths = configPaths(home);
  await install({ codexHome: home });
  assert.equal(handlers(await json(paths.hooks)).length, 3);
  await uninstall({ codexHome: home });
  await assert.rejects(readFile(paths.hooks), { code: 'ENOENT' });
  for (const malformed of ['{ broken json', '[]', '{"hooks":[]}', '{"hooks":{"Stop":[{"hooks":null}]}}']) {
    await put(paths.hooks, malformed);
    await assert.rejects(install({ codexHome: home }), /原文件未作修改/);
    assert.equal(await readFile(paths.hooks, 'utf8'), malformed);
  }
  await put(paths.hooks, '{}');
  await put(paths.manifest, '{broken');
  await assert.rejects(install({ codexHome: home }), /安装记录损坏/);
  await assert.rejects(uninstall({ codexHome: home }), /安装记录损坏/);
  assert.equal(await readFile(paths.hooks, 'utf8'), '{}');
});

test('upgrade replaces the old installation path without accumulating hooks', async t => {
  const home = await temporary(t);
  await install({ codexHome: home, script: path.join(home, 'old installation', 'scope.js') });
  const updated = await install({ codexHome: home, script: scopeScript });
  assert.equal(updated.changed, true);
  const config = await json(configPaths(home).hooks);
  assert.equal(handlers(config).length, 3);
  assert.doesNotMatch(JSON.stringify(config), /old installation/);
  await uninstall({ codexHome: home });
  await assert.rejects(readFile(configPaths(home).hooks), { code: 'ENOENT' });
});

test('edited owned hooks are not overwritten or silently removed', async t => {
  const home = await temporary(t);
  const paths = configPaths(home);
  await install({ codexHome: home });
  const config = await json(paths.hooks);
  config.hooks.Stop[0].hooks[0].timeout = 17;
  config.hooks.PreToolUse[0].matcher = '^custom$';
  await put(paths.hooks, config);
  await assert.rejects(install({ codexHome: home }), /手动修改/);
  assert.deepEqual(await json(paths.hooks), config);
  assert.equal((await uninstall({ codexHome: home })).preserved, 2);
  const after = await json(paths.hooks);
  assert.equal(handlers(after).length, 2);
  assert.equal(after.hooks.Stop[0].hooks[0].timeout, 17);
  assert.equal(after.hooks.PreToolUse[0].matcher, '^custom$');
});

test('interrupted upgrade registration can recover and uninstall either generation', async t => {
  const home = await temporary(t);
  const paths = configPaths(home);
  await install({ codexHome: home });
  const state = await json(paths.manifest);
  state.registrations.push(...structuredClone(state.registrations));
  state.registrations[3].group.hooks[0].command = "'old-node' 'old-scope' 'hook'";
  await put(paths.manifest, state);
  assert.equal((await install({ codexHome: home })).changed, false);
  assert.equal((await json(paths.manifest)).registrations.length, 3);
  await uninstall({ codexHome: home });
  await assert.rejects(readFile(paths.hooks), { code: 'ENOENT' });
});

test('uninstall flags rewritten commands without claiming to identify or remove them', async t => {
  const home = await temporary(t);
  const paths = configPaths(home);
  await install({ codexHome: home });
  const config = await json(paths.hooks);
  config.hooks.Stop[0].hooks[0].command = 'echo user-replacement';
  await put(paths.hooks, config);
  const result = await uninstall({ codexHome: home });
  assert.equal(result.unmatched, 1);
  assert.equal((await json(paths.hooks)).hooks.Stop[0].hooks[0].command, 'echo user-replacement');
});

test('CLI honors CODEX_HOME from any cwd and doctor never emits a configured key', async t => {
  const directory = await temporary(t);
  const home = path.join(directory, 'custom home');
  const env = { CODEX_HOME: home, OPENROUTER_API_KEY: 'fixture-secret-not-for-output' };
  const result = await execute([scopeScript, 'install', '--json'], { cwd: directory, env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hooksPath, configPaths(home).hooks);
  const diagnostic = await execute([scopeScript, 'doctor', '--json'], { cwd: directory, env });
  assert.equal(diagnostic.code, 0, diagnostic.stderr);
  assert.equal(JSON.parse(diagnostic.stdout).ok, true);
  assert.doesNotMatch(diagnostic.stdout + diagnostic.stderr, /fixture-secret-not-for-output/);
  const missingGit = await execute([scopeScript, 'doctor', '--json'], { cwd: directory, env: { ...env, PATH: '' } });
  assert.equal(missingGit.code, 1);
  assert.equal(JSON.parse(missingGit.stdout).checks.find(check => check.name === 'Git').ok, false);
  assert.equal((await execute([scopeScript, 'uninstall', '--codex-home', home], { cwd: directory })).code, 0);
});

test('user env persists independently of the package; process env wins and target env is never loaded', async t => {
  const directory = await temporary(t);
  const home = path.join(directory, 'home');
  const project = path.join(directory, 'project');
  const installed = path.join(directory, 'tool');
  await mkdir(installed);
  // A clean distributable copy has no developer .env to fall back to.
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const name of ['bin', 'src']) await cp(path.join(root, name), path.join(installed, name), { recursive: true });
  await put(path.join(installed, 'package.json'), { type: 'module' });
  await put(path.join(project, '.env'), 'OPENROUTER_API_KEY=target-project-secret\n');
  await put(configPaths(home).env, 'OPENROUTER_API_KEY=user-fixture-key\nJEV_MODEL=user-model\n');
  const probe = `import { loadEnvironment } from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)}; loadEnvironment(process.argv[1]); console.log(JSON.stringify({model:process.env.JEV_MODEL}));`;
  const inherited = { ...process.env, CODEX_HOME: home };
  delete inherited.OPENROUTER_API_KEY;
  delete inherited.JEV_MODEL;
  // execute() supplies an explicit empty key; verify a subprocess without that default too.
  const result = await execute(['--input-type=module', '-e', probe, home], { cwd: project, env: { ...inherited, JEV_MODEL: 'environment-model' } });
  assert.equal(JSON.parse(result.stdout).model, 'environment-model');
  const cli = path.join(installed, 'bin', 'scope.js');
  await execute([cli, 'install', '--codex-home', home], { cwd: project });
  const userConfigured = await execute([cli, 'doctor', '--json', '--codex-home', home],
    { cwd: project, env: { OPENROUTER_API_KEY: undefined } });
  assert.equal(JSON.parse(userConfigured.stdout).checks.find(check => check.name === 'OpenRouter 密钥').ok, true);
  await rm(configPaths(home).env);
  const noUserKey = await execute([cli, 'doctor', '--json', '--codex-home', home],
    { cwd: project, env: { OPENROUTER_API_KEY: undefined } });
  assert.equal(JSON.parse(noUserKey.stdout).checks.find(check => check.name === 'OpenRouter 密钥').ok, false);
  assert.doesNotMatch(noUserKey.stdout, /target-project-secret/);
});

test('installed command works through the native shell in paths containing spaces, quotes and dollars', async t => {
  const directory = await temporary(t);
  const home = path.join(directory, "配置 space's $literal `tick");
  const root = path.join(directory, "tool's $literal space");
  const script = path.join(root, 'entry.js');
  // Lightweight executable fixture verifies argv boundaries without executing path contents.
  await put(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  await install({ codexHome: home, script });
  const config = await json(configPaths(home).hooks);
  const handler = config.hooks.Stop[0].hooks[0];
  const command = process.platform === 'win32' ? handler.commandWindows : handler.command;
  const result = await execute(process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command],
    { cwd: directory, executable: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh' });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['hook', '--codex-home', home]);
});

test('one installation bootstraps two unrelated projects without AGENTS files or task side effects', async t => {
  const directory = await temporary(t);
  const home = path.join(directory, 'codex');
  await install({ codexHome: home });
  for (const name of ['first project', 'second-project']) {
    const project = path.join(directory, name);
    await mkdir(project);
    await git(project, ['init', '-q']);
    const repo = await repository(project);
    const payload = { hook_event_name: 'UserPromptSubmit', cwd: project, prompt: '解释一下这段代码' };
    const result = await execute([scopeScript, 'hook', '--codex-home', home], { cwd: directory, input: JSON.stringify(payload) });
    assert.equal(result.code, 0, result.stderr);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /没有活动任务/);
    assert.match(context, /问答和只读浏览无需建立任务/);
    assert.match(context, /先 finish 再 start/);
    assert.match(context, /check --for-chat/);
    assert.ok(context.includes(cliCommand(['--cwd', repo.root], { codexHome: home })));
    assert.equal(await activeTask(repo), null);
    assert.equal((await readdir(project)).includes('AGENTS.md'), false);
    await startTask(repo, `修改 ${name} 的字体`);
    const active = await runHook(payload, { codexHome: home });
    assert.match(active.hookSpecificOutput.additionalContext, new RegExp(name));
    assert.doesNotMatch(active.hookSpecificOutput.additionalContext, new RegExp(name === 'first project' ? 'second-project' : 'first project'));
  }
});

test('global hooks are quiet outside Git and when Git is unavailable; no tasks or repos are created', async t => {
  const directory = await temporary(t);
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'Stop']) {
    assert.deepEqual(await runHook({ cwd: directory, hook_event_name: event }), {});
  }
  const result = await execute([scopeScript, 'hook'], { cwd: directory, env: { PATH: '' },
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: directory }) });
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.deepEqual(await readdir(directory), []);
});

test('concurrent delivery from local and global hooks only emits one notice', async t => {
  const directory = await temporary(t);
  await git(directory, ['init', '-q']);
  const repo = await repository(directory);
  await startTask(repo, '只审查', { mode: 'review' });
  await put(path.join(directory, 'changed.js'), 'const extra = true;\n');
  const report = await checkRepository(repo, { offline: true });
  const notices = await Promise.all([takeNotice(repo, report), takeNotice(repo, report), takeNotice(repo, report)]);
  assert.equal(notices.filter(Boolean).length, 1);
  assert.equal((await readState(repo, 'notification.json')).taskId, report.taskId);
});
