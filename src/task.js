import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeBoundary, snapshot } from './repo.js';

export async function readState(repo, name) {
  try { return JSON.parse(await readFile(path.join(repo.stateDir, name), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`无法读取 ${name}，请检查本地任务记录。`);
  }
}

export async function writeState(repo, name, value) {
  await mkdir(repo.stateDir, { recursive: true });
  const temp = path.join(repo.stateDir, `${name}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path.join(repo.stateDir, name));
}

export async function activeTask(repo) {
  const task = await readState(repo, 'task.json');
  if (task && (task.version !== 1 || !Array.isArray(task.requirements) || !Array.isArray(task.constraints)
    || !Array.isArray(task.allowedPaths) || !['change', 'review'].includes(task.mode)
    || !/^[a-f0-9]{40,64}$/.test(task.baseline))) throw new Error('任务记录格式无效，请重新建立任务。');
  return task;
}

function validateText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
    throw new Error('需求或约束须为 1～4000 个字符。');
  }
  return text.trim();
}

export async function startTask(repo, goal, options = {}) {
  const previous = await activeTask(repo);
  if (previous?.active) throw new Error('已有活动任务。用 amend 补充要求，或先用 finish 结束，再开始新任务。');
  const task = {
    version: 1, id: randomUUID(), revision: 1, active: true,
    createdAt: new Date().toISOString(),
    mode: options.mode ?? 'change',
    requirements: [{ id: 'R1', text: validateText(goal) }],
    constraints: (options.constraints ?? []).map((text, i) => ({ id: `C${i + 1}`, text: validateText(text) })),
    allowedPaths: (options.allowedPaths ?? []).map(normalizeBoundary),
    noDependencies: options.noDependencies ?? false,
    reviewMode: options.reviewMode ?? 'end',
    retired: [],
  };
  if (!['change', 'review'].includes(task.mode)) throw new Error('mode 只能是 change 或 review。');
  if (!['end', 'live', 'manual'].includes(task.reviewMode)) throw new Error('review 只能是 end、live 或 manual。');
  task.baseline = await snapshot(repo);
  await writeState(repo, 'task.json', task);
  return task;
}

export async function amendTask(repo, text, options = {}) {
  const task = await activeTask(repo);
  if (!task?.active) throw new Error('请先用 start 建立任务。');
  task.retired ??= [];
  const nextId = prefix => `${prefix}${1 + Math.max(0, ...[...task.requirements, ...task.constraints, ...task.retired]
    .filter(item => item.id.startsWith(prefix)).map(item => Number(item.id.slice(1))))}`;
  const drop = new Set((options.drop ?? []).map(id => id.toUpperCase()));
  for (const id of drop) {
    if (![...task.requirements, ...task.constraints].some(item => item.id === id)) throw new Error(`没有有效的需求或约束 ${id}。`);
  }
  if (text) task.requirements.push({ id: nextId('R'), text: validateText(text) });
  if (!task.requirements.some(item => !drop.has(item.id))) throw new Error('任务至少需要一条有效需求；撤销时请同时提供替代需求。');
  for (const field of ['requirements', 'constraints']) {
    task.retired.push(...task[field].filter(item => drop.has(item.id))
      .map(item => ({ ...item, retiredAt: new Date().toISOString(), retiredRevision: task.revision + 1 })));
    task[field] = task[field].filter(item => !drop.has(item.id));
  }
  for (const constraint of options.constraints ?? []) {
    task.constraints.push({ id: nextId('C'), text: validateText(constraint) });
  }
  if (options.mode !== undefined) {
    if (!['change', 'review'].includes(options.mode)) throw new Error('mode 只能是 change 或 review。');
    task.mode = options.mode;
  }
  if (options.allowedPaths !== undefined) task.allowedPaths = options.allowedPaths.map(normalizeBoundary);
  if (options.noDependencies !== undefined) task.noDependencies = options.noDependencies;
  if (options.reviewMode !== undefined) {
    if (!['end', 'live', 'manual'].includes(options.reviewMode)) throw new Error('review 只能是 end、live 或 manual。');
    task.reviewMode = options.reviewMode;
  }
  task.revision += 1;
  await writeState(repo, 'task.json', task);
  return task;
}
