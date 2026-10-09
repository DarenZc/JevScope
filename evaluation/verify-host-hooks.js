// Optional real-client test with disposable profiles and a deterministic loopback
// model. No user credentials, settings, paid inference or project data are used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { install, uninstall } from '../src/install.js';
import { cliCommand } from '../src/config.js';
import { resolveHost } from '../src/hosts.js';
import { repository, git } from '../src/repo.js';
import { startTask, readState } from '../src/task.js';

const { values } = parseArgs({ options: { host: { type: 'string', default: 'claude-code' } } });
const host = resolveHost(values.host);
if (host.id === 'codex') throw new Error('Use npm run verify:codex for the Codex app-server test.');
const claude = host.id === 'claude-code';
const binary = claude ? process.env.JEV_CLAUDE_BINARY ?? (process.platform === 'win32'
  ? path.join(process.env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe') : 'claude')
  : host.id === 'workbuddy' ? process.env.JEV_WORKBUDDY_CLI ?? (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA, 'Programs/WorkBuddyAI/resources/app.asar.unpacked/cli/dist/codebuddy.js') : '')
    : process.env.JEV_CODEBUDDY_CLI;
if (!binary) throw new Error(`Set ${host.id === 'workbuddy' ? 'JEV_WORKBUDDY_CLI' : 'JEV_CODEBUDDY_CLI'} to the installed CLI .js or executable.`);
const temp = await mkdtemp(path.join(tmpdir(), 'jev-native-host-'));
const home = path.join(temp, 'home'), project = path.join(temp, 'project');
let stage = 0, round = 'stop', requests = 0, bootstrap = false, denialSeen = false, noticeSeen = false;
let cliNotice = '', server;
const model = claude ? 'claude-sonnet-4-6' : 'jev-local-fixture';

function response(body) {
  requests++;
  assert.ok(requests <= 6, 'Unexpected continuation or fallback model request');
  const text = JSON.stringify(body);
  bootstrap ||= text.includes('Jev Scope') && text.includes('check --for-chat') && text.includes(host.id);
  if (stage++ === 0) return round === 'stop'
    ? { name: 'Write', input: { file_path: path.join(project, 'blocked.js'), content: 'must never be written\n' } }
    : { name: 'Bash', input: { command: `${cliCommand(['--cwd', project.replaceAll('\\', '/'), 'check', '--for-chat', '--offline'],
      { host: host.id, hostHome: home, platform: 'posix' })}` } };
  if (round === 'stop') {
    denialSeen = text.includes('Jev Scope') && text.includes('超出显式允许的文件范围');
    assert.ok(denialSeen, 'Native PreToolUse denial did not reach the model');
    return { text: 'Fixture complete.' };
  }
  // The deterministic model echoes only the check command's tool result, just as
  // the bootstrap requests. This validates delivery, not an LLM's compliance rate.
  const messages = body.messages ?? [];
  const contents = messages.flatMap(message => Array.isArray(message.content) ? message.content : [{ type: message.role, text: message.content }]);
  const result = contents.filter(item => item.type === 'tool_result' || item.type === 'tool')
    .map(item => typeof item.content === 'string' ? item.content : typeof item.text === 'string' ? item.text : JSON.stringify(item.content ?? ''))
    .find(value => value.includes('Jev Scope') && value.includes('extra.js'));
  assert.ok(result, 'The final-answer CLI notice did not reach the model');
  cliNotice = result;
  noticeSeen = true;
  return { text: `Fixture complete.\n\n${result}` };
}

function anthropic(res, body, output) {
  const content = output.name ? { type: 'tool_use', id: `tool_${requests}`, name: output.name, input: output.input }
    : { type: 'text', text: output.text };
  const stop = output.name ? 'tool_use' : 'end_turn';
  const message = { id: `msg_${requests}`, type: 'message', role: 'assistant', model: body.model,
    content: [content], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
  if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
  res.setHeader('content-type', 'text/event-stream');
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { ...message, content: [], stop_reason: null } });
  send('content_block_start', { index: 0, content_block: output.name ? { ...content, input: {} } : { type: 'text', text: '' } });
  send('content_block_delta', { index: 0, delta: output.name ? { type: 'input_json_delta', partial_json: JSON.stringify(output.input) }
    : { type: 'text_delta', text: output.text } });
  send('content_block_stop', { index: 0 });
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } });
  send('message_stop', {}); res.end();
}

