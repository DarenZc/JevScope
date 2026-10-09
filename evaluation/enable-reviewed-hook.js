// Explicit setup action, never run by npm test. The user must authorize trusting the reviewed hook.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hookConfiguration } from '../src/hooks.js';
import { connect, executable } from './codex-rpc.js';

if (!process.argv.includes('--trust-reviewed-hook')) {
  console.log('After user authorization: node evaluation/enable-reviewed-hook.js --trust-reviewed-hook [--alias=<same-project-path>]');
  process.exit(0);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const cwds = [root];
for (const argument of process.argv.filter(arg => arg.startsWith('--alias='))) {
  const alias = argument.slice(8);
  if (await realpath(alias) !== await realpath(root)) throw new Error('Alias must resolve to this project.');
  cwds.push(alias);
}
const definition = JSON.parse(await readFile(path.join(root, '.codex/hooks.json'), 'utf8'));
if (!isDeepStrictEqual(definition, hookConfiguration())) throw new Error('Hook definition differs from the reviewed code.');
const stop = definition.hooks.Stop[0].hooks[0];
const client = await connect({ cwd: root });
try {
  const initial = await client.request('hooks/list', { cwds });
  const targets = new Map();
  for (const entry of initial.data) {
    for (const hook of entry.hooks) {
      if (hook.eventName !== 'stop' || hook.handlerType !== 'command') continue;
      if (await realpath(hook.sourcePath).catch(() => '') !== await realpath(path.join(root, '.codex/hooks.json'))) continue;
      if (![stop.command, stop.commandWindows].includes(hook.command) || hook.async || hook.timeoutSec !== 45 || !hook.enabled) {
        throw new Error('Discovered Stop does not match the enabled synchronous hook under review.');
      }
      targets.set(hook.key, hook);
    }
  }
  if (!targets.size) throw new Error('No matching project Stop hook discovered.');
  const before = await client.request('config/read', { includeLayers: true, cwd: root });
  const layer = before.layers.find(item => item.name.type === 'user' && !item.name.profile);
  if (!layer) throw new Error('User config layer unavailable.');
  const state = structuredClone(layer.config.hooks?.state ?? {});
  for (const hook of targets.values()) state[hook.key] = { ...state[hook.key], trusted_hash: hook.currentHash };
  const expected = structuredClone(layer.config);
  expected.hooks = { ...expected.hooks, state };
  await client.request('config/batchWrite', { filePath: layer.name.file, expectedVersion: layer.version,
    edits: [{ keyPath: 'hooks.state', value: state, mergeStrategy: 'replace' }], reloadUserConfig: true });
  const after = await client.request('config/read', { includeLayers: true, cwd: root });
  const updated = after.layers.find(item => item.name.type === 'user' && !item.name.profile);
  if (!isDeepStrictEqual(updated.config, expected)) throw new Error('Unexpected config difference; inspection required.');
  const listed = await client.request('hooks/list', { cwds });
  const sources = new Set(cwds.map(cwd => path.resolve(cwd, '.codex/hooks.json')));
  const entries = listed.data.map(entry => ({ cwd: entry.cwd, warnings: entry.warnings, errors: entry.errors,
    hooks: entry.hooks.filter(hook => sources.has(path.resolve(hook.sourcePath)))
      .map(hook => ({ event: hook.eventName, enabled: hook.enabled, async: hook.async, trustStatus: hook.trustStatus, sourcePath: hook.sourcePath })) }));
  if (entries.some(entry => entry.hooks.some(hook => hook.event === 'stop' && hook.trustStatus !== 'trusted'))) {
    throw new Error('Stop hook was not trusted after the configuration write.');
  }
  const record = { checkedAt: new Date().toISOString(), executable, userAuthorized: true, unrelatedConfigPreserved: true, entries };
  await writeFile(path.join(root, 'evaluation/codex-hook-status.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify(record));
} finally { await client.close(); }
