// Optional real-host smoke test. Uses disposable configuration, a loopback model
// fixture and an empty OpenRouter key. Never grants trust in the user's Codex home.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, uninstall } from '../src/install.js';
import { git, repository } from '../src/repo.js';
import { activeTask, startTask } from '../src/task.js';
import { connect, executable } from './codex-rpc.js';

const root = await mkdtemp(path.join(tmpdir(), 'jev-global-host-'));
const home = path.join(root, 'codex-home');
const projects = [path.join(root, 'first project'), path.join(root, '第二个项目')];
const promptsSeen = [];
let client, server;
const waitFor = async predicate => {
  const deadline = Date.now() + 55000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for Codex. Check that this executable supports Hooks.');
};

try {
  for (const project of projects) { await mkdir(project); await git(project, ['init', '-q']); }
  const installed = await install({ codexHome: home });
  assert.equal((await install({ codexHome: home })).changed, false);
  const hookFile = JSON.parse(await readFile(installed.hooksPath, 'utf8'));
  const commands = Object.values(hookFile.hooks).flatMap(groups => groups.flatMap(group => group.hooks
    .flatMap(handler => [handler.command, handler.commandWindows].filter(Boolean))));

  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404).end(); return; }
    promptsSeen.push(body);
    if (promptsSeen.length > 4) { res.writeHead(400).end('Unexpected continuation'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    let sequence = 0;
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
    const id = `global_fixture_${promptsSeen.length}`, itemId = `message_${promptsSeen.length}`;
    const text = 'Fixture complete.';
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
  await writeFile(path.join(home, 'config.toml'), [
    'model = "fixture"', 'model_provider = "fixture"', 'approval_policy = "never"', 'sandbox_mode = "workspace-write"',
    '[model_providers.fixture]', 'name = "Local global-hook fixture"',
    `base_url = "http://127.0.0.1:${server.address().port}/v1"`, 'wire_api = "responses"', 'requires_openai_auth = false',
    '[analytics]', 'enabled = false', '',
  ].join('\n'));
  const env = { ...process.env, CODEX_HOME: home, OPENROUTER_API_KEY: '', OPENAI_API_KEY: 'local-fixture-only',
    NO_PROXY: [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',') };
  env.no_proxy = env.NO_PROXY;
  delete env.CODEX_THREAD_ID;
  client = await connect({ cwd: root, env });
  const inventory = await client.request('hooks/list', { cwds: projects });
  const state = {};
  for (const entry of inventory.data) {
    assert.ok(projects.includes(entry.cwd));
    const hooks = entry.hooks.filter(hook => path.resolve(hook.sourcePath) === path.resolve(installed.hooksPath));
    assert.equal(hooks.length, 3, 'Global hooks were not discovered from both projects.');
    for (const hook of hooks) {
      assert.ok(commands.includes(hook.command), 'Unexpected fixture hook definition.');
      assert.notEqual(hook.trustStatus, 'trusted', 'Installer must not grant trust.');
      state[hook.key] = { trusted_hash: hook.currentHash };
    }
  }
  assert.equal(inventory.data.length, 2);
  // Trust only the definitions just generated and verified in this disposable home.
  await client.request('config/batchWrite', { edits: [{ keyPath: 'hooks.state', value: state, mergeStrategy: 'replace' }], reloadUserConfig: true });
  const results = [];
  for (let i = 0; i < projects.length; i++) {
    const cwd = projects[i];
    const repo = await repository(cwd);
    if (i === 1) {
      await startTask(repo, '只审查，不修改代码', { mode: 'review' });
      await writeFile(path.join(cwd, 'extra.js'), 'const unexpected = true;\n');
    }
    const started = await client.request('thread/start', { cwd, ephemeral: true, model: 'fixture', modelProvider: 'fixture',
      approvalPolicy: 'never', sandbox: 'workspace-write', baseInstructions: 'Return the fixture response without tools.' });
    const threadId = started.thread.id;
    const offset = client.events.length;
    const turn = await client.request('turn/start', { threadId, input: [{ type: 'text', text: '解释当前任务', text_elements: [] }] });
    const finished = await waitFor(() => client.events.slice(offset).find(event => event.method === 'turn/completed'
      && event.params.turn.id === turn.turn.id));
    assert.equal(finished.params.turn.status, 'completed');
    const events = client.events.slice(offset).filter(event => event.params?.threadId === threadId || event.params?.thread_id === threadId);
    const promptHook = events.find(event => event.method === 'hook/completed' && event.params.run.eventName === 'userPromptSubmit');
    const stop = events.find(event => event.method === 'hook/completed' && event.params.run.eventName === 'stop');
    assert.ok(promptHook, 'Global UserPromptSubmit did not execute.');
    assert.ok(stop, 'Global Stop did not execute.');
    assert.match(promptsSeen.at(-1), /check --for-chat/);
    const notices = stop.params.run.entries.filter(entry => entry.kind === 'warning').map(entry => entry.text);
    assert.equal(notices.length > 0, i === 1);
    if (i === 1) assert.match(notices.join('\n'), /extra\.js/);
    else assert.equal(await activeTask(repo), null, 'Q&A must not auto-create a task.');
    assert.ok(events.indexOf(stop) < events.indexOf(finished));
    results.push({ project: i + 1, discoveredHooks: 3, bootstrapReachedModel: true,
      stopCompletedBeforeTurn: true, localRuleNotice: notices.length > 0 });
    console.log(`Project ${i + 1}: global bootstrap and Stop passed.`);
  }
  await uninstall({ codexHome: home });
  const after = await client.request('hooks/list', { cwds: projects });
  assert.ok(after.data.every(entry => !entry.hooks.some(hook => path.resolve(hook.sourcePath) === path.resolve(installed.hooksPath))));
  const output = { checkedAt: new Date().toISOString(), executable: path.basename(executable), passed: true,
    methodology: 'Real Codex app-server, isolated user config, two temporary Git projects, local deterministic model, no paid API.',
    limitations: 'Tests host discovery, context delivery and local-rule warnings; not model compliance, semantic accuracy or desktop rendering.', results };
  await writeFile(fileURLToPath(new URL('./global-install-latest.json', import.meta.url)), `${JSON.stringify(output, null, 2)}\n`);
  console.log('Global install, cross-project delivery and uninstall passed. User configuration was not changed.');
} finally {
  if (client) await client.close();
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  const target = path.resolve(root);
  assert.equal(path.dirname(target), path.resolve(tmpdir()));
  assert.ok(path.basename(target).startsWith('jev-global-host-'));
  await rm(target, { recursive: true, force: true });
}
