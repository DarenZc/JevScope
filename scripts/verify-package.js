// Verify the actual npm allowlist; never print file contents or credentials.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Use npm run verify:package.');
const { stdout } = await exec(process.execPath, [npm, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
});
const [result] = JSON.parse(stdout);
const files = result.files.map(file => file.path.replaceAll('\\', '/'));
for (const required of ['bin/scope.js', 'bin/ui.js', 'src/install.js', 'src/config.js', 'web/index.html',
  'package.json', 'README.md', 'LICENSE', '.env.example']) assert.ok(files.includes(required), `Missing ${required}`);
for (const file of files) {
  assert.ok(/^(?:bin\/[^/]+\.js|src\/[^/]+\.js|web\/[^/]+\.(?:js|css|html|svg)|examples\/demo\.js|package\.json|README\.md|LICENSE|\.env\.example)$/.test(file),
    `Unexpected distributable file: ${file}`);
  assert.equal(path.isAbsolute(file), false);
}
console.log(`Package verified: ${files.length} files; no .env, local Hooks, task records or evaluation outputs.`);

// Exercise the archive independently of the checkout and its private .env.
const temp = await mkdtemp(path.join(tmpdir(), 'jev-package-test-'));
let server;
try {
  const packed = await exec(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', temp],
    { cwd: root, windowsHide: true });
  const [archive] = JSON.parse(packed.stdout);
  assert.equal(path.basename(archive.filename), archive.filename);
  await exec('tar', ['-xzf', path.join(temp, archive.filename), '-C', temp], { windowsHide: true });
  const home = path.join(temp, 'codex-home');
  const project = path.join(temp, 'project');
  const cli = path.join(temp, 'package', 'bin', 'scope.js');
  await mkdir(project);
  await exec('git', ['init', '-q'], { cwd: project, windowsHide: true });
  const run = args => exec(process.execPath, [cli, ...args], {
    cwd: project, windowsHide: true, env: { ...process.env, CODEX_HOME: home, OPENROUTER_API_KEY: '' },
  });
  assert.equal(JSON.parse((await run(['install', '--json'])).stdout).changed, true);
  assert.equal(JSON.parse((await run(['install', '--json'])).stdout).changed, false);
  await run(['start', '验证安装后的工具']);
  assert.equal(JSON.parse((await run(['check', '--offline', '--json'])).stdout).files.length, 0);
  const hook = await exec(process.execPath, [cli, 'hook-config', '--codex-home', home], { windowsHide: true });
  assert.equal(Object.keys(JSON.parse(hook.stdout).hooks).length, 3);
  const { startWorkbench } = await import(pathToFileURL(path.join(temp, 'package', 'src', 'workbench.js')));
  const workbench = await startWorkbench({ cwd: project, port: 0 });
  server = workbench.server;
  for (const file of ['/', '/app.js', '/styles.css', '/favicon.svg']) {
    const response = await fetch(new URL(file, workbench.url));
    assert.equal(response.status, 200, `Packed asset unavailable: ${file}`);
    await response.arrayBuffer();
  }
  await run(['uninstall']);
  await assert.rejects(readFile(path.join(home, 'hooks.json')), { code: 'ENOENT' });
  console.log('Packed CLI install/check/uninstall and workbench assets passed in an isolated directory.');
} finally {
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  const target = path.resolve(temp);
  assert.equal(path.dirname(target), path.resolve(tmpdir()));
  assert.ok(path.basename(target).startsWith('jev-package-test-'));
  await rm(target, { recursive: true, force: true });
}
