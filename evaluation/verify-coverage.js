// Explicit paid replay; preserves the active task, original baseline and previous evaluation files.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { repository, changesBetween } from '../src/repo.js';
import { reviewChanges } from '../src/review.js';
import { cases } from './cases.js';

if (!process.argv.includes('--live')) {
  console.log('Use --live to replay the saved UI trial and six regression cases with the configured Jev API.');
  process.exit(0);
}
process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
const repo = await repository();
const saved = JSON.parse(await readFile(`${repo.stateDir}/ui-trial-before-improvements.json`, 'utf8'));
const changes = await changesBetween(repo, saved.task.baseline, saved.tree);
const summarize = report => ({ semantic: report.semantic, files: report.files.length,
  reviewedFiles: report.judgments.length,
  counts: Object.fromEntries(['explicit', 'necessary', 'uncertain', 'extra'].map(relation =>
    [relation, report.judgments.filter(item => item.relation === relation).length])),
  skipped: report.skipped, redacted: report.redacted ?? [], coverage: report.coverage,
  judgments: report.judgments, model: report.model, usage: report.usage, notice: report.notice });
const started = performance.now();
const trial = await reviewChanges(saved.task, changes);
const output = { checkedAt: new Date().toISOString(), reviewVersion: trial.reviewVersion,
  methodology: 'Replay of the exact saved task revision and Git trees. No expected labels are sent to Jev. Lower uncertainty is coverage/usability evidence, not proof of accuracy.',
  before: summarize(saved.report), after: summarize(trial), elapsedMs: Math.round(performance.now() - started), regressions: [] };
console.log(JSON.stringify({ trial: { before: { reviewed: output.before.reviewedFiles, counts: output.before.counts },
  after: { reviewed: output.after.reviewedFiles, counts: output.after.counts, coverage: trial.coverage, skipped: trial.skipped }, elapsedMs: output.elapsedMs } }));
for (const id of ['csv', 'callers', 'history', 'mixed', 'missing-context', 'comment-injection']) {
  const scenario = cases.find(item => item.id === id);
  const report = await reviewChanges(scenario.task, scenario.files.map(({ expected, conflictId, ...file }) => file));
  const judgments = scenario.files.map(file => {
    const actual = report.judgments.find(item => item.id === file.id);
    const relations = file.expected === 'allowed' ? ['explicit', 'necessary'] : file.expected === 'mixed' ? ['extra', 'uncertain'] : [file.expected];
    return { file: file.file, expected: file.expected, expectedConflict: file.conflictId, actual,
      passed: !!actual && relations.includes(actual.relation) && actual.conflictId === file.conflictId };
  });
  const result = { id, semantic: report.semantic, usage: report.usage, judgments,
    passed: report.semantic === 'complete' && judgments.every(item => item.passed) };
  output.regressions.push(result);
  console.log(JSON.stringify({ regression: id, passed: result.passed, judgments: judgments.map(item => ({ file: item.file, relation: item.actual?.relation, conflict: item.actual?.conflictId })) }));
}
output.totalCost = (trial.usage?.cost ?? 0) + output.regressions.reduce((total, item) => total + (item.usage?.cost ?? 0), 0);
await writeFile(new URL('./coverage-latest.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ totalCost: output.totalCost }));
if (trial.semantic !== 'complete' || output.regressions.some(item => !item.passed)) process.exitCode = 1;
