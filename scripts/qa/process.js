import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function terminateOwnedTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('Invalid QA-owned process ID.');
  if (process.platform === 'win32') {
    await exec('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 })
      .catch(error => { if (![128, 255].includes(error.code)) throw error; });
    return;
  }
  const { stdout } = await exec('ps', ['-eo', 'pid=,ppid='], { timeout: 5000 });
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, parent] of rows) if (owned.has(parent) && !owned.has(child)) { owned.add(child); changed = true; }
  }
  for (const child of [...owned].reverse()) {
    try { process.kill(child, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export function startOwnedProcess(command, args, { cwd, env, runId, label, onMessage = () => {}, onFailure = () => {}, timeoutMs = 60_000 }) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let output = '', exited = false, stopping = false;
  let resolveReady, rejectReady, resolveClosed;
  const requests = new Map();
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  ready.catch(() => {});
  const fail = error => {
    rejectReady(error);
    if (!stopping) onFailure(error);
  };
  const timeout = setTimeout(() => fail(new Error(`${label}: readiness timed out.\n${output}`)), timeoutMs);
  const log = data => { output = (output + data.toString()).slice(-12_000); };
  child.stdout.on('data', log);
  child.stderr.on('data', log);
  child.once('error', error => { clearTimeout(timeout); fail(error); });
  child.once('close', (code, signal) => {
    exited = true;
    clearTimeout(timeout);
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error(`${label} closed.`)); }
    requests.clear();
    resolveClosed({ code, signal });
    if (!stopping) fail(new Error(`${label} exited unexpectedly (${code ?? signal}).\n${output}`));
  });
  child.on('message', message => {
    if (!message || typeof message !== 'object') return;
    try { onMessage(message); } catch (error) { fail(error); return; }
    if (message.type === 'qa-failed') {
      clearTimeout(timeout);
      fail(new Error(`${label}: ${message.error}`));
    }
    if (message.type === 'qa-service-ready' || (message.type === 'qa-report' && message.report?.phase === 'ready')) {
      clearTimeout(timeout);
      resolveReady(message.value ?? message.report);
    }
    if (message.type === 'qa-report' && message.report?.phase === 'failed') {
      clearTimeout(timeout);
      fail(new Error(`${label}: ${message.report.error}`));
    }
    if (message.type === 'qa-response') {
      const request = requests.get(message.id);
      if (request) {
        clearTimeout(request.timer);
        requests.delete(message.id);
        if (message.error) request.reject(new Error(`${label}: ${message.error}`));
        else request.resolve(message.value);
      }
    }
  });
  const call = (type, value) => new Promise((resolve, reject) => {
    if (exited || !child.connected) return reject(new Error(`${label} is not responsive.`));
    const id = randomUUID();
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`${label}: ${type} timed out.`)); }, 30_000);
    requests.set(id, { resolve, reject, timer });
    child.send({ type, id, runId, value }, error => {
      if (!error) return;
      clearTimeout(timer);
      requests.delete(id);
      reject(error);
    });
  });
  return {
    child, ready, closed, call, isClosed: () => exited,
    async stop() {
      stopping = true;
      clearTimeout(timeout);
      if (!exited && child.connected) child.send({ type: 'qa-stop', runId }, () => {});
      let deadline;
      const stopped = await Promise.race([
        closed,
        new Promise(resolve => { deadline = setTimeout(() => resolve(null), 8000); }),
      ]);
      clearTimeout(deadline);
      if (!stopped && !exited) {
        await terminateOwnedTree(child.pid);
        const killed = await Promise.race([
          closed,
          new Promise(resolve => { deadline = setTimeout(() => resolve(null), 2500); }),
        ]);
        clearTimeout(deadline);
        if (!killed) throw new Error(`${label}: could not confirm termination of owned PID ${child.pid}.`);
        throw new Error(`${label} required forced process-tree cleanup; QA shutdown was not clean.\n${output.slice(-4000)}`);
      }
      if (stopped?.code !== 0) throw new Error(`${label} exited with ${stopped?.code ?? stopped?.signal}.\n${output}`);
    },
  };
}
