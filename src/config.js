import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const scopeScript = fileURLToPath(new URL('../bin/scope.js', import.meta.url));
export const toolEnv = fileURLToPath(new URL('../.env', import.meta.url));

export function codexHome(override) {
  const directory = override ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
  if (!directory.trim()) throw new Error('Codex 配置目录不能为空。');
  return path.resolve(directory);
}

export function configPaths(override) {
  const home = codexHome(override);
  const directory = path.join(home, 'jev-scope');
  return { home, directory, hooks: path.join(home, 'hooks.json'),
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
  return shellCommand([options.node ?? process.execPath, options.script ?? scopeScript, ...args,
    ...(options.codexHome ? ['--codex-home', options.codexHome] : [])], options.platform);
}
