import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEvidence, evidenceLocation, groundedJudgment } from '../src/evidence.js';
import { planReview } from '../src/review-plan.js';
import { buildRequest } from '../src/jev.js';
import { reviewChanges } from '../src/review.js';
import { renderNotice, renderReport } from '../src/report.js';
import { reportView, details } from '../web/views.js';

const task = { id: 'evidence-test', revision: 1, mode: 'change', allowedPaths: [],
  requirements: [{ id: 'R1', text: '只改字体' }], constraints: [] };
const colorChange = { id: 'F1', file: 'web/styles.css', operation: 'M', diff:
  '@@ -20,4 +20,4 @@\n .button {\n-  color: #222;\n+  color: #f00;\n   font-size: 14px;\n }' };

function response(request, choices = {}, mutate = () => {}) {
  const result = { model: 'fixture', answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const selected = choices[id] ?? (id.endsWith('_relation') ? 'extra' : id.endsWith('_basis') ? 'R1'
      : id.endsWith('_extra_kind') ? 'color' : id.endsWith('_evidence') ? 'E1'
        : id.endsWith('_scope_reason') ? 'independent' : 'none');
    const keys = Object.keys(question.criteria);
    return [id, { type: 'choice', choice: selected, confidence: 0.9,
      probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? 0.9 : 0.1 / (keys.length - 1)])) }];
  })) };
  mutate(result);
  return { ok: true, json: async () => result };
}
const options = (choices, mutate) => ({ apiKey: 'fixture', fetchImpl: async (_url, init) => response(JSON.parse(init.body), choices, mutate) });

