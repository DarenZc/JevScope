// Evidence is extracted locally from the redacted diff. The classifier selects IDs,
// never supplies code, line numbers, or a free-form explanation.
export const SCOPE_REASONS = {
  independent: 'The concrete changed behavior is neither requested nor needed by any active requirement. It is an independent addition or change, not wiring or implementation of the requested outcome.',
  optional: 'The concrete edit is unrelated cleanup or refactoring; the requested outcome has no demonstrated need for this edit.',
  constraint: 'The concrete edit demonstrably violates an active explicit constraint.',
  none: 'No specific out-of-scope behavior and reason can be established. This includes implementation details, moving existing UI or styles, uncertain purpose, and inert examples of hypothetical behavior.',
};

const compact = (text, max = 180) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

function diffLines(diff) {
  const records = [];
  let oldLine = null, newLine = null, offset = 0, hunk = 0;
  for (const raw of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) { oldLine = Number(header[1]); newLine = Number(header[2]); hunk++; }
    else if (/^(diff |index |--- |\+\+\+ |\\ |\*\*\*)/.test(raw)) { /* metadata */ }
    else if (raw.startsWith('@@')) { oldLine = newLine = null; hunk++; }
    else if (/^[ +\-]/.test(raw)) {
      const sign = raw[0];
      records.push({ sign, text: raw.slice(1), offset, hunk,
        oldLine: sign === '+' ? null : oldLine, newLine: sign === '-' ? null : newLine });
      if (sign !== '+' && oldLine !== null) oldLine++;
      if (sign !== '-' && newLine !== null) newLine++;
    }
    offset += raw.length + 1;
  }
  return records;
}

function location(record, side) {
  const line = side === 'old' ? record.oldLine : record.newLine;
  return { side, line: line > 0 ? line : null, hunk: record.hunk || 1 };
}

function cssFacts(records, side) {
  const facts = [], sign = side === 'old' ? '-' : '+';
  let stack = [], token = '', start, startOffset, changed = false, quote = '', escaped = false, comment = false, hunk;
  const reset = () => { token = ''; start = null; changed = false; };
  const declaration = () => {
    const match = /^\s*(--[\w-]+|[a-z][\w-]*)\s*:\s*([\s\S]+)$/i.exec(token);
    if (match && changed && start && !token.includes('[REDACTED_CREDENTIAL]')) {
      const selector = stack.join(' / ') || '(选择器未显示)';
      facts.push({ key: `${start.hunk}|${selector}|${match[1]}`, selector, property: match[1], value: compact(match[2]),
        record: start, location: location(start, side), offset: startOffset });
    }
    reset();
  };
  for (const record of records) {
    if (record.sign !== sign && record.sign !== ' ') continue;
    if (hunk !== record.hunk) { stack = []; reset(); quote = ''; escaped = comment = false; hunk = record.hunk; }
    for (let i = 0; i < record.text.length; i++) {
      const char = record.text[i], next = record.text[i + 1];
      if (comment) { if (char === '*' && next === '/') { comment = false; i++; } continue; }
      if (!quote && char === '/' && next === '*') { comment = true; i++; continue; }
      if (!start && !/\s/.test(char)) { start = record; startOffset = record.offset + 1 + i; }
      changed ||= record.sign === sign;
      if (quote) {
        token += char;
        if (char === quote && !escaped) quote = '';
        escaped = char === '\\' && !escaped;
        continue;
      }
      if (char === '"' || char === "'") { quote = char; token += char; continue; }
      if (char === '{') { stack.push(compact(token)); reset(); }
      else if (char === '}') { declaration(); stack.pop(); }
      else if (char === ';') declaration();
      else token += char;
    }
    token += '\n';
  }
  declaration();
  return facts;
}

