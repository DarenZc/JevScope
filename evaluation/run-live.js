// Explicit opt-in: node evaluation/run-live.js --live
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { reviewChanges } from '../src/review.js';
import { cases } from './cases.js';

if (!process.argv.includes('--live')) {
  console.log('Use --live to run 10 paid Jev requests with synthetic changes. No repository source is submitted.');
  process.exit(0);
}
process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured.');
const results = [];
for (const item of cases) {
  const started = performance.now();
  // Expected labels are retained locally and are never sent to the model.
  const changes = item.files.map(({ expected, conflictId, ...change }) => change);
  const report = await reviewChanges(item.task, changes);
  const elapsedMs = Math.round(performance.now() - started);
  const judgments = item.files.map(file => {
    const actual = report.judgments.find(judgment => judgment.id === file.id);
    const findings = report.findings.filter(finding => finding.file === file.file);
    const acceptable = file.expected === 'allowed' ? ['explicit', 'necessary']
      : file.expected === 'mixed' ? ['uncertain', 'extra'] : [file.expected];
    return { file: file.file, expected: file.expected, expectedConflict: file.conflictId, actual,
      flagged: findings.length > 0,
      matchesExpectation: !!actual && acceptable.includes(actual.relation) && actual.conflictId === file.conflictId };
  });
  results.push({ id: item.id, title: item.title, semantic: report.semantic, elapsedMs,
    model: report.model, usage: report.usage, notice: report.notice, judgments });
  console.log(JSON.stringify(results.at(-1)));
}
const all = results.flatMap(result => result.judgments);
const allowed = all.filter(item => item.expected === 'allowed');
const extra = all.filter(item => item.expected === 'extra' || item.expected === 'mixed');
const durations = results.filter(item => item.semantic === 'complete').map(item => item.elapsedMs).sort((a, b) => a - b);
const summary = {
  label: 'Single run of 10 author-written synthetic scenarios; not production accuracy or measured improvement in Codex behavior.',
  scenarios: results.length, completeRequests: results.filter(item => item.semantic === 'complete').length,
  files: all.length, expectationMatches: all.filter(item => item.matchesExpectation).length,
  allowedFiles: allowed.length, allowedFilesFlagged: allowed.filter(item => item.flagged).length,
  extraOrMixedFiles: extra.length, extraOrMixedFilesFlagged: extra.filter(item => item.flagged).length,
  p50Ms: durations[Math.ceil(durations.length * 0.5) - 1], p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
  totalCost: results.reduce((sum, item) => sum + (item.usage?.cost ?? 0), 0),
};
await writeFile(new URL('./latest.json', import.meta.url), JSON.stringify({ checkedAt: new Date().toISOString(), summary, results }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
