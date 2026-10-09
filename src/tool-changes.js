import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git, isSensitivePath, patchChanges, workspaceFile } from './repo.js';

// Use Git's actual line diff so unchanged code between distant edits never
// becomes fabricated +/- evidence. Only disposable files are written.
async function diff(file, before, after, created) {
  const temp = await mkdtemp(path.join(tmpdir(), 'jev-proposal-'));
  try {
    await writeFile(path.join(temp, 'before'), before, { mode: 0o600 });
    await writeFile(path.join(temp, 'after'), after, { mode: 0o600 });
    let patch;
    try { patch = await git(temp, ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-ext-diff', '--no-textconv',
      '--text', '--unified=3', '--', 'before', 'after']); }
    catch (error) { if (error.code !== 1) throw error; patch = error.stdout; }
    const header = [`diff --git ${JSON.stringify(`a/${file}`)} ${JSON.stringify(`b/${file}`)}`,
      ...(created ? ['new file mode 100644'] : [])];
    if (!before && !after && created) return `${header.join('\n')}\n`;
    const start = patch.indexOf('\n@@ ');
    if (start < 0) throw new Error('无法生成文本差异，将在结束时检查。');
    return [...header, created ? '--- /dev/null' : `--- ${JSON.stringify(`a/${file}`)}`,
      `+++ ${JSON.stringify(`b/${file}`)}`, patch.slice(start + 1)].join('\n');
  } finally {
    const target = path.resolve(temp);
    if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('jev-proposal-')) throw new Error('临时差异目录无效。');
    await rm(target, { recursive: true, force: true });
  }
}

function applyEdit(content, edit) {
  if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') {
    throw new Error('无法识别 Edit 的 old_string / new_string。');
  }
  if (edit.old_string === '') {
    if (content !== '') throw new Error('空 old_string 无法确定现有文件的修改位置。');
    return edit.new_string;
  }
  const parts = content.split(edit.old_string);
  if (parts.length === 1 || (edit.replace_all !== true && parts.length !== 2)) {
    throw new Error('Edit 的原文缺失或匹配不唯一，未推测修改结果。');
  }
  return parts.join(edit.new_string);
}

export async function toolChanges(payload, repo, { includeDiff = false } = {}) {
  const input = payload.tool_input;
  if (payload.tool_name === 'apply_patch') return patchChanges(input?.command ?? input?.input ?? input?.patch, repo);
  const { file, absolute } = workspaceFile(repo, payload.tool_name === 'NotebookEdit' ? input?.notebook_path : input?.file_path);
  const change = { id: 'F1', file, operation: 'Update', diff: '' };
  // End mode needs paths only. Never read sensitive files, even for live review.
  if (!includeDiff || isSensitivePath(file)) return [change];
  if (payload.tool_name === 'NotebookEdit') throw new Error('NotebookEdit 仅检查文件边界；语义范围会在结束时检查。');
  let before = '';
  try {
    if ((await stat(absolute)).size > 1024 * 1024) throw new Error('文件超过修改前检查预算，将在结束时检查。');
    before = await readFile(absolute, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    change.operation = 'Add';
  }
  let after;
  if (payload.tool_name === 'Write') {
    if (typeof input.content !== 'string') throw new Error('无法识别 Write 的 content。');
    after = input.content;
  } else {
    const edits = payload.tool_name === 'MultiEdit' ? input.edits : [input];
    if (!Array.isArray(edits) || !edits.length) throw new Error('MultiEdit 缺少 edits。');
    after = edits.reduce(applyEdit, before);
  }
  if (after === before && change.operation !== 'Add') return [];
  if (Buffer.byteLength(after) > 1024 * 1024 || before.includes('\0') || after.includes('\0')) {
    throw new Error('修改前内容过大或含二进制，语义范围会在结束时检查。');
  }
  change.diff = await diff(file, before, after, change.operation === 'Add');
  return [change];
}
