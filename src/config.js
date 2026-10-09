import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHost } from './hosts.js';

export const scopeScript = fileURLToPath(new URL('../bin/scope.js', import.meta.url));
export const toolEnv = fileURLToPath(new URL('../.env', import.meta.url));

export function codexHome(override) {
  return configPaths(override).home;
}

// A string is the original Codex home API, retained for existing callers.
export function configPaths(input = {}) {
  const options = typeof input === 'string' ? { codexHome: input } : input;
  const host = resolveHost(options.host);
  if (options.codexHome !== undefined && host.id !== 'codex') throw new Error('--codex-home 仅用于 Codex；其他宿主请使用 --host-home。');
  if (options.codexHome !== undefined && options.hostHome !== undefined
    && path.resolve(options.codexHome) !== path.resolve(options.hostHome)) throw new Error('--codex-home 与 --host-home 指向不同目录。');
  const selected = options.hostHome ?? options.codexHome ?? process.env[host.env] ?? path.join(homedir(), host.directory);
  if (typeof selected !== 'string' || !selected.trim()) throw new Error(`${host.name} 配置目录不能为空。`);
  const home = path.resolve(selected);
  const directory = path.join(home, 'jev-scope');
  return { host, home, directory, hooks: path.join(home, host.config),
    manifest: path.join(directory, 'install.json'), env: path.join(directory, '.env') };
}

// Explicit environment > persistent user config > this installation's .env.
// Never load the target project's .env or copy credentials during installation.
export function loadEnvironment(override) {
  for (const file of [configPaths(override).env, toolEnv]) {
    try { process.loadEnvFile(file); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`无法加载 Jev Scope 配置文件：${file}`); }
  }
}

export function shellCommand(args, platform = process.platform) {
  const quote = platform === 'win32'
    ? value => `'${String(value).replaceAll("'", "''")}'`
    : value => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
  return `${platform === 'win32' ? '& ' : ''}${args.map(quote).join(' ')}`;
}

export function cliCommand(args, options = {}) {
  const host = resolveHost(options.host);
  const platform = options.platform ?? process.platform;
  // Git Bash accepts C:/...; backslashes inside single quotes are literal there.
  const portable = value => host.id !== 'codex' && platform !== 'win32' && process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
  return shellCommand([portable(options.node ?? process.execPath), portable(options.script ?? scopeScript), ...args,
    ...(host.id !== 'codex' ? ['--host', host.id] : []),
    ...(options.hostHome !== undefined ? ['--host-home', portable(options.hostHome)] : []),
    ...(options.codexHome !== undefined ? ['--codex-home', portable(options.codexHome)] : [])], platform);
}

export function hookCommand(options = {}) {
  const host = resolveHost(options.host);
  const windows = (options.platform ?? process.platform) === 'win32';
  if (host.id === 'codex') return {
    command: cliCommand(['hook'], { ...options, platform: 'posix' }),
    ...(windows ? { commandWindows: cliCommand(['hook'], { ...options, platform: 'win32' }) } : {}),
  };
  if (!windows) return { command: cliCommand(['hook'], { ...options, platform: 'posix' }) };
  // These hosts do not share Codex's commandWindows field. A bare PowerShell
  // launcher works from Git Bash, cmd and PowerShell, without interpolating paths.
  const script = cliCommand(['hook'], { ...options, platform: 'win32' });
  return { command: `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}` };
}
