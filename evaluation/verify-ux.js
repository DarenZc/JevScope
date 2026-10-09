// Focused paid verification: node evaluation/verify-ux.js --live
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './cases.js';
import { git, repository } from '../src/repo.js';
import { startTask, amendTask } from '../src/task.js';
import { reviewChanges } from '../src/review.js';
import { renderNotice } from '../src/report.js';

if (!process.argv.includes('--live')) {
  console.log('Use --live for three paid requests: retracted constraint, necessary CSV escaping, and mixed scope.');
  process.exit(0);
}
process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured.');
const dir = await mkdtemp(path.join(tmpdir(), 'jev-scope-ux-'));
const results = [];
try {
  await git(dir, ['init', '-q']);
  const repo = await repository(dir);
  for (const id of ['amendment', 'csv', 'mixed']) {
    const item = cases.find(entry => entry.id === id);
    let task = item.task;
    if (id === 'amendment') {
      await startTask(repo, task.requirements[0].text, { constraints: task.constraints.map(c => c.text) });
      task = await amendTask(repo, task.requirements[1].text, { drop: ['C1'] });
    }
    const started = performance.now();
    const report = await reviewChanges(task, item.files.map(({ expected, conflictId, ...change }) => change));
    const notice = renderNotice(report);
    const expectedNotice = id === 'mixed';
    const passed = report.semantic === 'complete' && !!notice === expectedNotice
      && (id !== 'amendment' || report.judgments.every(j => j.conflictId === null));
    const result = { id, title: item.title, method: id === 'amendment' ? 'Real startTask + amendTask(drop C1)' : 'Unchanged classifier, compact notification',
      passed, expectedNotice, notice, semantic: report.semantic, elapsedMs: Math.round(performance.now() - started),
      model: report.model, judgments: report.judgments, usage: report.usage };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const output = { checkedAt: new Date().toISOString(), version: '0.2.0',
    limitations: 'Three synthetic readiness probes; not production accuracy or a live Codex conversation test.',
    totalCost: results.reduce((sum, item) => sum + (item.usage?.cost ?? 0), 0), results };
  await writeFile(new URL('./ux-latest.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
  if (results.some(item => !item.passed)) process.exitCode = 1;
} finally { await rm(dir, { recursive: true, force: true }); }
