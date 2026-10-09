import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const executable = process.env.JEV_CODEX_BINARY ?? (process.platform === 'win32' ? 'codex.exe' : 'codex');

export async function connect({ args = ['app-server', '--stdio'], cwd = process.cwd(), env = process.env } = {}) {
  const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const reader = createInterface({ input: child.stdout });
  const closed = new Promise(resolve => child.once('close', resolve));
  const pending = new Map(), events = [];
  let next = 0, diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-16000); });
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  reader.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));
      else item.resolve(message.result);
    } else {
      events.push({ at: Date.now(), ...message });
      // The deterministic test model never requests tools or permission.
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Not supported by the test client' } });
    }
  });
  const failPending = () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Codex connection closed')); }
    pending.clear();
  };
  child.on('close', failPending);
  child.on('error', failPending);
  const request = (method, params, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer }); send({ id, method, params });
  });
  const close = async () => { child.stdin.end(); child.kill(); await closed; reader.close(); };
  try {
    await request('initialize', { clientInfo: { name: 'jev-hook-verification', version: '1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false } });
    send({ method: 'initialized', params: {} });
  } catch (error) { await close(); throw error; }
  return { request, events, close, diagnostics: () => diagnostic };
}
