import path from 'node:path';
import { createHash } from 'node:crypto';
import { activeTask, readState } from './task.js';
import { git, snapshot, changesBetween } from './repo.js';
import { reviewableChanges } from './review.js';
import { REVIEW_VERSION } from './review-plan.js';
import { isCheckRunning } from './check-lock.js';

// A short cache coalesces browser refreshes; it never changes the real Git index.
export function workbenchState(repo, { apiConfigured = false } = {}) {
  let cached, pending;
  return async function read({ refresh = false } = {}) {
    if (pending) {
      const value = await pending;
      if (!refresh) return value;
    }
    if (!refresh && cached && Date.now() - cached.at < 8000) return cached.value;
    pending = (async () => {
      const [task, latest, running, branch] = await Promise.all([
        activeTask(repo), readState(repo, 'latest.json'), isCheckRunning(repo),
        git(repo.root, ['symbolic-ref', '--short', '-q', 'HEAD']).then(s => s.trim()).catch(() => 'detached HEAD'),
      ]);
      const current = task?.active ? await snapshot(repo) : null;
      const changes = current ? await changesBetween(repo, task.baseline, current) : [];
      const report = task && latest && latest.taskId === task.id ? { ...latest,
        stale: latest.reviewVersion !== REVIEW_VERSION || !task.active || latest.revision !== task.revision || latest.cacheKey !== `${task.id}:${task.revision}:${current}`,
      } : null;
      const { skipped, redacted } = task ? reviewableChanges(task, changes) : { skipped: [], redacted: [] };
      const files = changes.map(change => {
        const hash = createHash('sha256').update(change.diff).digest('hex');
        const judged = !report?.stale && report?.files.some(f => f.file === change.file && f.contentHash === hash);
        const judgment = judged ? report.judgments.find(f => f.file === change.file) : null;
        const findings = judged ? report.findings.filter(f => f.file === change.file) : [];
        const skip = skipped.find(f => f.file === change.file)
          ?? (redacted.some(f => f.file === change.file) ? { reason: '疑似凭据，补丁不在浏览器中展示。' } : null);
        const lines = change.diff.split('\n');
        return {
          id: change.id, file: change.file, operation: change.operation,
          additions: lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
          deletions: lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length,
          relation: findings.some(f => f.level !== 'review') ? 'attention' : judgment?.relation
            ?? (judged && report.skipped.some(f => f.file === change.file) ? 'skipped' : 'pending'),
          requirementId: judgment?.requirementId ?? null, findings,
          // Use the existing credential guard before exposing any patch in the browser.
          diff: skip ? null : lines.slice(0, 350).join('\n'),
          diffNotice: skip?.reason ?? (lines.length > 350 ? '仅显示前 350 行。完整补丁可在编辑器中查看。' : null),
        };
      });
      const value = {
        workspace: { name: path.basename(repo.root), root: repo.root, branch },
        task, report, files, running, apiConfigured, updatedAt: new Date().toISOString(),
      };
      cached = { at: Date.now(), value };
      return value;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
