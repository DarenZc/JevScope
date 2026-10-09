import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git, repository } from '../src/repo.js';
import { startTask, amendTask } from '../src/task.js';
import { checkRepository } from '../src/review.js';
import { renderNotice, renderReport } from '../src/report.js';

const dir = await mkdtemp(path.join(tmpdir(), 'jev-scope-demo-'));
try {
  await git(dir, ['init', '-q']);
  await writeFile(path.join(dir, 'export.js'), 'export const format = "json";\n');
  const repo = await repository(dir);
  await startTask(repo, '给当前表格增加 CSV 导出', { constraints: ['不增加历史记录', '不增加后台服务'] });
  await writeFile(path.join(dir, 'export.js'), 'export const format = "csv";\n');
  await writeFile(path.join(dir, 'history.js'), 'export const exportHistory = [];\n');
  console.log('离线演示：使用明确标记的模拟 Jev 分类，不发起 API 请求。\n');
  const report = await checkRepository(repo, {
    judgeImpl: async (_task, changes) => ({
      model: 'demo/mock', usage: {},
      judgments: changes.map(item => ({
        id: item.id, file: item.file, relation: item.file === 'history.js' ? 'extra' : 'explicit',
        requirementId: item.file === 'history.js' ? null : 'R1', confidence: 0.9,
        conflictId: item.file === 'history.js' ? 'C1' : null,
        evidenceId: item.evidenceCandidates[0]?.id, scopeReason: item.file === 'history.js' ? 'constraint' : null,
      })),
    }),
  });
  console.log('默认汇总（最多展示三个需关注的文件）：');
  console.log(renderNotice(report, 'node bin/scope.js report --cwd "项目目录"'));
  console.log('\n主动查看报告时展开：');
  process.stdout.write(renderReport(report));
  const updated = await amendTask(repo, '这次允许保留最近十次导出记录', { drop: ['C1'] });
  console.log('\n用户补充授权后：');
  console.log(`已撤销 C1，保留 ${updated.constraints[0].id}：${updated.constraints[0].text}。默认继续在结束时检查。`);
} finally { await rm(dir, { recursive: true, force: true }); }
