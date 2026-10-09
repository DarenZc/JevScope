#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startWorkbench } from '../src/workbench.js';
import { loadEnvironment } from '../src/config.js';

try {
  const { values } = parseArgs({ options: { cwd: { type: 'string' }, port: { type: 'string' },
    'codex-home': { type: 'string' }, host: { type: 'string' }, 'host-home': { type: 'string' } } });
  loadEnvironment({ host: values.host, hostHome: values['host-home'], codexHome: values['codex-home'] });
  const port = values.port === undefined ? 4173 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口须为 0～65535 的整数。');
  const { server, url } = await startWorkbench({ cwd: values.cwd, port });
  process.stdout.write(`Jev Scope 工作台已启动：${url}\n按 Ctrl+C 停止。\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  });
} catch (error) {
  process.stderr.write(`Jev Scope：${error.code === 'EADDRINUSE' ? '端口已被占用，请使用 --port 指定其他端口。' : error.message}\n`);
  process.exitCode = 1;
}