test('CSS evidence identifies selector, changed values and real source lines', () => {
  const evidence = extractEvidence(colorChange.diff, colorChange.file);
  assert.equal(evidence.length, 1);
  assert.deepEqual(evidence[0].location, { side: 'new', line: 21, hunk: 1 });
  assert.deepEqual(evidence[0].beforeLocation, { side: 'old', line: 21, hunk: 1 });
  assert.equal(evidence[0].before, '#222');
  assert.equal(evidence[0].after, '#f00');
  assert.match(evidence[0].summary, /\.button · color：#222 → #f00/);
});

test('CSS evidence does not invent previous values across selectors, hunks or appended overrides', () => {
  for (const diff of [
    '@@ -1 +1 @@\n-.a { color: red; }\n+.b { color: blue; }',
    '@@ -1 +1 @@\n-.a { color: red; }\n@@ -20 +20 @@\n+.a { color: blue; }',
    '@@ -1 +1,2 @@\n .a { color: red; }\n+.a { color: blue; }',
  ]) {
    const evidence = extractEvidence(diff, 'style.css');
    assert.ok(evidence.length);
    assert.ok(evidence.every(item => !item.before || !item.after));
    assert.ok(evidence.every(item => !item.summary.includes('→')));
  }
  assert.deepEqual(extractEvidence('@@ -1 +1 @@\n-.a{color:red;}\n+.a { color: red; }', 'style.css'), []);
});

test('removed code and unnumbered pre-edit patches retain honest locations', () => {
  const removed = extractEvidence('@@ -42 +41,0 @@\n-startPolling();', 'app.js')[0];
  assert.equal(evidenceLocation('app.js', removed), 'app.js:42（原文件）');
  const proposed = extractEvidence('*** Update File: app.js\n@@\n+startPolling();', 'app.js')[0];
  assert.equal(evidenceLocation('app.js', proposed), 'app.js（补丁片段 1）');
  assert.equal(proposed.location.line, null);
});

test('minified multibyte CSS retains tail evidence after splitting and bounds request size', () => {
  const diff = '@@ -0,0 +1 @@\n+' + Array.from({ length: 600 }, (_, i) => `.字${i}{color: #abc;}`).join('') + '.tail{color: #f00;}';
  const plan = planReview(task, [{ ...colorChange, diff }]);
  assert.equal(plan.units.map(item => item.diff).join(''), diff);
  const tail = plan.units.at(-1).evidenceCandidates.find(item => item.summary.includes('.tail'));
  assert.ok(tail);
  assert.equal(tail.location.line, 1);
  assert.ok(plan.units.every(unit => unit.evidenceCandidates.every(item => item.offset >= unit.part.start && item.offset < unit.part.end)));
  assert.ok(plan.units.some(unit => unit.evidenceCandidatesTruncated));
  assert.ok(plan.units.every(unit => unit.evidenceCandidates.length <= 12));
  assert.ok(plan.batches.every(batch => Buffer.byteLength(JSON.stringify(buildRequest(task, batch.changes, 'jev-1.13', batch.context))) <= 48000));
});

test('missing, forged or low-probability evidence and scope reasons cannot trigger alerts', async () => {
  for (const suffix of ['evidence', 'scope_reason']) for (const variant of ['missing', 'forged', 'low', 'none']) {
    const report = await reviewChanges(task, [colorChange], options({}, result => {
      const id = `F1_${suffix}`, answer = result.answers[id];
      if (variant === 'missing') delete result.answers[id];
      if (variant === 'forged') answer.choice = 'invented-source-line';
      if (variant === 'none') { answer.choice = 'none'; answer.probabilities = Object.fromEntries(Object.keys(answer.probabilities).map(key => [key, key === 'none' ? 1 : 0])); }
      if (variant === 'low') answer.probabilities = Object.fromEntries(Object.keys(answer.probabilities)
        .map(key => [key, key === answer.choice ? 0.4 : 0.6 / (Object.keys(answer.probabilities).length - 1)]));
    }));
    assert.equal(report.semantic, 'complete', `${suffix}/${variant}`);
    assert.equal(report.judgments[0].rawRelation, 'extra');
    assert.equal(report.judgments[0].relation, 'uncertain');
    assert.equal(renderNotice(report), '');
    assert.match(renderReport(report), /证据不足/);
  }
});

test('grounding uses local evidence only and rejects incompatible category labels', () => {
  const change = planReview(task, [colorChange]).units[0];
  const raw = { relation: 'extra', evidenceId: 'E1', scopeReason: 'independent',
    evidence: { summary: 'forged description', location: { line: 999 } } };
  assert.equal(groundedJudgment(raw, change).evidence.location.line, 21);
  assert.doesNotMatch(groundedJudgment(raw, change).evidence.summary, /forged/);
  assert.equal(groundedJudgment({ ...raw, extraKind: 'automation' }, change).relation, 'uncertain');
  const inconsistentConflict = groundedJudgment({ ...raw, extraKind: 'automation', scopeReason: 'constraint', conflictId: 'C1' }, change);
  assert.equal(inconsistentConflict.relation, 'uncertain');
  assert.equal(inconsistentConflict.conflictId, null);
});

test('explicit constraints require concrete evidence even when relation is allowed', async () => {
  const constrained = { ...task, constraints: [{ id: 'C1', text: '不改颜色' }] };
  const choices = { F1_relation: 'explicit', F1_conflict: 'C1', F1_scope_reason: 'constraint' };
  const report = await reviewChanges(constrained, [colorChange], options(choices));
  assert.match(renderNotice(report), /web\/styles\.css:21.*#222 → #f00.*C1「不改颜色」/);
  const unsupported = await reviewChanges(constrained, [colorChange], options({ ...choices, F1_evidence: 'none' }));
  assert.equal(renderNotice(unsupported), '');
  assert.equal(unsupported.judgments[0].relation, 'uncertain');
  assert.equal(unsupported.judgments[0].conflictId, null);
});

test('chat, report and UI show the same concrete change and safely escape source text', async () => {
  const report = await reviewChanges(task, [colorChange], options());
  assert.match(renderNotice(report), /web\/styles\.css:21：修改配色：\.button · color：#222 → #f00；疑似超出R1「只改字体」/);
  assert.match(renderReport(report), /改前：#222\n  改后：#f00/);
  const file = { ...colorChange, findings: report.findings, relation: 'extra', additions: 1, deletions: 1, requirementId: 'R1' };
  const data = { task, report, files: [file] }, ui = { selected: colorChange.file };
  assert.match(reportView(data, ui), /web\/styles\.css:21/);
  assert.match(details(data, ui), /web\/styles\.css:21/);
  report.findings[0].reason += '<img src=x onerror=alert(1)>';
  for (const html of [reportView(data, ui), details(data, ui)]) {
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  }
  report.findings[0].changeSummary = '长代码'.repeat(100);
  assert.match(renderNotice(report), /…；疑似超出R1「只改字体」/);
});

test('credentials are removed before evidence candidates and descriptions are built', () => {
  const secret = ['sensitive', 'fixture', 'value'].join('-');
  const diff = `@@ -0,0 +1 @@\n+const api_key = "${secret}"; sendAnalytics();`;
  const plan = planReview(task, [{ ...colorChange, file: 'app.js', diff }]);
  assert.equal(plan.redacted.length, 1);
  assert.doesNotMatch(JSON.stringify(plan.units), new RegExp(secret));
  assert.deepEqual(plan.units[0].evidenceCandidates, []);
});
