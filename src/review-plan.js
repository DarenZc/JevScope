import path from 'node:path';
import { isSensitivePath } from './repo.js';
import { buildRequest } from './jev.js';
import { extractEvidence } from './evidence.js';

export const REVIEW_VERSION = 5;
const CHUNK_BYTES = 8000;
const MAX_TOTAL_BYTES = 512000;
const MAX_UNITS = 96;
const MAX_REQUEST_BYTES = 48000;
const SECRET = /sk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{20,}|(?:api[_-]?key|password|secret|access[_-]?token)["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi;

// Match before splitting, and remove every occurrence of a matched value, including assertions.
export function reviewableChanges(_task, changes) {
  const selected = [], skipped = [], redacted = [];
  let bytes = 0;
  for (const change of changes) {
    let reason;
    if (isSensitivePath(change.file)) reason = '敏感文件路径，未发送内容';
    else if (/^(?:Binary files .+ differ|GIT binary patch)\r?$/m.test(change.diff)) reason = '二进制文件';
    else if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(change.diff)) reason = '检测到私钥，未发送内容';
    const values = [...change.diff.matchAll(SECRET)].map(match => match[1] ?? match[0]);
    let diff = change.diff;
    for (const value of new Set(values)) diff = diff.split(value).join('[REDACTED_CREDENTIAL]');
    if (!reason && bytes + Buffer.byteLength(diff) > MAX_TOTAL_BYTES) reason = '超过单次检查 512 KB 的总预算';
    if (reason) skipped.push({ file: change.file, reason });
    else {
      if (values.length) redacted.push({ file: change.file, values: new Set(values).size });
      selected.push({ ...change, diff });
      bytes += Buffer.byteLength(diff);
    }
  }
  return { selected, skipped, redacted };
}

// Preserve every character, including a minified line and multibyte text. Prefer line/statement ends.
export function splitDiff(diff, limit = CHUNK_BYTES) {
  const pieces = [];
  let part = '', size = 0, boundary = 0;
  for (const character of diff) {
    const next = Buffer.byteLength(character);
    if (size + next > limit) {
      const cut = boundary > part.length / 2 ? boundary : part.length;
      pieces.push(part.slice(0, cut));
      part = part.slice(cut);
      size = Buffer.byteLength(part);
      boundary = 0;
    }
    part += character;
    size += next;
    if (character === '\n' || character === ';' || character === '}') boundary = part.length;
  }
  if (part) pieces.push(part);
  return pieces.length ? pieces : [''];
}

function contextFor(selected, batch) {
  const targets = new Set(batch.map(change => change.file));
  const inventory = selected.slice(0, 96).map(({ file, operation }) => ({ file, operation }));
  const links = [];
  for (const change of selected) {
    // Literal paths are navigation evidence, never proof of authorization or necessity.
    for (const line of change.diff.split('\n')) {
      if (line.startsWith('-') || line.startsWith('diff ') || line.startsWith('+++')) continue;
      for (const match of line.matchAll(/["'`]([^"'`\n]+\.(?:[cm]?[jt]sx?|css|html|svg))["'`]/g)) {
        const ref = match[1];
        const relative = path.posix.normalize(path.posix.join(path.posix.dirname(change.file), ref));
        const target = selected.find(item => item.file === relative || item.file === ref.replace(/^\//, ''));
        if (!target || (!targets.has(change.file) && !targets.has(target.file))) continue;
        if (!links.some(link => link.from === change.file && link.to === target.file)) {
          links.push({ from: change.file, to: target.file, evidence: line.trim().slice(0, 240) });
        }
      }
    }
  }
  const multipart = new Set(batch.filter(change => change.part?.total > 1).map(change => change.file));
  // This is redacted source context, not an authorization or a file-type exemption.
  const fileHeaders = selected.filter(change => multipart.has(change.file))
    .map(change => ({ file: change.file, excerpt: change.diff.slice(0, 1000) }));
  return { inventory, links: links.slice(0, 20), fileHeaders, inventoryTruncated: selected.length > inventory.length };
}

export function planReview(task, changes) {
  const plan = { ...reviewableChanges(task, changes), units: [], batches: [] };
  for (const change of plan.selected) {
    const parts = splitDiff(change.diff);
    const evidence = extractEvidence(change.diff, change.file);
    if (plan.units.length + parts.length > MAX_UNITS) {
      plan.skipped.push({ file: change.file, reason: '超过单次检查 96 个片段的预算' });
      continue;
    }
    let offset = 0;
    for (const [index, diff] of parts.entries()) {
      const candidates = evidence.filter(item => item.offset >= offset && item.offset < offset + diff.length);
      const selected = candidates.length <= 12 ? candidates : Array.from({ length: 12 }, (_, i) => candidates[Math.floor(i * (candidates.length - 1) / 11)]);
      plan.units.push({ ...change, id: parts.length === 1 ? change.id : `${change.id}_P${index + 1}`, diff,
        evidenceCandidates: selected, evidenceCandidatesTruncated: candidates.length > selected.length,
        part: { index: index + 1, total: parts.length, start: offset, end: offset + diff.length } });
      offset += diff.length;
    }
  }
  let current = [];
  const fits = units => Buffer.byteLength(JSON.stringify(buildRequest(task, units, 'jev-1.13', contextFor(plan.selected, units)))) <= MAX_REQUEST_BYTES;
  const flush = () => { if (current.length) plan.batches.push({ changes: current, context: contextFor(plan.selected, current) }); current = []; };
  for (const unit of plan.units) {
    if (current.length >= 4 || !fits([...current, unit])) flush();
    if (!fits([unit])) plan.skipped.push({ file: unit.file, reason: `片段 ${unit.part.index} 加需求上下文超过请求预算` });
    else current.push(unit);
  }
  flush();
  return plan;
}
