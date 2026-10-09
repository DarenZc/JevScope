import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { repository } from './repo.js';
import { activeTask, amendTask, startTask } from './task.js';
import { checkRepository } from './review.js';
import { workbenchState } from './workbench-state.js';

const ASSETS = new Map([
  ['/', ['index.html', 'text/html']],
  ...['styles.css', 'layout.css', 'readability.css', 'app.js', 'views.js', 'icons.js', 'dialogs.js'].map(name =>
    [`/${name}`, [name, name.endsWith('.css') ? 'text/css' : 'text/javascript']]),
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

async function bodyOf(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('请求须使用 JSON。');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new Error('请求内容过长。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('无法读取请求。'); }
}

export async function startWorkbench({ cwd, port = 4173, checkOptions = {} } = {}) {
  const repo = await repository(cwd);
  const token = randomBytes(32).toString('hex');
  const getState = workbenchState(repo, { apiConfigured: Boolean(process.env.OPENROUTER_API_KEY) });
  let busy = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      const hosts = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
      if (!hosts.includes(req.headers.host)) return json(403, { error: '仅允许本地工作台访问。' });
      const origin = `http://${req.headers.host}`;
      if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
        return json(403, { error: '不接受来自其他站点的请求。' });
      }
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const state = await getState({ refresh: url.searchParams.has('refresh') });
        return json(200, { ...state, running: busy || state.running, token });
      }
      if (req.method === 'GET' && ASSETS.has(url.pathname)) {
        const [file, type] = ASSETS.get(url.pathname);
        const content = await readFile(new URL(`../web/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        res.end(content);
        return;
      }
      if (req.method !== 'POST' || !['/api/check', '/api/task', '/api/review-mode'].includes(url.pathname)) {
        return json(404, { error: '未找到此页面。' });
      }
      if (req.headers['x-jev-token'] !== token) return json(403, { error: '请刷新工作台后重试。' });
      if (busy) return json(409, { error: '正在处理上一次操作，请稍后再试。' });
      const body = await bodyOf(req);
      if (busy) return json(409, { error: '正在处理上一次操作，请稍后再试。' });
      busy = true;
      try {
        const task = await activeTask(repo);
        if ((body.taskId ?? null) !== (task?.id ?? null) || (body.revision ?? null) !== (task?.revision ?? null)) {
          return json(409, { error: '任务已更新，请刷新后重试。' });
        }
        if (url.pathname === '/api/check') {
          if (typeof body.offline !== 'boolean') throw new Error('请选择检查方式。');
          if (!body.offline && body.confirmed !== true) throw new Error('请确认使用 OpenRouter 进行语义检查。');
          await checkRepository(repo, { ...checkOptions, offline: body.offline });
        } else if (url.pathname === '/api/review-mode') {
          if (!['end', 'manual'].includes(body.reviewMode)) throw new Error('请选择结束时检查或手动检查。');
          await amendTask(repo, '', { reviewMode: body.reviewMode });
        } else {
          if (typeof body.text !== 'string' || !body.text.trim()) throw new Error('请填写需求原话。');
          if (task?.active) await amendTask(repo, body.text);
          else await startTask(repo, body.text);
        }
        return json(200, { ...await getState({ refresh: true }), token });
      } finally { busy = false; }
    } catch (error) {
      json(error.code === 'SCOPE_CHECK_BUSY' ? 409 : 400, { error: error.message });
    }
  });
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, repo, url: `http://127.0.0.1:${server.address().port}` };
}
