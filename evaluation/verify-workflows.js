// Opt-in paid evaluation of actual workbench edits via the CLI and Hook protocol.
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { git, repository, snapshot, changesBetween } from '../src/repo.js';
import { workflowCases } from './workflow-cases.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const cliPath = path.join(project, 'bin/scope.js');
const exec = promisify(execFile);
const args = new Set(process.argv.slice(2));
const live = args.has('--live');
const keep = args.has('--keep-fixtures');
const only = [...args].find(arg => arg.startsWith('--only='))?.slice(7);
const scenarios = only ? workflowCases.filter(item => item.id === only) : workflowCases;
if (!scenarios.length) throw new Error('Unknown scenario.');
if (!live && !args.has('--dry-run')) {
  console.log('Use --dry-run to validate fixtures without API calls; --live for real Jev checks. Add --keep-fixtures for browser verification or --only=<case-id> for one case.');
  process.exit(0);
}

async function cli(cwd, args, input) {
  // stdin supports genuine Hook payloads; no key, expected label, or fake judgment is passed.
  const child = exec(process.execPath, [cliPath, ...args, '--cwd', cwd], {
    cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 45000,
  });
  child.child.stdin.end(input ? JSON.stringify(input) : '');
  try { const result = await child; return { ...result, code: 0 }; }
  catch (error) {
    if ([1, 2].includes(error.code) && error.stdout) return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    throw new Error(`CLI failed (${args[0]}): ${error.code ?? 'unknown'}`);
  }
}
async function jsonCli(cwd, args, input) {
  const result = await cli(cwd, args, input);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`Expected JSON from ${args[0]} (exit ${result.code}).`); }
}
const source = {};
for (const directory of ['web', 'src', 'bin']) {
  for (const name of await readdir(path.join(project, directory))) {
    if (!/\.(?:js|css|html|svg)$/.test(name)) continue;
    const relative = `${directory}/${name}`;
    source[relative] = (await readFile(path.join(project, relative), 'utf8')).replaceAll('\r\n', '\n');
  }
}
source['package.json'] = await readFile(path.join(project, 'package.json'), 'utf8');
const root = await mkdtemp(path.join(tmpdir(), 'jev-workflow-eval-'));
const output = {
  checkedAt: new Date().toISOString(), mode: live ? 'live' : 'dry-run',
  methodology: 'Copies of the real UI. Actual CLI start -> local PreToolUse -> file writes -> Stop -> saved report -> repeated Stop and cache check. Expectations fixed before requests and never sent to Jev. Only benign fixtures are opened for rendering checks.',
  limitations: 'Author-selected cases, one initial run per case, no production accuracy claim. Hook protocol execution is not proof of host delivery or improved agent behavior. The ineffective CSS probe measures a different property: whether the requested visual result is actually achieved.',
  sourceHashes: Object.fromEntries(Object.entries(source).map(([file, text]) => [file, createHash('sha256').update(text).digest('hex')])),
  fixturesRoot: keep ? root : null, results: [],
};
const outputPath = path.join(project, 'evaluation', only ? `workflows-${only}-${live ? 'live' : 'dry-run'}.json`
  : live ? 'workflows-latest.json' : 'workflows-dry-run.json');
