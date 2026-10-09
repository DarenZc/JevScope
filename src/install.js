import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configPaths, scopeScript } from './config.js';
import { hookConfiguration } from './hooks.js';

const exec = promisify(execFile);
const ENV_EXAMPLE = '# Copy to .env and set your own key. Never commit .env.\nOPENROUTER_API_KEY=\nJEV_MODEL=jev-1.13\n';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function readOptional(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function parseConfig(raw) {
  let config;
  try { config = raw === null ? {} : JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw new Error('hooks.json 不是有效 JSON；原文件未作修改。'); }
  if (!isObject(config) || (config.hooks !== undefined && !isObject(config.hooks))) {
    throw new Error('hooks.json 的 hooks 必须是对象；原文件未作修改。');
  }
  for (const groups of Object.values(config.hooks ?? {})) {
    if (!Array.isArray(groups) || groups.some(group => !isObject(group) || !Array.isArray(group.hooks)
      || group.hooks.some(handler => !isObject(handler)))) {
      throw new Error('hooks.json 含无法合并的事件配置；原文件未作修改。');
    }
  }
  return config;
}

async function readManifest(file) {
  const raw = await readOptional(file);
  if (raw === null) return null;
  let state;
  try { state = JSON.parse(raw); } catch { /* Handled below without echoing file contents. */ }
  if (state?.version !== 1 || !Array.isArray(state.registrations) || !state.registrations.length || !isObject(state.original)
    || state.registrations.some(item => typeof item.event !== 'string' || !isObject(item.group)
      || !Array.isArray(item.group.hooks) || item.group.hooks.length !== 1 || !isObject(item.group.hooks[0]))) {
    throw new Error('Jev Scope 安装记录损坏；请保留现有 hooks.json 并检查 install.json。');
  }
  return state;
}

async function atomicWrite(file, text) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await rename(temp, file); }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function withInstallLock(paths, action) {
  await mkdir(paths.directory, { recursive: true });
  const file = path.join(paths.directory, 'install.lock');
  let lock;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { lock = await open(file, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const pid = JSON.parse(await readFile(file, 'utf8')).pid;
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (cause) { stale = cause.code === 'ESRCH'; }
        }
      } catch { /* Do not delete an unrecognized or partially written lock. */ }
      if (!stale) throw new Error(`另一次安装正在进行；若已退出，请检查 ${file}。`);
      await unlink(file).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
    }
  }
  if (!lock) throw new Error('无法获取 Jev Scope 安装锁，请稍后重试。');
  try { await lock.writeFile(JSON.stringify({ pid: process.pid })); return await action(); }
  finally { await lock.close(); await unlink(file); }
}

function registrations(config) {
  return Object.entries(config.hooks).flatMap(([event, groups]) => groups.map(group => ({ event, group })));
}

function groupOptions(group) {
  const { hooks, ...options } = group;
  return options;
}

function findHandler(config, entry) {
  for (const group of config.hooks?.[entry.event] ?? []) {
    if (!isDeepStrictEqual(groupOptions(group), groupOptions(entry.group))) continue;
    const index = group.hooks.findIndex(handler => isDeepStrictEqual(handler, entry.group.hooks[0]));
    if (index !== -1) return { group, index };
  }
  return null;
}

// Match complete definitions, not a substring such as "scope.js". A user's
// edited handler is preserved, including changes to its matcher or timeout.
function removeOwned(config, entries, original) {
  for (const entry of entries) {
    let found;
    while ((found = findHandler(config, entry))) {
      found.group.hooks.splice(found.index, 1);
      if (!found.group.hooks.length) {
        config.hooks[entry.event] = config.hooks[entry.event].filter(group => group !== found.group);
      }
      if (!config.hooks[entry.event].length && !original.emptyEvents?.includes(entry.event)) delete config.hooks[entry.event];
    }
  }
  if (config.hooks && !Object.keys(config.hooks).length && !original.hadHooks) delete config.hooks;
}

function editedOwned(config, entries) {
  return Object.entries(config.hooks ?? {}).flatMap(([event, groups]) => groups.flatMap(group => group.hooks
    .filter(handler => entries.some(entry => handler.command === entry.group.hooks[0].command
      && handler.commandWindows === entry.group.hooks[0].commandWindows)
      && !entries.some(entry => entry.event === event && isDeepStrictEqual(groupOptions(group), groupOptions(entry.group))
        && isDeepStrictEqual(handler, entry.group.hooks[0])))));
}

async function backupAndWrite(paths, before, after) {
  if (await readOptional(paths.hooks) !== before) throw new Error('hooks.json 已被其他程序修改，请重新运行命令。');
  let backup = null;
  if (before !== null) {
    const directory = path.join(paths.directory, 'backups');
    await mkdir(directory, { recursive: true });
    backup = path.join(directory, `hooks-${Date.now()}-${randomUUID()}.json`);
    await writeFile(backup, before, { flag: 'wx', mode: 0o600 });
  }
  if (after === null) await unlink(paths.hooks);
  else await atomicWrite(paths.hooks, `${JSON.stringify(after, null, 2)}\n`);
  return backup;
}

