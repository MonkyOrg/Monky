const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execute = promisify(execFile);
const mib = bytes => Math.round(bytes / (1024 * 1024) * 100) / 100;
const round = value => Math.round(value * 100) / 100;

// One Windows snapshot of a root process and all of its descendants. Electron
// clients spread work across renderer, GPU, network and audio utility processes,
// so comparing only the main PID would understate the full client.
async function sampleTree(rootPid) {
  assert.equal(process.platform, 'win32', 'Process accounting uses Windows performance counters');
  assert.ok(Number.isSafeInteger(rootPid) && rootPid > 0, 'A positive root PID is required');
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $root = ${rootPid}
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($root)
    do {
      $added = $false
      foreach ($p in $all) {
        if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true }
      }
    } while ($added)
    $seconds = [System.Diagnostics.Stopwatch]::GetTimestamp() / [System.Diagnostics.Stopwatch]::Frequency
    $processes = foreach ($id in $ids) {
      $p = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($p) {
        [pscustomobject]@{
          pid = $p.Id; name = $p.ProcessName
          cpuSeconds = $p.TotalProcessorTime.TotalSeconds
          workingSetBytes = $p.WorkingSet64; privateBytes = $p.PrivateMemorySize64; threads = $p.Threads.Count
        }
      }
    }
    if (-not ($processes | Where-Object pid -eq $root)) { throw "Root process $root is not running" }
    [pscustomobject]@{ seconds = $seconds; logicalProcessors = [Environment]::ProcessorCount; processes = @($processes) } |
      ConvertTo-Json -Compress -Depth 3
  `], { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout);
  assert.ok(Number.isFinite(result.seconds) && Array.isArray(result.processes) && result.processes.length > 0);
  return result;
}

// Summarizes consecutive tree samples. CPU is attributed per PID across each
// interval, so processes that start or exit mid-measurement are not miscounted.
function summarize(samples) {
  assert.ok(samples.length >= 2, 'At least two samples are required');
  const first = samples[0];
  const last = samples.at(-1);
  const seconds = last.seconds - first.seconds;
  assert.ok(seconds > 0, 'Samples must advance in time');
  const intervalCpu = [];
  let cpuSeconds = 0;
  for (let index = 1; index < samples.length; index++) {
    const before = new Map(samples[index - 1].processes.map(value => [value.pid, value.cpuSeconds]));
    let used = 0;
    for (const value of samples[index].processes) {
      const previous = before.get(value.pid);
      if (previous !== undefined && value.cpuSeconds >= previous) used += value.cpuSeconds - previous;
    }
    const elapsed = samples[index].seconds - samples[index - 1].seconds;
    cpuSeconds += used;
    intervalCpu.push(used / elapsed * 100);
  }
  const totals = samples.map(sample => sample.processes.reduce((sum, value) => ({
    workingSetBytes: sum.workingSetBytes + value.workingSetBytes,
    privateBytes: sum.privateBytes + value.privateBytes,
    threads: sum.threads + value.threads,
  }), { workingSetBytes: 0, privateBytes: 0, threads: 0 }));
  const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const oneCore = cpuSeconds / seconds * 100;
  return {
    intervalSeconds: round(seconds),
    samples: samples.length,
    processes: last.processes.length,
    // 100% = one logical processor, like the per-process Windows accounting.
    oneCoreCpuPercent: round(oneCore),
    peakIntervalOneCoreCpuPercent: round(Math.max(...intervalCpu)),
    // Normalized by all logical processors, comparable to Task Manager's total.
    systemCpuPercent: round(oneCore / last.logicalProcessors),
    workingSetMiB: mib(totals.at(-1).workingSetBytes),
    averageWorkingSetMiB: mib(average(totals.map(value => value.workingSetBytes))),
    peakWorkingSetMiB: mib(Math.max(...totals.map(value => value.workingSetBytes))),
    privateMiB: mib(totals.at(-1).privateBytes),
    peakPrivateMiB: mib(Math.max(...totals.map(value => value.privateBytes))),
    threads: totals.at(-1).threads,
  };
}

async function measureTree(rootPid, { seconds, intervalSeconds = 5, sleep }) {
  assert.ok(seconds >= intervalSeconds && intervalSeconds > 0, 'Duration must cover at least one interval');
  const samples = [await sampleTree(rootPid)];
  const end = samples[0].seconds + seconds;
  while (samples.at(-1).seconds < end) {
    await sleep(Math.min(intervalSeconds, end - samples.at(-1).seconds) * 1000);
    samples.push(await sampleTree(rootPid));
  }
  return summarize(samples);
}

module.exports = { sampleTree, summarize, measureTree };
