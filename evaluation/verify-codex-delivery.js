// Explicit paid Jev evaluation. Codex uses a local deterministic Responses fixture;
// no coding model is called, no tools run, and no chat is saved in the user's app.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git, repository, snapshot } from '../src/repo.js';
import { startTask, readState } from '../src/task.js';
import { hookConfiguration } from '../src/hooks.js';
import { workflowCases } from './workflow-cases.js';
import { connect, executable } from './codex-rpc.js';

if (!process.argv.includes('--live')) {
  console.log('Use --live to test real Jev warnings through the installed Codex host with disposable fixtures.');
  process.exit(0);
}
const project = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), 'jev-codex-delivery-'));
const taskHome = path.join(root, 'codex-home');
await mkdir(taskHome);
const scenarios = ['font-with-color', 'bare-font-with-autocheck', 'font-family'].map(id => workflowCases.find(item => item.id === id));
const expectedLabels = { 'font-with-color': '修改配色', 'bare-font-with-autocheck': '增加自动执行' };
const source = {};
for (const folder of ['web', 'src', 'bin']) {
  for (const name of await readdir(path.join(project, folder))) {
    if (/\.(?:js|css|html|svg)$/.test(name)) source[`${folder}/${name}`] = (await readFile(path.join(project, folder, name), 'utf8')).replaceAll('\r\n', '\n');
  }
}
source['package.json'] = await readFile(path.join(project, 'package.json'), 'utf8');
const fixtures = [];
for (const scenario of scenarios) {
  const cwd = path.join(root, scenario.id);
  await mkdir(path.join(cwd, '.codex'), { recursive: true });
  for (const [file, text] of Object.entries(source)) {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await writeFile(path.join(cwd, file), text);
  }
  await writeFile(path.join(cwd, '.gitignore'), '.codex/\n');
  await writeFile(path.join(cwd, '.codex/hooks.json'), JSON.stringify(hookConfiguration()));
  await git(cwd, ['init', '-q']);
  await git(cwd, ['config', 'core.autocrlf', 'false']);
  const repo = await repository(cwd);
  await startTask(repo, scenario.prompt, { constraints: scenario.constraints });
  for (const [file, text] of Object.entries(scenario.edit(source))) await writeFile(path.join(cwd, file), text);
  fixtures.push({ scenario, cwd, repo, tree: await snapshot(repo), index: await git(cwd, ['diff', '--cached']) });
}