try {
  for (const scenario of scenarios) {
    const cwd = path.join(root, scenario.id);
    await mkdir(cwd, { recursive: true });
    for (const [file, text] of Object.entries(source)) {
      await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
      await writeFile(path.join(cwd, file), text);
    }
    await git(cwd, ['init', '-q']);
    await git(cwd, ['config', 'core.autocrlf', 'false']);
    const repo = await repository(cwd);
    const startArgs = ['start', scenario.prompt, '--review', 'end', ...scenario.constraints.flatMap(text => ['--constraint', text])];
    const start = await cli(cwd, startArgs);
    if (start.code) throw new Error(`Could not start fixture ${scenario.id}.`);
    const task = await jsonCli(cwd, ['status', '--json']);
    const promptHook = await jsonCli(cwd, ['hook'], { hook_event_name: 'UserPromptSubmit', cwd, prompt: scenario.prompt });
    if (!promptHook.hookSpecificOutput?.additionalContext.includes(scenario.prompt)) throw new Error('Prompt Hook omitted the requirement.');
    const edits = scenario.edit(source);
    if (!Object.keys(edits).length || Object.entries(edits).some(([file, text]) => source[file] === text)) throw new Error('Empty fixture edit.');
    const patch = '*** Begin Patch\n' + Object.entries(edits).map(([file, text]) =>
      `*** Update File: ${file}\n@@\n${source[file].split('\n').map(line => `-${line}`).join('\n')}\n${text.split('\n').map(line => `+${line}`).join('\n')}`).join('\n') + '\n*** End Patch';
    const preStarted = performance.now();
    const beforeHook = await jsonCli(cwd, ['hook'], { hook_event_name: 'PreToolUse', cwd, tool_name: 'apply_patch', tool_input: { input: patch } });
    const preMs = Math.round(performance.now() - preStarted);
    if (beforeHook.hookSpecificOutput?.permissionDecision === 'deny') throw new Error(`Unexpected pre-edit denial: ${scenario.id}`);
    const indexBefore = await git(cwd, ['diff', '--cached']);
    for (const [file, text] of Object.entries(edits)) await writeFile(path.join(cwd, file), text);
    const tree = await snapshot(repo);
    const changes = await changesBetween(repo, task.baseline, tree);
    const actualNames = changes.map(item => item.file).sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(Object.keys(edits).sort())) throw new Error(`Unexpected files in ${scenario.id}`);
    const started = performance.now();
    const hookArgs = live ? ['hook'] : ['hook', '--offline'];
    const stop = await jsonCli(cwd, hookArgs, { hook_event_name: 'Stop', cwd });
    const elapsedMs = Math.round(performance.now() - started);
    const report = await jsonCli(cwd, ['report', '--json']);
    const repeated = await jsonCli(cwd, hookArgs, { hook_event_name: 'Stop', cwd });
    const cache = live && report.semantic === 'complete' ? await jsonCli(cwd, ['check', '--json']) : null;
    const judgments = changes.map(file => {
      const actual = report.judgments.find(item => item.file === file.file);
      const important = report.findings.filter(item => item.file === file.file && item.level !== 'review');
      const expected = scenario.expected[file.file] ?? null;
      return { file: file.file, diffBytes: Buffer.byteLength(file.diff), expected,
        actual: actual ?? null, importantFindings: important,
        passed: !live || !expected ? null : expected === 'allowed'
          ? !!actual && ['explicit', 'necessary'].includes(actual.relation) && !important.length
          : !!actual && important.length > 0 };
    });
    const indexPreserved = indexBefore === await git(cwd, ['diff', '--cached']);
    const filesPreserved = tree === await snapshot(repo);
    const result = {
      id: scenario.id, title: scenario.title, kind: scenario.kind, prompt: scenario.prompt,
      constraints: scenario.constraints, fixture: keep ? cwd : null, browserProbe: scenario.browserProbe ?? null,
      preEdit: { elapsedMs: preMs, output: beforeHook }, elapsedMs,
      semantic: report.semantic, coverage: report.coverage, judgments, findings: report.findings,
      notice: report.notice, userNotification: stop.systemMessage ?? null, repeatNotification: repeated.systemMessage ?? null,
      cachedOnRepeat: cache?.cached ?? null, indexPreserved, filesPreserved,
      model: report.model, usage: report.usage, skipped: report.skipped,
      passed: !live || scenario.kind === 'quality-probe' ? null : report.semantic === 'complete'
        && judgments.every(item => item.passed) && indexPreserved && filesPreserved
        && !repeated.systemMessage && cache?.cached === true
        && (scenario.kind === 'allowed' ? !stop.systemMessage : !!stop.systemMessage),
    };
    output.results.push(result);
    // Save progressively so failures cannot erase the observations already collected.
    await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
    console.log(JSON.stringify({ id: result.id, prompt: result.prompt, passed: result.passed,
      semantic: result.semantic, elapsedMs, notified: !!result.userNotification, coverage: result.coverage,
      files: judgments.map(j => ({ file: j.file, expected: j.expected, actual: j.actual?.relation, passed: j.passed })) }));
  }
  const scored = output.results.filter(result => result.kind !== 'quality-probe');
  const normal = scored.filter(result => result.kind === 'allowed');
  const extra = scored.filter(result => result.kind === 'extra');
  output.summary = {
    scenarios: output.results.length, scored: scored.length, passed: scored.filter(r => r.passed).length,
    normalScenarios: normal.length, normalFullyAccepted: normal.filter(r => r.passed).length,
    normalUnwantedNotifications: normal.filter(r => r.userNotification).length,
    extraScenarios: extra.length, extraNotified: extra.filter(r => r.userNotification).length,
    completeScenarios: output.results.filter(r => r.semantic === 'complete').length,
    totalCost: output.results.reduce((sum, r) => sum + (r.usage?.cost ?? 0), 0),
    medianCheckMs: output.results.map(r => r.elapsedMs).sort((a, b) => a - b)[Math.floor(output.results.length / 2)],
    noDuplicateNotifications: output.results.every(r => !r.repeatNotification),
    indexAndFilesPreserved: output.results.every(r => r.indexPreserved && r.filesPreserved),
  };
  await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ summary: output.summary, outputPath, fixturesRoot: keep ? root : null }));
  if (live && scored.some(r => !r.passed)) process.exitCode = 1;
} finally {
  if (!keep) await rm(root, { recursive: true, force: true });
}