function cssKind(property, value) {
  if (/color|background|fill|stroke|shadow/i.test(property) || (property.startsWith('--') && /#[\da-f]{3,8}\b|rgba?\(|hsla?\(/i.test(value))) return 'color';
  if (/font|line-height|letter-spacing/.test(property)) return 'typography';
  if (/width|height|margin|padding|gap|grid|flex|display|position|inset|top|left|right|bottom/.test(property)) return 'layout';
  return null;
}

export function extractEvidence(diff, file = '') {
  const records = diffLines(diff), result = [], covered = new Set();
  const add = item => {
    if (![item.before, item.after, item.summary].some(text => text?.includes('[REDACTED_CREDENTIAL]'))) result.push(item);
  };
  if (/\.(?:css|scss|less)$/i.test(file)) {
    const before = cssFacts(records, 'old'), after = cssFacts(records, 'new');
    for (const fact of [...before, ...after]) covered.add(fact.record);
    const groups = new Map();
    for (const [facts, side] of [[before, 'left'], [after, 'right']]) for (const fact of facts) {
      if (!groups.has(fact.key)) groups.set(fact.key, { left: [], right: [] });
      groups.get(fact.key)[side].push(fact);
    }
    for (const { left, right } of groups.values()) {
      // Pair only an unambiguous property in the same selector/context. Never
      // invent a previous value for an override that was only newly appended.
      if (left.length === 1 && right.length === 1) {
        if (left[0].value === right[0].value) continue;
        const a = left[0], b = right[0];
        add({ offset: b.offset, location: b.location, beforeLocation: a.location,
          before: a.value, after: b.value, kind: cssKind(b.property, b.value),
          summary: `${compact(b.selector, 65)} · ${b.property}：${a.value} → ${b.value}` });
      } else {
        for (const [facts, verb, field] of [[left, '删除', 'before'], [right, '新增', 'after']]) for (const fact of facts) {
          add({ offset: fact.offset, location: fact.location, [field]: fact.value,
            kind: cssKind(fact.property, fact.value), summary: `${verb} ${compact(fact.selector, 65)} · ${fact.property}: ${fact.value}` });
        }
      }
    }
  }
  for (const record of records) {
    if (record.sign === ' ' || !record.text.trim() || covered.has(record) || record.text.includes('[REDACTED_CREDENTIAL]')) continue;
    // A long/minified line gets several selectable excerpts, retaining its real
    // source line. No excerpt is relabelled as an entire function or behavior.
    const fragments = record.text.matchAll(/[^;\n]{1,220}(?:;|$)|[^;\n]{220}/g);
    for (const match of fragments) {
      const code = compact(match[0]);
      if (!code || /^[{}();,]+$/.test(code)) continue;
      const added = record.sign === '+';
      add({ offset: record.offset + 1 + match.index, location: location(record, added ? 'new' : 'old'),
        [added ? 'after' : 'before']: code, kind: null, summary: `${added ? '新增' : '删除'}代码：${code}` });
    }
  }
  return result.sort((a, b) => a.offset - b.offset).map((item, i) => ({ ...item, id: `E${i + 1}` }));
}

export function evidenceFor(change) {
  if (change.evidenceCandidates) return change.evidenceCandidates;
  return extractEvidence(change.diff, change.file).slice(0, 12);
}

export function groundedJudgment(judgment, change) {
  const evidence = evidenceFor(change).find(item => item.id === judgment.evidenceId);
  const reason = Object.hasOwn(SCOPE_REASONS, judgment.scopeReason ?? '') && judgment.scopeReason !== 'none' ? judgment.scopeReason : null;
  const compatible = !evidence?.kind || !judgment.extraKind || evidence.kind === judgment.extraKind;
  const conflict = judgment.conflictId && evidence && reason === 'constraint' && compatible;
  const extra = judgment.relation === 'extra';
  const justified = evidence && reason && (reason !== 'constraint' || conflict)
    && compatible;
  return { ...judgment, rawRelation: judgment.rawRelation ?? judgment.relation,
    relation: (extra && !justified) || (!extra && judgment.conflictId && !conflict) ? 'uncertain' : judgment.relation,
    conflictId: conflict ? judgment.conflictId : null,
    unsupportedWarning: judgment.unsupportedWarning || (extra && !justified) || Boolean(judgment.conflictId && !conflict),
    evidence: justified || conflict ? evidence : null, scopeReason: reason };
}

export function evidenceLocation(file, evidence) {
  const loc = evidence?.location;
  if (!loc) return file;
  return loc.line ? `${file}:${loc.line}${loc.side === 'old' ? '（原文件）' : ''}` : `${file}（补丁片段 ${loc.hunk}）`;
}

export function explainEvidence(judgment, task) {
  const labels = { color: '修改配色', typography: '修改字体或字号', layout: '调整布局', automation: '增加自动执行', data: '增加数据收集或上报', dependencies: '引入依赖或服务' };
  const label = labels[judgment.extraKind];
  const summary = `${label ? `${label}：` : ''}${judgment.evidence.summary}`;
  const explanation = scope => ({ changeSummary: summary, scopeExplanation: scope, reason: `${summary}；${scope}` });
  if (judgment.scopeReason === 'constraint') {
    const constraint = task.constraints.find(item => item.id === judgment.conflictId);
    return explanation(`疑似违反 ${constraint?.id ?? judgment.conflictId}「${constraint?.text ?? ''}」`);
  }
  const requirement = task.requirements.find(item => item.id === judgment.requirementId)
    ?? (task.requirements.length === 1 ? task.requirements[0] : null);
  const scope = requirement ? `${requirement.id}「${compact(requirement.text, 65)}」` : `当前需求（${task.requirements.map(item => item.id).join('、')}）`;
  return explanation(`${judgment.scopeReason === 'optional' ? '疑似无助于' : '疑似超出'}${scope}${judgment.scopeReason === 'optional' ? '的整理' : '的独立改动'}`);
}
