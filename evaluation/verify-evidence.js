// Opt-in paid checks on actual Git diffs. Expected results never enter Jev requests.
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { repository, git, snapshot, changesBetween } from '../src/repo.js';
import { startTask, readState } from '../src/task.js';
import { reviewChanges, checkRepository } from '../src/review.js';
import { importantFindings, renderNotice } from '../src/report.js';
import { takeNotice, runHook } from '../src/hooks.js';
import { workflowCases } from './workflow-cases.js';

if (!process.argv.includes('--live')) {
  console.log('Use --live for the saved UI replay and real font/color/automatic-check probes. This calls the configured Jev API.');
  process.exit(0);
}
const project = fileURLToPath(new URL('../', import.meta.url));
process.loadEnvFile(path.join(project, '.env'));
const outputPath = path.join(project, 'evaluation/evidence-latest.json');
const output = { checkedAt: new Date().toISOString(),
  methodology: 'One run per case, expectations fixed before requests. Replay the original UI task and Git trees without changing the active task. Other cases edit copies of actual UI source. Evidence must refer to changed source, and the same notice is delivered once through the chat/Stop protocol.',
  limitations: 'A small author-selected sample, not production accuracy. Source evidence shows what changed; model scope judgments can still be wrong. Automatic-check fixture code is never executed.',
  results: [] };
const save = async result => {
  output.results.push(result);
  output.totalCost = output.results.reduce((sum, item) => sum + (item.usage?.cost ?? 0), 0);
  await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ id: result.id, passed: result.passed, elapsedMs: result.elapsedMs,
    judgments: result.judgments, userNotification: result.userNotification }));
};
const summarize = report => ({ semantic: report.semantic, coverage: report.coverage, model: report.model,
  usage: report.usage, findings: report.findings, skipped: report.skipped,
  judgments: report.judgments.map(item => ({ file: item.file, relation: item.relation, rawRelation: item.rawRelation,
    unsupportedParts: item.parts.filter(part => part.unsupportedWarning).length })),
  userNotification: renderNotice(report, '说“查看范围检查报告”') });

const originalRepo = await repository(project);
const activeBefore = await readState(originalRepo, 'task.json');
const saved = await readState(originalRepo, 'ui-evidence-before-improvements.json');
if (saved) {
  const tree = saved.report.cacheKey.split(':').at(-1);
  const changes = await changesBetween(originalRepo, saved.task.baseline, tree);
  const started = performance.now();
  const report = await reviewChanges(saved.task, changes);
  await save({ id: 'original-ui-redesign', prompt: saved.task.requirements[0].text,
    expected: 'No proactive warnings for implementation of the requested layout redesign; unresolved evidence may remain uncertain.',
    baseline: saved.task.baseline, tree, previousFindings: saved.report.findings,
    ...summarize(report), elapsedMs: Math.round(performance.now() - started),
    passed: report.semantic === 'complete' && !importantFindings(report).length });
} else output.replaySkipped = 'Original local replay snapshot is unavailable.';

const source = {};
for (const name of ['web/styles.css', 'web/readability.css', 'web/app.js']) {
  source[name] = (await readFile(path.join(project, name), 'utf8')).replaceAll('\r\n', '\n');
}
output.sourceHashes = Object.fromEntries(Object.entries(source).map(([name, text]) => [name, createHash('sha256').update(text).digest('hex')]));
const temporaryParent = await realpath(tmpdir());
const root = await mkdtemp(path.join(temporaryParent, 'jev-evidence-eval-'));
try {
  for (const id of ['font-family', 'font-with-color', 'bare-font-with-autocheck']) {
    const scenario = workflowCases.find(item => item.id === id);
    const dir = path.join(root, id);
    await mkdir(path.join(dir, 'web'), { recursive: true });
    for (const [file, text] of Object.entries(source)) await writeFile(path.join(dir, file), text);
    await git(dir, ['init', '-q']);
    await git(dir, ['config', 'core.autocrlf', 'false']);
    const repo = await repository(dir);
    await startTask(repo, scenario.prompt, { constraints: scenario.constraints });
    for (const [file, text] of Object.entries(scenario.edit(source))) await writeFile(path.join(dir, file), text);
    const tree = await snapshot(repo), index = await git(dir, ['diff', '--cached']);
    const started = performance.now();
    const report = await checkRepository(repo);
    const notice = await takeNotice(repo, report, 'chat');
    const repeated = await takeNotice(repo, report, 'chat');
    const stop = await runHook({ cwd: dir, hook_event_name: 'Stop' });
    const preserved = tree === await snapshot(repo) && index === await git(dir, ['diff', '--cached']);
    const concrete = importantFindings(report);
    const expectedSatisfied = Object.entries(scenario.expected).every(([file, expected]) => {
      const actual = report.judgments.find(item => item.file === file);
      const warnings = concrete.filter(item => item.file === file);
      return expected === 'allowed' ? actual && ['explicit', 'necessary'].includes(actual.relation) && !warnings.length
        : warnings.length > 0 && warnings.every(item => item.evidence?.location.line > 0 && item.changeSummary && item.scopeExplanation);
    });
    const contentCorrect = id === 'font-with-color' ? concrete.some(item => /--green/.test(item.changeSummary) && /#7348a5|#552b83/.test(item.changeSummary))
      : id === 'bare-font-with-autocheck' ? concrete.some(item => /post\('\/api\/check'/.test(item.evidence?.after ?? '')) : !notice;
    await save({ id, prompt: scenario.prompt, constraints: scenario.constraints, expected: scenario.expected,
      ...summarize(report), userNotification: notice, elapsedMs: Math.round(performance.now() - started),
      noDuplicateNotification: !repeated && !stop.systemMessage, filesAndIndexPreserved: preserved,
      passed: report.semantic === 'complete' && expectedSatisfied && contentCorrect && preserved && !repeated && !stop.systemMessage });
  }
} finally {
  const resolved = await realpath(root);
  if (path.dirname(resolved) !== temporaryParent || !path.basename(resolved).startsWith('jev-evidence-eval-')) throw new Error('Unexpected fixture cleanup path.');
  await rm(resolved, { recursive: true, force: true });
}
output.activeTaskPreserved = JSON.stringify(activeBefore) === JSON.stringify(await readState(originalRepo, 'task.json'));
output.passed = output.results.every(item => item.passed) && output.activeTaskPreserved;
await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ passed: output.passed, totalCost: output.totalCost, outputPath }));
if (!output.passed) process.exitCode = 1;