export async function install(options = {}) {
  const paths = configPaths(options.codexHome);
  return withInstallLock(paths, async () => {
    const before = await readOptional(paths.hooks);
    const current = parseConfig(before);
    const previous = await readManifest(paths.manifest);
    const desired = registrations(hookConfiguration({ ...options, codexHome: paths.home }));
    const original = previous?.original ?? { hadHooks: current.hooks !== undefined,
      emptyEvents: Object.entries(current.hooks ?? {}).filter(([, groups]) => !groups.length).map(([event]) => event) };
    const next = structuredClone(current);
    if (editedOwned(next, previous?.registrations ?? []).length) {
      throw new Error('已安装的 Jev Scope Hook 被手动修改；请先检查或移除这些条目，再重新安装。其他 Hook 未作修改。');
    }
    const outdated = (previous?.registrations ?? []).filter(entry => !desired.some(item => isDeepStrictEqual(item, entry)));
    removeOwned(next, outdated, original);
    next.hooks ??= {};
    for (const entry of desired) {
      if (!findHandler(next, entry)) (next.hooks[entry.event] ??= []).push(entry.group);
    }
    const state = { version: 1, script: options.script ?? scopeScript, node: options.node ?? process.execPath,
      original, registrations: desired };
    const changed = !isDeepStrictEqual(current, next);
    // Save both generations first so retry/uninstall can recover an interrupted update.
    if (changed) await atomicWrite(paths.manifest, `${JSON.stringify({ ...state,
      registrations: [...(previous?.registrations ?? []), ...desired] }, null, 2)}\n`);
    const backup = changed ? await backupAndWrite(paths, before, next) : null;
    await atomicWrite(paths.manifest, `${JSON.stringify(state, null, 2)}\n`);
    await writeFile(path.join(paths.directory, '.env.example'), ENV_EXAMPLE, { flag: 'wx', mode: 0o600 })
      .catch(error => { if (error.code !== 'EEXIST') throw error; });
    return { changed, hooksPath: paths.hooks, envPath: paths.env, backup,
      trust: 'Review the installed definitions in Codex /hooks. Installation does not grant trust.' };
  });
}

export async function uninstall(options = {}) {
  const paths = configPaths(options.codexHome);
  return withInstallLock(paths, async () => {
    const previous = await readManifest(paths.manifest);
    if (!previous) return { changed: false, hooksPath: paths.hooks, preserved: 0, unmatched: 0, backup: null };
    const before = await readOptional(paths.hooks);
    const current = parseConfig(before);
    const next = structuredClone(current);
    const unmatched = previous.registrations.filter(entry => !findHandler(current, entry)).length;
    removeOwned(next, previous.registrations, previous.original);
    const preserved = editedOwned(next, previous.registrations).length;
    const changed = !isDeepStrictEqual(current, next);
    const backup = changed ? await backupAndWrite(paths, before, Object.keys(next).length ? next : null) : null;
    await unlink(paths.manifest);
    return { changed, hooksPath: paths.hooks, preserved, unmatched, backup };
  });
}

export async function doctor(options = {}) {
  const paths = configPaths(options.codexHome);
  const checks = [{ name: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version }];
  try {
    const { stdout } = await exec('git', ['--version'], { windowsHide: true, timeout: 5000 });
    checks.push({ name: 'Git', ok: true, detail: stdout.trim() });
  } catch { checks.push({ name: 'Git', ok: false, detail: '未找到可用的 Git，请安装后重启 Codex。' }); }
  try {
    const current = parseConfig(await readOptional(paths.hooks));
    const state = await readManifest(paths.manifest);
    const installed = state?.registrations.every(entry => findHandler(current, entry)) ?? false;
    checks.push({ name: '全局 Hooks', ok: installed, detail: installed ? paths.hooks : '未安装或配置已改变，请运行 install。' });
    if (state) {
      for (const [name, file] of [['Node 路径', state.node], ['CLI 路径', state.script]]) {
        try { const handle = await open(file, 'r'); await handle.close(); checks.push({ name, ok: true, detail: file }); }
        catch { checks.push({ name, ok: false, detail: '安装路径已失效，请重新运行 install。' }); }
      }
    }
  } catch (error) { checks.push({ name: '全局 Hooks', ok: false, detail: error.message }); }
  checks.push({ name: 'OpenRouter 密钥', ok: Boolean(process.env.OPENROUTER_API_KEY),
    detail: process.env.OPENROUTER_API_KEY ? '已配置（未联网验证）' : `未配置；填写 ${paths.env}，或仅使用离线检查。` });
  return { ok: checks.every(check => check.ok), checks, hooksPath: paths.hooks, envPath: paths.env,
    trust: '安装状态不代表已信任或已启用。请在支持 Hooks 的本地 Codex 中打开 /hooks 核对。' };
}