let requests = 0;
const server = createServer(async (req, res) => {
  for await (const _chunk of req) { /* Consume without recording prompts or headers. */ }
  if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404).end(); return; }
  if (++requests > 8) { res.writeHead(400).end('Unexpected model continuation'); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let sequence = 0;
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  const id = `response_fixture_${requests}`, itemId = `message_fixture_${requests}`;
  const text = '测试轮次结束。';
  const part = { type: 'output_text', text, annotations: [] };
  const item = { id: itemId, type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', content: [part] };
  const where = { output_index: 0, item_id: itemId, content_index: 0 };
  emit('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
  emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  emit('response.content_part.added', { ...where, part: { ...part, text: '' } });
  emit('response.output_text.delta', { ...where, delta: text });
  emit('response.output_text.done', { ...where, text });
  emit('response.content_part.done', { ...where, part });
  emit('response.output_item.done', { output_index: 0, item });
  emit('response.completed', { response: { id, object: 'response', status: 'completed', output: [item],
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
  res.end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const config = [
  'model = "fixture"', 'model_provider = "fixture"', 'approval_policy = "never"', 'sandbox_mode = "workspace-write"',
  '[model_providers.fixture]', 'name = "Local deterministic delivery fixture"',
  `base_url = "http://127.0.0.1:${server.address().port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
  '[analytics]', 'enabled = false',
  ...fixtures.flatMap(({ cwd }) => [`[projects.${JSON.stringify(cwd)}]`, 'trust_level = "trusted"']), '',
].join('\n');
await writeFile(path.join(taskHome, 'config.toml'), config);
const environment = { ...process.env, CODEX_HOME: taskHome, OPENAI_API_KEY: 'fixture-only-not-a-real-key' };
// Keep the deterministic local model request on loopback even when the host uses an HTTP proxy.
environment.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
environment.no_proxy = environment.NO_PROXY;
delete environment.CODEX_THREAD_ID;
let client;
const output = { checkedAt: new Date().toISOString(), executable,
  methodology: 'Installed Codex app-server, isolated config and ephemeral threads, deterministic local Responses stream, real Jev Stop command on real UI copies. Observe warning entries in native hook/completed events before turn/completed.',
  limitations: 'Tests native host delivery, not pixel rendering in the active desktop window or coding-model behavior.', results: [] };
const outputPath = path.join(project, 'evaluation/codex-delivery-latest.json');
const waitFor = async (predicate, timeout = 55000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for the Codex turn to finish.');
};
try {
  client = await connect({ cwd: root, env: environment });
  const inventory = await client.request('hooks/list', { cwds: fixtures.map(item => item.cwd) });
  const state = {};
  for (const entry of inventory.data) {
    const file = path.join(entry.cwd, '.codex/hooks.json');
    if (!fixtures.some(item => item.cwd === entry.cwd)) throw new Error('Unexpected fixture hook source.');
    for (const hook of entry.hooks) {
      if (hook.sourcePath !== file || hook.handlerType !== 'command' || !hook.command.includes('scope.js')) throw new Error('Unexpected fixture hook definition.');
      state[hook.key] = { trusted_hash: hook.currentHash };
    }
    assert.equal(entry.hooks.length, 3);
  }
  await client.request('config/batchWrite', { edits: [{ keyPath: 'hooks.state', value: state, mergeStrategy: 'replace' }], reloadUserConfig: true });
  for (const fixture of fixtures) {
    const { scenario, cwd, repo } = fixture;
    const started = await client.request('thread/start', { cwd, ephemeral: true, model: 'fixture', modelProvider: 'fixture',
      approvalPolicy: 'never', sandbox: 'workspace-write', baseInstructions: 'Return the fixture response without tools.' });
    const threadId = started.thread.id;
    const runs = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      const offset = client.events.length;
      const turn = await client.request('turn/start', { threadId, input: [{ type: 'text', text: scenario.prompt, text_elements: [] }] });
      const turnId = turn.turn.id;
      const finished = await waitFor(() => client.events.slice(offset).find(event => event.method === 'turn/completed' && event.params.turn.id === turnId));
      const events = client.events.slice(offset).filter(event => event.params?.threadId === threadId || event.params?.thread_id === threadId);
      const hook = events.find(event => event.method === 'hook/completed' && event.params.run.eventName === 'stop');
      const warnings = events.filter(event => event.method === 'warning' && JSON.stringify(event.params).includes('Jev Scope'));
      assert.equal(finished.params.turn.status, 'completed');
      assert.ok(hook, `Stop did not execute for ${scenario.id}`);
      const messages = hook.params.run.entries.filter(entry => entry.kind === 'warning').map(entry => entry.text);
      const expected = !repeat && scenario.kind === 'extra';
      assert.equal(messages.length > 0, expected, `${scenario.id}: unexpected hook notice state`);
      // App-server v2 carries systemMessage as a warning entry in hook/completed;
      // it need not duplicate that entry as a standalone warning notification.
      assert.ok(events.indexOf(hook) < events.indexOf(finished), 'Hook completion followed turn completion');
      if (expected) {
        assert.ok(messages.some(message => message.includes(expectedLabels[scenario.id])), `${scenario.id}: wrong notice label`);
        assert.ok(warnings.every(warning => warning.at <= finished.at), 'Warning was delayed beyond this turn');
      }
      runs.push({ repeat: !!repeat, turnStatus: finished.params.turn.status, hookStatus: hook.params.run.status,
        executionMode: hook.params.run.executionMode, durationMs: hook.params.run.durationMs, messages,
        nativeWarnings: warnings.map(event => event.params),
        sequence: events.filter(event => ['item/completed', 'hook/started', 'hook/completed', 'warning', 'turn/completed'].includes(event.method))
          .map(event => ({ method: event.method, at: event.at, eventName: event.params?.run?.eventName, itemType: event.params?.item?.type })) });
    }
    const report = await readState(repo, 'latest.json');
    assert.equal(report.semantic, 'complete');
    const chatArgs = [path.join(project, 'bin/scope.js'), 'check', '--for-chat', '--cwd', cwd];
    const chat = await exec(process.execPath, chatArgs, { windowsHide: true, timeout: 35000 });
    const repeatedChat = await exec(process.execPath, chatArgs, { windowsHide: true, timeout: 35000 });
    assert.equal(chat.stdout.trim(), runs[0].messages.join('\n'));
    assert.equal(repeatedChat.stdout, '');
    assert.equal(await snapshot(repo), fixture.tree);
    assert.equal(await git(cwd, ['diff', '--cached']), fixture.index);
    const result = { id: scenario.id, prompt: scenario.prompt, passed: true, runs, semantic: report.semantic,
      findings: report.findings, model: report.model, usage: report.usage, filesAndIndexPreserved: true,
      finalAnswerNotice: chat.stdout.trim() || null, repeatedFinalAnswerNotice: repeatedChat.stdout || null };
    output.results.push(result);
    await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
    console.log(JSON.stringify({ id: scenario.id, passed: true, firstNotice: runs[0].messages, repeatNotice: runs[1].messages,
      beforeTurnEnd: true, executionMode: runs[0].executionMode, finalAnswerNotice: result.finalAnswerNotice }));
    await client.request('thread/unsubscribe', { threadId });
  }
  assert.equal(requests, scenarios.length * 2, 'Unexpected automatic continuation');
  output.summary = { scenarios: output.results.length, passed: output.results.length, modelRequests: requests,
    automaticContinuations: 0, warningsBeforeTurnEnd: true, duplicateWarnings: 0, finalAnswerNoticesVerified: true,
    totalJevCost: output.results.reduce((sum, result) => sum + (result.usage?.cost ?? 0), 0) };
  await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output.summary));
} catch (error) {
  output.error = error.message;
  output.localModelRequests = requests;
  output.observedMethods = [...new Set(client?.events.map(event => event.method).filter(Boolean))];
  output.failureEvents = client?.events.filter(event => ['error', 'warning', 'hook/completed', 'turn/completed'].includes(event.method));
  await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
  throw error;
} finally {
  await client?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  const resolved = await realpath(root);
  const temp = await realpath(tmpdir());
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('jev-codex-delivery-')) throw new Error('Unexpected fixture cleanup path.');
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
