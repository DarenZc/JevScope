#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { repository } from '../src/repo.js';
import { activeTask, amendTask, readState, startTask, writeState } from '../src/task.js';
import { checkRepository } from '../src/review.js';
import { renderReport, reportExitCode } from '../src/report.js';
import { hookConfiguration, runHook, takeNotice } from '../src/hooks.js';
import { isCheckRunning } from '../src/check-lock.js';
import { loadEnvironment, configPaths } from '../src/config.js';
import { supportedHosts } from '../src/hosts.js';
import { install, uninstall, doctor } from '../src/install.js';

const HELP = `Jev Scope — 对照需求检查开发改动范围

node bin/scope.js start "修复登录超时" [--constraint "保留现有登录方式"]
node bin/scope.js amend "这次允许保存历史" --drop C1
node bin/scope.js status [--history]
node bin/scope.js check [--offline] [--json] [--refresh]
node bin/scope.js check --for-chat
node bin/scope.js report [--json]
node bin/scope.js finish
node bin/scope.js hook-config
node bin/scope.js hosts [--json]
node bin/scope.js install [--host codex|claude-code|workbuddy|codebuddy]
node bin/scope.js uninstall [--host 宿主]
node bin/scope.js doctor [--host 宿主] [--json]

start / amend 选项：
  --mode review|change    只读审查 / 允许必要修改（默认 change）
  --constraint "原文"     用户明确约束，可重复
  --allow src/auth/       可编辑目录，以 / 结尾；或精确文件，可重复
  --no-deps               显式禁止新增 npm 依赖
  --allow-deps            移除禁止新增依赖的限制
  --review end|live|manual 结束时检查（默认）/ 修改前检查 / 仅手动检查
  --drop C1              amend 撤销旧需求或约束，保留记录；可重复

所有仓库命令可加 --cwd "项目目录"。每个 Git 工作区保存一个活动任务。
report 只查看上次结果，不发送 API 请求；“需核对”项在这里展开。
check --for-chat 用于最终答复前检查：仅输出尚未展示的简短提醒，正常、重复或手动模式保持安静。
install 将 Hooks 合并到指定宿主的全局配置，默认 Codex；uninstall 只移除登记的条目。
安装后在对应客户端审阅并启用 Hooks。仅支持本地 Git 工作区，不适用于云端编排。
所有命令支持 --host 和 --host-home "配置目录"；--codex-home 保持兼容。
默认目录：~/.codex、~/.claude、~/.workbuddy、~/.codebuddy；优先使用宿主自己的配置目录环境变量。
在所选宿主的 jev-scope/.env 或本工具 .env 中配置 OPENROUTER_API_KEY；进程环境变量优先。
check 退出码：0 未发现问题；1 有待核对项；2 检查不完整或发生错误。
hook-config 只输出所选宿主的配置，不自动安装或授予信任。
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true, strict: true,
    options: {
      cwd: { type: 'string' }, mode: { type: 'string' },
      constraint: { type: 'string', multiple: true }, allow: { type: 'string', multiple: true },
      'no-deps': { type: 'boolean' }, 'allow-deps': { type: 'boolean' },
      review: { type: 'string' }, drop: { type: 'string', multiple: true }, history: { type: 'boolean' },
      offline: { type: 'boolean' }, json: { type: 'boolean' }, refresh: { type: 'boolean' },
      'for-chat': { type: 'boolean' },
      'codex-home': { type: 'string' },
      host: { type: 'string' }, 'host-home': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) { process.stdout.write(HELP); return; }
  if (values['for-chat'] && (command !== 'check' || values.json)) throw new Error('--for-chat 仅用于 check，不能与 --json 同用。');
  const globalOptions = { host: values.host, hostHome: values['host-home'], codexHome: values['codex-home'] };
  configPaths(globalOptions); // Validate options before any configuration or task mutation.
  if (command === 'hosts') {
    const hosts = supportedHosts().map(({ id, name, directory, env, config }) => ({ id, name, config: `~/${directory}/${config}`, env }));
    process.stdout.write(values.json ? `${JSON.stringify(hosts, null, 2)}\n`
      : `${hosts.map(host => `${host.id} · ${host.name} · ${host.config}`).join('\n')}\n`);
    return;
  }
  if (command === 'hook-config') { process.stdout.write(`${JSON.stringify(hookConfiguration(globalOptions), null, 2)}\n`); return; }
  if (command === 'install' || command === 'uninstall') {
    const result = await (command === 'install' ? install : uninstall)(globalOptions);
    if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (command === 'install') process.stdout.write([
      result.changed ? `已安装 ${result.name} 全局 Jev Scope Hooks。` : `${result.name} 全局 Jev Scope Hooks 已是最新，无重复添加。`,
      `配置：${result.hooksPath}`, `密钥：${result.envPath}（也可继续使用本工具 .env）`,
      result.trust,
      ...(result.backup ? [`原配置备份：${result.backup}`] : []), '',
    ].join('\n'));
    else process.stdout.write([
      result.changed ? '已移除本工具登记的全局 Hooks。' : '没有需要移除的全局 Jev Scope Hooks。',
      ...(result.preserved ? [`保留了 ${result.preserved} 个手动修改过的条目，请在 /hooks 中核对。`] : []),
      ...(result.unmatched > result.preserved ? ['部分登记条目已改变或不存在，未删除未知配置；请在 /hooks 中核对。'] : []),
      '密钥、备份和项目报告已保留。', '',
    ].join('\n'));
    return;
  }
  loadEnvironment(globalOptions);
  if (command === 'doctor') {
    const result = await doctor(globalOptions);
    process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n`
      : `${result.checks.map(check => `${check.ok ? '✓' : '!'} ${check.name}：${check.detail}`).join('\n')}\n${result.trust}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (command === 'hook') {
    let output;
    try {
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      output = await runHook(JSON.parse(input), { ...globalOptions, offline: values.offline });
    }
    catch (error) { output = { systemMessage: `Jev Scope 检查未完成：${error.message}` }; }
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }
  if (!['start', 'amend', 'status', 'check', 'report', 'finish'].includes(command)) throw new Error(`未知命令：${command}。使用 --help 查看用法。`);
  if (values.drop && command !== 'amend') throw new Error('--drop 仅用于 amend。');
  if (values['no-deps'] && values['allow-deps']) throw new Error('--no-deps 和 --allow-deps 不能同时使用。');
  const repo = await repository(values.cwd);
  const options = {
    mode: values.mode, constraints: values.constraint, allowedPaths: values.allow,
    noDependencies: values['no-deps'] ? true : values['allow-deps'] ? false : undefined,
    reviewMode: values.review, drop: values.drop,
  };
  if (command === 'start' || command === 'amend') {
    const text = args.join(' ');
    if (command === 'amend' && !text && !values.mode && !values.constraint && !values.allow && !values.review && !values.drop && options.noDependencies === undefined) {
      throw new Error('请给出补充需求或要更新的边界选项。');
    }
    const task = command === 'start' ? await startTask(repo, text, options) : await amendTask(repo, text, options);
    process.stdout.write(`已${command === 'start' ? '建立' : '更新'}任务（版本 ${task.revision}）：${task.requirements[0].text}\n`);
    if (values.drop) process.stdout.write(`已撤销：${values.drop.join('、')}；历史可用 status --history 查看。\n`);
    return;
  }
  if (command === 'check') {
    if (values['for-chat']) {
      const task = await activeTask(repo);
      if (!task?.active || task.reviewMode === 'manual') return;
    }
    const report = await checkRepository(repo, { offline: values.offline, refresh: values.refresh, automatic: values['for-chat'] });
    if (values['for-chat']) {
      const message = await takeNotice(repo, report, 'chat', values.host);
      if (message) process.stdout.write(`${message}\n`);
      return;
    }
    process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
    process.exitCode = reportExitCode(report);
    return;
  }
  const task = await activeTask(repo);
  if (command === 'report') {
    const report = await readState(repo, 'latest.json');
    const running = await isCheckRunning(repo);
    if (!report || report.taskId !== task?.id) { process.stdout.write(running ? '正在检查，报告尚未生成。\n' : '当前任务尚无检查报告。可运行 check。\n'); return; }
    const saved = { ...report, stale: task.revision !== report.revision };
    process.stdout.write(values.json ? `${JSON.stringify(saved, null, 2)}\n`
      : `${running ? '正在检查；以下为上次结果。' : '上次检查记录（未重新扫描当前文件）。'}\n${renderReport(saved)}`);
    process.exitCode = reportExitCode(saved);
    return;
  }
  if (!task) { process.stdout.write('当前工作区尚未建立任务。\n'); return; }
  if (command === 'finish') {
    task.active = false;
    await writeState(repo, 'task.json', task);
    process.stdout.write('已结束任务，文件和 Git 暂存区未作修改。\n');
  } else if (values.json) process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
  else {
    const latest = await readState(repo, 'latest.json');
    const running = await isCheckRunning(repo);
    process.stdout.write([
      `${task.active ? '活动' : '已结束'}任务 · ${task.mode} · 版本 ${task.revision}`,
      ...task.requirements.map(item => `${item.id}：${item.text}`),
      ...task.constraints.map(item => `${item.id}：${item.text}`),
      ...(task.allowedPaths.length ? [`允许路径：${task.allowedPaths.join('、')}`] : []),
      ...(task.noDependencies ? ['禁止新增 npm 依赖'] : []),
      `检查方式：${({ end: '结束时检查', live: '每次修改前检查', manual: '仅手动检查' })[task.reviewMode ?? 'end']}`,
      running ? '检查状态：正在检查' : latest?.taskId === task.id
        ? `上次报告：需求版本 ${latest.revision} · ${latest.checkedAt}${latest.revision !== task.revision ? '（已过期）' : ''}；用 report 查看`
        : '检查状态：尚无报告',
      ...(values.history ? (task.retired ?? []).map(item => `已撤销 ${item.id}（版本 ${item.retiredRevision}）：${item.text}`) : []),
      `本地记录：${repo.stateDir}`, '',
    ].join('\n'));
  }
}

main().catch(error => { process.stderr.write(`Jev Scope：${error.message}\n`); process.exitCode = 2; });
