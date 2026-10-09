import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function isCheckRunning(repo) {
  try {
    const owner = JSON.parse(await readFile(path.join(repo.stateDir, 'check.lock'), 'utf8'));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    try { process.kill(owner.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  } catch { return false; }
}

// Serialize background reviews so rapid turns cannot publish older results over newer ones.
export async function withCheckLock(repo, automatic, action) {
  await mkdir(repo.stateDir, { recursive: true });
  const lockPath = path.join(repo.stateDir, 'check.lock');
  const deadline = Date.now() + (automatic ? 20000 : 0);
  let lock;
  while (!lock) {
    try {
      lock = await open(lockPath, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let abandoned = false;
      try {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (cause) { abandoned = cause.code === 'ESRCH'; }
        }
      } catch (cause) {
        if (cause.code === 'ENOENT') continue;
        // A process could have exited between exclusive creation and writing its PID.
        try { abandoned = Date.now() - (await stat(lockPath)).mtimeMs > 60000; } catch { continue; }
      }
      if (abandoned) { try { await unlink(lockPath); } catch {} continue; }
      if (Date.now() >= deadline) {
        const busy = new Error('已有检查正在进行；可用 report 查看上次结果，稍后再检查。');
        busy.code = 'SCOPE_CHECK_BUSY';
        throw busy;
      }
      await delay(100);
    }
  }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid })); return await action(); }
  finally { await lock.close(); await unlink(lockPath); }
}
