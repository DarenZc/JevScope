import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, realpath, rm, stat, utimes } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const MAX_OUTPUT = 16 * 1024 * 1024;
const SENSITIVE_PATHS = [
  '**/.env*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/id_ed25519*',
  '**/.npmrc', '**/.netrc', '**/credentials.json',
];
const EXCLUDES = SENSITIVE_PATHS.map(pattern => `:(exclude,glob,icase)${pattern}`);

export function isSensitivePath(file) {
  return file.replaceAll('\\', '/').split('/').some(part =>
    /^(?:\.env.*|.*\.(?:pem|key)|id_rsa.*|id_ed25519.*|\.npmrc|\.netrc|credentials\.json)$/i.test(part));
}

export async function git(cwd, args, env = {}) {
  const { stdout } = await exec('git', ['-c', 'core.quotePath=false', ...args], {
    cwd, env: { ...process.env, ...env }, maxBuffer: MAX_OUTPUT, encoding: 'utf8',
    windowsHide: true,
  });
  return stdout;
}

export async function repository(cwd = process.cwd()) {
  let root;
  try { root = (await git(cwd, ['rev-parse', '--show-toplevel'], { LC_ALL: 'C' })).trim(); }
  catch (cause) {
    const unavailable = cause.code === 'ENOENT';
    const notGit = /not a git repository|must be run in a work tree/.test(cause.stderr ?? '');
    throw Object.assign(new Error(unavailable ? '找不到 Git 或工作目录，请检查安装与路径。'
      : notGit ? '当前目录不在 Git 工作区中，请先运行 git init。'
        : '无法读取 Git 工作区，请检查目录权限和 Git 信任设置。'), {
      code: unavailable ? 'SCOPE_GIT_UNAVAILABLE' : notGit ? 'SCOPE_NOT_GIT' : 'SCOPE_REPOSITORY_UNAVAILABLE',
    });
  }
  const statePath = (await git(root, ['rev-parse', '--git-path', 'jev-scope'])).trim();
  return { root: await realpath(root), stateDir: path.resolve(root, statePath), workingDir: await realpath(cwd) };
}

function canonicalPatchPath(name, cwd) {
  let candidate = path.resolve(cwd, name);
  const missing = [];
  for (;;) {
    try { return path.join(realpathSync.native(candidate), ...missing.reverse()); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) return path.resolve(cwd, name);
      missing.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

export function workspaceFile(repo, name) {
  if (typeof name !== 'string' || !name.trim() || name.includes('\0')) throw new Error('无法识别修改文件路径。');
  const absolute = canonicalPatchPath(name, repo.workingDir ?? repo.root);
  const file = path.relative(repo.root, absolute).replaceAll('\\', '/');
  if (!file || file === '..' || file.startsWith('../') || path.isAbsolute(file)) throw new Error('修改路径位于当前工作区之外。');
  return { absolute, file };
}

// A separate index includes staged, unstaged and new files without changing the user's index.
export async function snapshot(repo) {
  const temp = await mkdtemp(path.join(tmpdir(), 'jev-scope-index-'));
  const env = { GIT_INDEX_FILE: path.join(temp, 'index') };
  try {
    const indexPath = (await git(repo.root, ['rev-parse', '--git-path', 'index'])).trim();
    try {
      const source = path.resolve(repo.root, indexPath);
      const metadata = await stat(source);
      await copyFile(source, env.GIT_INDEX_FILE);
      // A newer copy timestamp can make Git trust stale stat data and miss a
      // same-size edit within one clock tick. Round down conservatively so Git's
      // racy-index content check remains active, including on coarse filesystems.
      await utimes(env.GIT_INDEX_FILE, metadata.atime, Math.floor(metadata.mtimeMs / 1000));
    }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await git(repo.root, ['read-tree', '--empty'], env);
    }
    // Keep tracked files even if now ignored; remove sensitive entries from the copy only.
    await git(repo.root, ['rm', '-r', '--cached', '-f', '--ignore-unmatch', '--',
      ...SENSITIVE_PATHS.map(pattern => `:(glob,icase)${pattern}`)], env);
    await git(repo.root, ['add', '-A', '--', '.', ...EXCLUDES], env);
    return (await git(repo.root, ['write-tree'], env)).trim();
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function changesBetween(repo, before, after) {
  const names = (await git(repo.root, [
    'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', before, after,
  ])).split('\0');
  const changes = [];
  for (let i = 0; i + 1 < names.length; i += 2) {
    const file = names[i + 1];
    if (!file) continue;
    const diff = await git(repo.root, [
      'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=3', before, after, '--', file,
    ]);
    changes.push({ id: `F${changes.length + 1}`, file, operation: names[i], diff });
  }
  return changes;
}

export async function contentAt(repo, tree, file) {
  try { return await git(repo.root, ['show', `${tree}:${file}`]); }
  catch (error) {
    if (error.code === 128 && /does not exist|exists on disk, but not in/.test(error.stderr ?? '')) return null;
    throw error;
  }
}

export function normalizeBoundary(value) {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)
      || normalized.split('/').some(part => part === '..' || part === '.')) {
    throw new Error('文件范围须为仓库相对路径；目录以 / 结尾，例如 src/auth/。');
  }
  return normalized;
}

export function withinBoundary(file, boundary) {
  let candidate = file.replaceAll('\\', '/');
  let target = boundary;
  if (process.platform === 'win32') { candidate = candidate.toLowerCase(); target = target.toLowerCase(); }
  return target.endsWith('/') ? candidate.startsWith(target) : candidate === target;
}

export function patchChanges(command, repo) {
  if (typeof command === 'string') command = command.replaceAll('\r\n', '\n');
  if (typeof command !== 'string' || !command.startsWith('*** Begin Patch\n')) {
    throw new Error('无法识别 apply_patch 输入，未完成修改前检查。');
  }
  const parts = command.split(/(?=^\*\*\* (?:Add|Update|Delete) File: )/m).slice(1);
  if (!parts.length) throw new Error('补丁中没有可识别的文件。');
  return parts.flatMap(part => {
    const header = part.match(/^\*\*\* (Add|Update|Delete) File: (.+)\r?$/m);
    if (!header) throw new Error('无法识别补丁文件路径。');
    const names = [header[2].trim()];
    const move = part.match(/^\*\*\* Move to: (.+)\r?$/m);
    if (move) names.push(move[1].trim());
    return names.map(name => {
      const { file } = workspaceFile(repo, name);
      return { file, operation: header[1], diff: part };
    });
  }).map((change, i) => ({ ...change, id: `F${i + 1}` }));
}