function openai(res, body, output) {
  const delta = output.name ? { role: 'assistant', tool_calls: [{ index: 0, id: `tool_${requests}`, type: 'function',
    function: { name: output.name, arguments: JSON.stringify(output.input) } }] } : { role: 'assistant', content: output.text };
  const stop = output.name ? 'tool_calls' : 'stop';
  const base = { id: `chatcmpl_${requests}`, created: 1, model: body.model };
  if (!body.stream) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: delta, finish_reason: stop }] })); return;
  }
  res.setHeader('content-type', 'text/event-stream');
  const send = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason }], usage: finish_reason ? { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } : undefined })}\n\n`);
  send(delta, null); send({}, stop); res.end('data: [DONE]\n\n');
}

async function run(base) {
  const args = ['-p', `Verify Jev Scope ${round} delivery in this disposable fixture.`, '--model', model,
    '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--allowedTools', 'Bash'];
  if (claude) args.push('--no-session-persistence', '--tools', 'Write,Bash', '--max-turns', '3');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: home,
    CODEBUDDY_CONFIG_DIR: home, WORKBUDDY_CONFIG_DIR: home, ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: 'local-fixture', ANTHROPIC_AUTH_TOKEN: '', CODEBUDDY_BASE_URL: base,
    CODEBUDDY_API_KEY: 'local-fixture', OPENAI_API_KEY: 'local-fixture', OPENROUTER_API_KEY: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1', CODEBUDDY_PROMPT_SUGGESTION_DISABLED: '1',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  delete env.CLAUDECODE;
  const js = /\.[cm]?js$/i.test(binary);
  const child = spawn(js ? process.execPath : binary, js ? [binary, ...args] : args,
    { cwd: project, env, windowsHide: true, timeout: 55000, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, `${host.name} failed: ${stderr.slice(-1500)}\n${stdout.slice(-1500)}`);
  const events = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  const result = events.findLast(event => event.type === 'result');
  assert.ok(result && !result.is_error, `${host.name} did not complete: ${stdout.slice(-1500)}`);
  return result.result;
}

try {
  await mkdir(home); await mkdir(project); await git(project, ['init', '-q']);
  await writeFile(path.join(project, 'allowed.js'), 'original\n');
  const repo = await repository(project);
  await startTask(repo, '只修改 allowed.js', { allowedPaths: ['allowed.js'] });
  await writeFile(path.join(project, 'extra.js'), 'unexpected();\n');
  await install({ host: host.id, hostHome: home });
  let serverError;
  server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (req.url.includes('count_tokens')) { res.end('{"input_tokens":100}'); return; }
      if (req.method === 'POST' && (req.url.includes('/messages') || req.url.includes('/chat/completions'))) {
        const body = JSON.parse(raw), output = response(body);
        (claude ? anthropic : openai)(res, body, output);
      } else { res.setHeader('content-type', 'application/json'); res.end('{}'); }
    } catch (error) { serverError = error; res.writeHead(400).end('Local fixture assertion failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  if (!claude) await writeFile(path.join(home, 'models.json'), JSON.stringify({ models: [{ id: model, name: 'Local fixture',
    vendor: 'OpenAI', apiKey: 'local-fixture', maxInputTokens: 200000, maxOutputTokens: 4096,
    url: `${base}/v1/chat/completions`, supportsToolCall: true, relatedModels: { lite: model, reasoning: model, subagent: model } }], availableModels: [model] }));
  await run(base);
  if (serverError) throw serverError;
  assert.ok(bootstrap && denialSeen);
  await assert.rejects(readFile(path.join(project, 'blocked.js')), { code: 'ENOENT' });
  assert.ok((await readState(repo, 'latest.json')).findings.some(item => item.file === 'extra.js'));
  assert.ok(await readState(repo, `${host.id}-notification.json`));
  assert.equal(requests, 2, 'Stop must not trigger an extra model turn');
  console.log(`${host.name}: UserPromptSubmit, native Write denial and non-blocking Stop passed.`);
  round = 'chat'; stage = 0;
  const final = await run(base);
  if (serverError) throw serverError;
  assert.ok(noticeSeen && final.includes(cliNotice) && final.startsWith('Fixture complete.\n\n'));
  assert.ok(await readState(repo, `${host.id}-chat-notification.json`));
  assert.equal(requests, 4);
  await uninstall({ host: host.id, hostHome: home });
  console.log(`${host.name}: check --for-chat appeared after normal final text; no Stop continuation. All model traffic used loopback.`);
} finally {
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  const target = path.resolve(temp);
  assert.equal(path.dirname(target), path.resolve(tmpdir()));
  assert.ok(path.basename(target).startsWith('jev-native-host-'));
  await rm(target, { recursive: true, force: true });
}
