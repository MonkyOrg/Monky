// Samples an already running voice client (Monky Light or the full Monky
// client) and prints one JSON result. It only reads process accounting; it never
// starts, stops or signals the measured application.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const { promisify } = require('node:util');
const { measureTree } = require('./process_sampler.cjs');

const USAGE = `Usage: npm run measure:client -- (--pid <id> | --name <process>) --label <text> [--seconds 60] [--interval 5] [--output results.jsonl]
  --name selects the single top-level process with that name (for example monky-light or Monky).`;

function parse(args) {
  const options = { seconds: 60, interval: 5 };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[++index];
    if (value === undefined) throw new Error(`${flag} requires a value\n${USAGE}`);
    if (flag === '--pid') options.pid = Number(value);
    else if (flag === '--name') options.name = value;
    else if (flag === '--label') options.label = value;
    else if (flag === '--seconds') options.seconds = Number(value);
    else if (flag === '--interval') options.interval = Number(value);
    else if (flag === '--output') options.output = value;
    else throw new Error(`Unknown option ${flag}\n${USAGE}`);
  }
  if ((options.pid === undefined) === (options.name === undefined) || !options.label ||
      !(options.seconds > 0) || !(options.interval > 0) || options.interval > options.seconds) {
    throw new Error(USAGE);
  }
  if (options.name !== undefined && !/^[A-Za-z0-9_.-]+$/.test(options.name)) {
    throw new Error('--name must be a plain process name without extension');
  }
  return options;
}

async function rootByName(name) {
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $matches = @(Get-CimInstance Win32_Process -Filter "Name = '${name}.exe'")
    $ids = @($matches | ForEach-Object { [int]$_.ProcessId })
    @($matches | Where-Object { $ids -notcontains [int]$_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId }) |
      ConvertTo-Json -Compress
  `], { windowsHide: true, timeout: 20_000 });
  const roots = [].concat(JSON.parse(stdout || '[]'));
  assert.equal(roots.length, 1, `Expected exactly one top-level ${name} process, found ${roots.length}; use --pid`);
  return roots[0];
}

async function main() {
  const options = parse(process.argv.slice(2));
  const pid = options.pid ?? await rootByName(options.name);
  const result = {
    label: options.label, pid, startedAt: new Date().toISOString(),
    ...await measureTree(pid, {
      seconds: options.seconds, intervalSeconds: options.interval,
      sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    }),
  };
  const line = JSON.stringify(result);
  console.log(line);
  if (options.output) fs.appendFileSync(options.output, `${line}\n`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
