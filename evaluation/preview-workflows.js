// Serve only the benign rendering probes retained by verify-workflows --keep-fixtures.
import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const outputPath = process.argv[2];
if (!outputPath) throw new Error('Provide an output JSON path for the local preview URLs.');
const report = JSON.parse(await readFile(new URL('./workflows-latest.json', import.meta.url), 'utf8'));
const root = await realpath(report.fixturesRoot);
if (!root.startsWith(await realpath(tmpdir())) || !path.basename(root).startsWith('jev-workflow-eval-')) {
  throw new Error('Unexpected fixture directory.');
}
const allowed = new Set(['font-family', 'file-size', 'compact-layout', 'button-copy', 'ineffective-font']);
const previews = [], servers = [];
for (const item of report.results.filter(r => allowed.has(r.id) && r.browserProbe)) {
  const cwd = await realpath(item.fixture);
  if (cwd !== path.join(root, item.id)) throw new Error('Fixture path mismatch.');
  const { startWorkbench } = await import(pathToFileURL(path.join(cwd, 'src/workbench.js')));
  const { url, server } = await startWorkbench({ cwd, port: 0 });
  servers.push(server);
  previews.push({ id: item.id, url, probe: item.browserProbe,
    scopeRelations: item.judgments.map(j => j.actual?.relation), semantic: item.semantic });
}
await writeFile(outputPath, JSON.stringify(previews, null, 2) + '\n');
console.log(JSON.stringify({ pid: process.pid, previews, outputPath }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  for (const server of servers) { server.close(); server.closeAllConnections(); }
});
